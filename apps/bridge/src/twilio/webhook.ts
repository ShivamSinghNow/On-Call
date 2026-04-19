/**
 * Twilio HTTP webhook handlers — voice answer, status callback, TTS-finished
 * redirect target.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import twilio from 'twilio';
import type { CallManager } from '../call/manager.js';
import type { Config } from '../config.js';

const voiceWebhookSchema = z.object({
  CallSid: z.string(),
  From: z.string().optional(),
  To: z.string().optional(),
});

const statusWebhookSchema = z.object({
  CallSid: z.string(),
  CallStatus: z.enum([
    'queued',
    'ringing',
    'in-progress',
    'completed',
    'busy',
    'failed',
    'no-answer',
    'canceled',
  ]),
});

const ttsFinishedQuerySchema = z.object({
  callSid: z.string(),
});

export function registerTwilioRoutes(
  app: FastifyInstance,
  callManager: CallManager,
  config: Config,
): void {
  const validateSignature = (
    url: string,
    params: Record<string, unknown>,
    signature: string | string[] | undefined,
  ): boolean => {
    if (!signature || Array.isArray(signature)) return false;
    return twilio.validateRequest(
      config.TWILIO_AUTH_TOKEN,
      signature,
      url,
      params as Record<string, string>,
    );
  };

  app.post('/twilio/voice', async (req, reply) => {
    const sig = req.headers['x-twilio-signature'];
    const fullUrl = `${config.PUBLIC_URL.replace(/\/$/, '')}/twilio/voice`;
    if (!validateSignature(fullUrl, req.body as Record<string, unknown>, sig)) {
      app.log.warn({ headers: req.headers }, 'twilio signature failed on /voice');
      return reply.code(403).send('forbidden');
    }

    const parsed = voiceWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send('bad request');
    }
    const { CallSid, From } = parsed.data;

    // Reject second concurrent call (V1 limit).
    if (callManager.hasActiveCall && !callManager.getCall(CallSid)) {
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${config.TWILIO_TTS_VOICE}">The voice agent is busy with another call. Please try again in a moment.</Say>
  <Hangup/>
</Response>`;
      return reply.type('text/xml').send(twiml);
    }

    callManager.startCall(CallSid, From);

    const wsUrl = toWebSocketUrl(config.PUBLIC_URL).replace(/\/$/, '');
    const streamUrl = `${wsUrl}/twilio/${encodeURIComponent(CallSid)}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
    return reply.type('text/xml').send(twiml);
  });

  app.post('/twilio/status', async (req, reply) => {
    const sig = req.headers['x-twilio-signature'];
    const fullUrl = `${config.PUBLIC_URL.replace(/\/$/, '')}/twilio/status`;
    if (!validateSignature(fullUrl, req.body as Record<string, unknown>, sig)) {
      return reply.code(403).send('forbidden');
    }
    const parsed = statusWebhookSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send('bad request');

    const { CallSid, CallStatus } = parsed.data;
    if (
      CallStatus === 'completed' ||
      CallStatus === 'busy' ||
      CallStatus === 'failed' ||
      CallStatus === 'no-answer' ||
      CallStatus === 'canceled'
    ) {
      callManager.endCall(CallSid, CallStatus === 'completed' ? 'hangup' : 'error');
    }
    return reply.send({ ok: true });
  });

  app.post('/twilio/tts-finished', async (req, reply) => {
    const sig = req.headers['x-twilio-signature'];
    const url = new URL(req.url, config.PUBLIC_URL);
    const fullUrl = url.toString();
    if (!validateSignature(fullUrl, req.body as Record<string, unknown>, sig)) {
      return reply.code(403).send('forbidden');
    }
    const parsed = ttsFinishedQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send('bad request');

    callManager.ttsFinished(parsed.data.callSid);

    // Re-open the media stream so the conversation continues.
    const wsUrl = toWebSocketUrl(config.PUBLIC_URL).replace(/\/$/, '');
    const streamUrl = `${wsUrl}/twilio/${encodeURIComponent(parsed.data.callSid)}`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;
    return reply.type('text/xml').send(twiml);
  });
}

function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  return httpUrl;
}

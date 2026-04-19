/**
 * Twilio Media Streams WebSocket handler.
 *
 * Twilio sends a sequence of JSON frames over the WebSocket:
 *   { event: 'connected', protocol, version }
 *   { event: 'start', start: { streamSid, callSid, ... } }
 *   { event: 'media', media: { payload: <base64 mulaw 8k> }, sequenceNumber }
 *   { event: 'mark', mark: { name } }
 *   { event: 'stop', stop: { ... } }
 *
 * We decode the mulaw payload, upsample 8k → 16k PCM, and feed it to the
 * call manager which runs VAD and forwards to the on-device voice agent.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mulawDecode, upsample8kTo16k } from '@on-call/shared';
import type { CallManager } from '../call/manager.js';

const mediaFrameSchema = z.object({
  event: z.literal('media'),
  media: z.object({
    payload: z.string(),
    track: z.string().optional(),
  }),
});

const startFrameSchema = z.object({
  event: z.literal('start'),
  start: z.object({
    streamSid: z.string(),
    callSid: z.string(),
  }),
});

const stopFrameSchema = z.object({
  event: z.literal('stop'),
});

export function registerTwilioMediaStream(
  app: FastifyInstance,
  callManager: CallManager,
): void {
  app.get('/twilio/:callSid', { websocket: true }, (socket, req) => {
    const { callSid } = req.params as { callSid: string };
    let resolvedCallSid = callSid;
    const log = app.log.child({ callSid, route: 'media-stream' });
    log.info('media stream open');

    socket.on('message', (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof json !== 'object' || json === null || !('event' in json)) return;
      const event = (json as { event: string }).event;

      if (event === 'start') {
        const parsed = startFrameSchema.safeParse(json);
        if (parsed.success) {
          resolvedCallSid = parsed.data.start.callSid;
          log.debug({ resolvedCallSid }, 'media stream start');
        }
        return;
      }

      if (event === 'media') {
        const parsed = mediaFrameSchema.safeParse(json);
        if (!parsed.success) return;
        const mulaw = Buffer.from(parsed.data.media.payload, 'base64');
        const pcm8k = mulawDecode(new Uint8Array(mulaw));
        const pcm16k = upsample8kTo16k(pcm8k);
        callManager.ingestPcm(resolvedCallSid, pcm16k);
        return;
      }

      if (event === 'stop') {
        const parsed = stopFrameSchema.safeParse(json);
        if (parsed.success) {
          log.info('media stream stop');
        }
        return;
      }
    });

    socket.on('close', () => {
      log.info('media stream closed');
    });

    socket.on('error', (err) => {
      log.warn({ err }, 'media stream error');
    });
  });
}

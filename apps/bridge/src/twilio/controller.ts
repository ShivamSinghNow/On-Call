/**
 * Thin wrapper over Twilio's REST API used by the call manager to:
 *   - Inject a TwiML <Say> mid-call by REST `update`.
 *   - Hang up a call by REST `update` with status='completed'.
 *
 * Twilio Media Streams is bidirectional but we deliberately do *not* stream
 * outbound audio in V1 (per plan.md §2.1 we use option 2: redirect-then-Say).
 * Mid-call updates POST a fresh TwiML payload that Twilio executes — we follow
 * the <Say> with another <Connect><Stream> back to the same WebSocket so the
 * conversation continues.
 */

import twilio, { type Twilio } from 'twilio';
import type { Logger } from '../logger.js';

export interface TwilioControllerOptions {
  accountSid: string;
  authToken: string;
  publicUrl: string;
  ttsVoice: string;
  logger: Logger;
}

export class TwilioCallController {
  private readonly client: Twilio;
  private readonly publicUrl: string;
  private readonly ttsVoice: string;
  private readonly logger: Logger;

  constructor(opts: TwilioControllerOptions) {
    this.client = twilio(opts.accountSid, opts.authToken);
    this.publicUrl = opts.publicUrl.replace(/\/$/, '');
    this.ttsVoice = opts.ttsVoice;
    this.logger = opts.logger.child({ component: 'twilio-controller' });
  }

  /** Inject a Polly TTS spoken phrase into an active call, then resume streaming. */
  async speak(callSid: string, text: string): Promise<void> {
    const escaped = escapeXml(text);
    const ttsCallback = `${this.publicUrl}/twilio/tts-finished?callSid=${encodeURIComponent(callSid)}`;
    const streamUrl = `${toWebSocketUrl(this.publicUrl)}/twilio/${encodeURIComponent(callSid)}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${this.ttsVoice}">${escaped}</Say>
  <Redirect method="POST">${ttsCallback}</Redirect>
  <!-- Fallback: in case the redirect fails, re-open the stream directly. -->
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

    try {
      await this.client.calls(callSid).update({ twiml });
      this.logger.debug({ callSid, preview: text.slice(0, 60) }, 'speak injected');
    } catch (err) {
      this.logger.error({ err, callSid }, 'failed to inject speak');
      throw err;
    }
  }

  /** End a call. */
  async hangup(callSid: string): Promise<void> {
    try {
      await this.client.calls(callSid).update({ status: 'completed' });
      this.logger.info({ callSid }, 'hangup');
    } catch (err) {
      this.logger.warn({ err, callSid }, 'hangup failed (may already be ended)');
    }
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toWebSocketUrl(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return 'wss://' + httpUrl.slice('https://'.length);
  if (httpUrl.startsWith('http://')) return 'ws://' + httpUrl.slice('http://'.length);
  return httpUrl;
}

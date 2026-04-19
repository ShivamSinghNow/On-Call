/**
 * Glues the per-call state machine to the outside world:
 *   - Inbound mulaw audio from Twilio Media Streams
 *   - VAD events
 *   - Bridge → Agent WebSocket frames
 *   - Telegram (Claude Code) sends and replies
 *   - Twilio REST calls to interrupt with TTS or hang up
 *
 * One `Call` per active phone call. The `CallManager` owns the registry.
 */

import type { Logger } from '../logger.js';
import { EnergyVad, int16ToArray, type VadEvent } from '@on-call/shared';
import { CallStateMachine, type CallEffect, type CallState } from './state.js';
import type { AgentConnection } from '../agent/connection.js';
import type { ClaudeCodeClient } from '../telegram/client.js';
import type { TwilioCallController } from '../twilio/controller.js';

export interface CallManagerOptions {
  agent: AgentConnection;
  claudeCode: ClaudeCodeClient;
  twilio: TwilioCallController;
  logger: Logger;
  greeting: string;
}

export class Call {
  readonly callSid: string;
  readonly machine: CallStateMachine;
  readonly vad: EnergyVad;
  readonly logger: Logger;
  /** Outstanding Claude Code timeout, if any. */
  private claudeTimeout: NodeJS.Timeout | null = null;

  constructor(callSid: string, greeting: string, parentLogger: Logger) {
    this.callSid = callSid;
    this.machine = new CallStateMachine({ callSid, greeting });
    this.vad = new EnergyVad();
    this.logger = parentLogger.child({ callSid });
  }

  armClaudeTimeout(ms: number, onTimeout: () => void): void {
    this.clearClaudeTimeout();
    this.claudeTimeout = setTimeout(() => {
      this.claudeTimeout = null;
      onTimeout();
    }, ms);
  }

  clearClaudeTimeout(): void {
    if (this.claudeTimeout) {
      clearTimeout(this.claudeTimeout);
      this.claudeTimeout = null;
    }
  }
}

export class CallManager {
  private readonly calls = new Map<string, Call>();
  private readonly opts: CallManagerOptions;
  private unsubscribeAgent: (() => void) | null = null;
  private unsubscribeAgentDisconnect: (() => void) | null = null;
  private unsubscribeClaude: (() => void) | null = null;

  constructor(opts: CallManagerOptions) {
    this.opts = opts;
  }

  start(): void {
    this.unsubscribeAgent = this.opts.agent.onMessage((msg) => {
      switch (msg.type) {
        case 'agent_decision': {
          const call = this.calls.get(msg.callSid);
          if (!call) return;
          this.dispatch(
            call,
            call.machine.handle({
              type: 'AGENT_DECISION',
              action: msg.action,
              text: msg.text,
            }),
          );
          break;
        }
        case 'agent_progress':
          // TODO: optionally surface partial text to logs / future "thinking..." TTS.
          break;
        case 'error':
          this.opts.logger.warn({ err: msg.message, callSid: msg.callSid }, 'agent error');
          if (msg.callSid) {
            const call = this.calls.get(msg.callSid);
            if (call) this.endCall(call.callSid, 'error');
          }
          break;
        default:
          break;
      }
    });

    this.unsubscribeAgentDisconnect = this.opts.agent.onDisconnect(() => {
      for (const call of this.calls.values()) {
        this.dispatch(call, call.machine.handle({ type: 'AGENT_DISCONNECTED' }));
      }
    });

    this.unsubscribeClaude = this.opts.claudeCode.onReply((tagSid, text) => {
      const call = this.routeReply(tagSid);
      if (!call) {
        this.opts.logger.warn({ tagSid }, 'claude reply with no matching call');
        return;
      }
      call.clearClaudeTimeout();
      this.dispatch(call, call.machine.handle({ type: 'CLAUDE_REPLY', text }));
    });
  }

  stop(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgentDisconnect?.();
    this.unsubscribeClaude?.();
    for (const call of this.calls.values()) call.clearClaudeTimeout();
    this.calls.clear();
  }

  /** Called when Twilio hits the voice webhook and we accept the call. */
  startCall(callSid: string, from: string | undefined): Call {
    if (this.calls.has(callSid)) {
      return this.calls.get(callSid)!;
    }
    if (this.calls.size > 0) {
      // V1: serialize calls. Reject the second one upstream before getting here.
      this.opts.logger.warn(
        { callSid, active: [...this.calls.keys()] },
        'second concurrent call accepted — agent will serialize',
      );
    }
    const call = new Call(callSid, this.opts.greeting, this.opts.logger);
    this.calls.set(callSid, call);
    this.dispatch(call, call.machine.handle({ type: 'CALL_ANSWERED', from }));
    return call;
  }

  /** Called from the Twilio Media Stream handler with decoded 16k PCM. */
  ingestPcm(callSid: string, pcm: Int16Array): void {
    const call = this.calls.get(callSid);
    if (!call) return;
    this.dispatch(call, call.machine.handle({ type: 'AUDIO_CHUNK', pcm }));
    const vadEvents = call.vad.process(pcm);
    for (const event of vadEvents) this.applyVadEvent(call, event);
  }

  /** Called when Twilio reports playback of an injected TwiML <Say> finished. */
  ttsFinished(callSid: string): void {
    const call = this.calls.get(callSid);
    if (!call) return;
    this.dispatch(call, call.machine.handle({ type: 'TTS_FINISHED' }));
  }

  /** Called when Twilio status callback says the call ended. */
  endCall(callSid: string, _reason: 'hangup' | 'error' | 'agent_abort'): void {
    const call = this.calls.get(callSid);
    if (!call) return;
    this.dispatch(call, call.machine.handle({ type: 'HANGUP' }));
    call.clearClaudeTimeout();
    this.calls.delete(callSid);
  }

  /** True if there's already an active call (used to reject concurrent calls). */
  get hasActiveCall(): boolean {
    return this.calls.size > 0;
  }

  /** Inspect a call (used by tests and DTMF "0 to repeat" handler). */
  getCall(callSid: string): Call | undefined {
    return this.calls.get(callSid);
  }

  /** Snapshot for /healthz. */
  snapshot(): { active: number; states: Record<string, CallState> } {
    const states: Record<string, CallState> = {};
    for (const [sid, call] of this.calls) {
      states[sid] = call.machine.currentState;
    }
    return { active: this.calls.size, states };
  }

  // -------------------------------------------------------------------------

  private routeReply(tagSid: string | null): Call | null {
    if (tagSid && this.calls.has(tagSid)) return this.calls.get(tagSid)!;
    // Fallback: route to the single call awaiting Claude.
    const awaiting = [...this.calls.values()].filter(
      (c) => c.machine.currentState === 'AWAITING_CLAUDE',
    );
    if (awaiting.length === 1) return awaiting[0]!;
    return null;
  }

  private applyVadEvent(call: Call, event: VadEvent): void {
    switch (event.type) {
      case 'speech_start':
        this.dispatch(call, call.machine.handle({ type: 'SPEECH_START' }));
        break;
      case 'speech_end':
        this.dispatch(
          call,
          call.machine.handle({ type: 'SPEECH_END', durationMs: event.durationMs }),
        );
        break;
      case 'force_flush':
        this.dispatch(
          call,
          call.machine.handle({
            type: 'SPEECH_END',
            durationMs: this.opts.twilio ? 30_000 : 30_000,
          }),
        );
        break;
    }
  }

  private dispatch(call: Call, effects: CallEffect[]): void {
    for (const effect of effects) {
      this.runEffect(call, effect).catch((err) =>
        call.logger.error({ err, effect: effect.type }, 'effect failed'),
      );
    }
  }

  private async runEffect(call: Call, effect: CallEffect): Promise<void> {
    switch (effect.type) {
      case 'send_call_start_to_agent':
        this.opts.agent.send({
          type: 'call_start',
          callSid: call.callSid,
          startedAt: new Date().toISOString(),
          ...(effect.from !== undefined ? { from: effect.from } : {}),
        });
        break;

      case 'send_audio_to_agent':
        this.opts.agent.send({
          type: 'audio',
          callSid: call.callSid,
          pcm: int16ToArray(effect.pcm),
          seq: nextSeq(call),
        });
        break;

      case 'send_utterance_end_to_agent':
        this.opts.agent.send({
          type: 'utterance_end',
          callSid: call.callSid,
          durationMs: effect.durationMs,
        });
        break;

      case 'send_call_end_to_agent':
        this.opts.agent.send({
          type: 'call_end',
          callSid: call.callSid,
          reason: effect.reason,
        });
        break;

      case 'speak_text':
        await this.opts.twilio.speak(call.callSid, effect.text);
        break;

      case 'forward_to_claude_code': {
        try {
          await this.opts.claudeCode.forward(call.callSid, effect.prompt);
          call.armClaudeTimeout(this.opts.claudeCode.replyTimeoutMs, () => {
            this.dispatch(call, call.machine.handle({ type: 'CLAUDE_TIMEOUT' }));
          });
        } catch (err) {
          call.logger.error({ err }, 'failed to forward to claude code');
          this.dispatch(
            call,
            call.machine.handle({
              type: 'CLAUDE_ERROR',
              message: 'unable to reach Claude Code',
            }),
          );
        }
        break;
      }

      case 'end_call':
        await this.opts.twilio.hangup(call.callSid);
        break;

      case 'log_warn':
        call.logger.warn(effect.message);
        break;
    }
  }
}

const seqCounters = new WeakMap<Call, { seq: number }>();
function nextSeq(call: Call): number {
  let counter = seqCounters.get(call);
  if (!counter) {
    counter = { seq: 0 };
    seqCounters.set(call, counter);
  }
  return counter.seq++;
}

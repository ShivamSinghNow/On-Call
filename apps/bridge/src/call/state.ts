/**
 * Per-call state machine. One instance per active Twilio call.
 *
 * States (per plan.md §2.1):
 *   IDLE → LISTENING → BUFFERING_UTTERANCE → SENT_TO_AGENT
 *        → SPEAKING (followup) → LISTENING
 *        → AWAITING_CLAUDE → SPEAKING → LISTENING
 *        → CLEANUP
 *
 * The state machine is intentionally pure: it accepts events, mutates internal
 * state, and returns a list of side effects for the call manager to perform.
 * This makes it easy to unit test without spinning up real WebSocket / Twilio
 * / Telegram clients.
 */

export type CallState =
  | 'IDLE'
  | 'LISTENING'
  | 'BUFFERING_UTTERANCE'
  | 'SENT_TO_AGENT'
  | 'AWAITING_CLAUDE'
  | 'SPEAKING'
  | 'CLEANUP';

export type CallEvent =
  | { type: 'CALL_ANSWERED'; from?: string }
  | { type: 'AUDIO_CHUNK'; pcm: Int16Array }
  | { type: 'SPEECH_START' }
  | { type: 'SPEECH_END'; durationMs: number }
  | {
      type: 'AGENT_DECISION';
      action: 'ask_followup' | 'forward_to_claude_code' | 'abort';
      text: string;
    }
  | { type: 'CLAUDE_REPLY'; text: string }
  | { type: 'CLAUDE_TIMEOUT' }
  | { type: 'CLAUDE_ERROR'; message: string }
  | { type: 'TTS_FINISHED' }
  | { type: 'AGENT_DISCONNECTED' }
  | { type: 'HANGUP' };

export type CallEffect =
  | { type: 'send_call_start_to_agent'; from?: string }
  | { type: 'send_audio_to_agent'; pcm: Int16Array }
  | { type: 'send_utterance_end_to_agent'; durationMs: number }
  | { type: 'send_call_end_to_agent'; reason: 'hangup' | 'error' | 'timeout' | 'agent_abort' }
  | { type: 'speak_text'; text: string }
  | { type: 'forward_to_claude_code'; prompt: string }
  | { type: 'end_call'; reason: 'hangup' | 'error' | 'agent_abort' }
  | { type: 'log_warn'; message: string };

export interface CallStateOptions {
  callSid: string;
  /** Greeting phrase spoken to the caller right after answer. */
  greeting: string;
}

export class CallStateMachine {
  readonly callSid: string;
  private state: CallState = 'IDLE';
  private bufferedSpeechMs = 0;
  private lastSpokenText = '';
  private readonly greeting: string;

  constructor(opts: CallStateOptions) {
    this.callSid = opts.callSid;
    this.greeting = opts.greeting;
  }

  get currentState(): CallState {
    return this.state;
  }

  /** Last thing we spoke to the caller — used to support DTMF "0" repeat. */
  get lastSpoken(): string {
    return this.lastSpokenText;
  }

  /** Apply an event, return the side effects the manager should run. */
  handle(event: CallEvent): CallEffect[] {
    switch (event.type) {
      case 'CALL_ANSWERED':
        return this.onCallAnswered(event.from);
      case 'AUDIO_CHUNK':
        return this.onAudioChunk(event.pcm);
      case 'SPEECH_START':
        return this.onSpeechStart();
      case 'SPEECH_END':
        return this.onSpeechEnd(event.durationMs);
      case 'AGENT_DECISION':
        return this.onAgentDecision(event.action, event.text);
      case 'CLAUDE_REPLY':
        return this.onClaudeReply(event.text);
      case 'CLAUDE_TIMEOUT':
        return this.onClaudeTimeout();
      case 'CLAUDE_ERROR':
        return this.onClaudeError(event.message);
      case 'TTS_FINISHED':
        return this.onTtsFinished();
      case 'AGENT_DISCONNECTED':
        return this.onAgentDisconnected();
      case 'HANGUP':
        return this.onHangup();
    }
  }

  // -------------------------------------------------------------------------

  private onCallAnswered(from: string | undefined): CallEffect[] {
    if (this.state !== 'IDLE') {
      return [{ type: 'log_warn', message: `CALL_ANSWERED in unexpected state ${this.state}` }];
    }
    this.state = 'SPEAKING';
    this.lastSpokenText = this.greeting;
    return [
      { type: 'send_call_start_to_agent', from },
      { type: 'speak_text', text: this.greeting },
    ];
  }

  private onAudioChunk(pcm: Int16Array): CallEffect[] {
    // We forward audio whenever the caller is allowed to speak: LISTENING and
    // BUFFERING_UTTERANCE. We drop audio during SPEAKING to avoid feedback,
    // and during SENT_TO_AGENT / AWAITING_CLAUDE while the system is "thinking".
    // (Barge-in is a Phase 3 concern — see plan.md.)
    if (this.state !== 'LISTENING' && this.state !== 'BUFFERING_UTTERANCE') {
      return [];
    }
    return [{ type: 'send_audio_to_agent', pcm }];
  }

  private onSpeechStart(): CallEffect[] {
    if (this.state === 'LISTENING') {
      this.state = 'BUFFERING_UTTERANCE';
      this.bufferedSpeechMs = 0;
    }
    return [];
  }

  private onSpeechEnd(durationMs: number): CallEffect[] {
    if (this.state !== 'BUFFERING_UTTERANCE') return [];
    this.bufferedSpeechMs = durationMs;
    this.state = 'SENT_TO_AGENT';
    return [{ type: 'send_utterance_end_to_agent', durationMs }];
  }

  private onAgentDecision(
    action: 'ask_followup' | 'forward_to_claude_code' | 'abort',
    text: string
  ): CallEffect[] {
    if (this.state !== 'SENT_TO_AGENT') {
      return [
        {
          type: 'log_warn',
          message: `AGENT_DECISION in state ${this.state} (call=${this.callSid})`,
        },
      ];
    }

    switch (action) {
      case 'ask_followup':
        this.state = 'SPEAKING';
        this.lastSpokenText = text;
        return [{ type: 'speak_text', text }];
      case 'forward_to_claude_code':
        this.state = 'AWAITING_CLAUDE';
        return [{ type: 'forward_to_claude_code', prompt: text }];
      case 'abort':
        this.state = 'CLEANUP';
        this.lastSpokenText = text;
        return [
          { type: 'speak_text', text },
          { type: 'end_call', reason: 'agent_abort' },
          { type: 'send_call_end_to_agent', reason: 'agent_abort' },
        ];
    }
  }

  private onClaudeReply(text: string): CallEffect[] {
    if (this.state !== 'AWAITING_CLAUDE') {
      return [
        {
          type: 'log_warn',
          message: `CLAUDE_REPLY in state ${this.state} (call=${this.callSid})`,
        },
      ];
    }
    this.state = 'SPEAKING';
    this.lastSpokenText = text;
    return [{ type: 'speak_text', text }];
  }

  private onClaudeTimeout(): CallEffect[] {
    if (this.state !== 'AWAITING_CLAUDE') return [];
    // Stay in AWAITING_CLAUDE — just nudge the caller.
    const filler = 'Still working on that, one moment.';
    this.lastSpokenText = filler;
    return [{ type: 'speak_text', text: filler }];
  }

  private onClaudeError(message: string): CallEffect[] {
    if (this.state !== 'AWAITING_CLAUDE') return [];
    const apology = `Claude returned an error: ${message}. Try rephrasing.`;
    this.state = 'SPEAKING';
    this.lastSpokenText = apology;
    return [{ type: 'speak_text', text: apology }];
  }

  private onTtsFinished(): CallEffect[] {
    if (this.state !== 'SPEAKING') return [];
    this.state = 'LISTENING';
    return [];
  }

  private onAgentDisconnected(): CallEffect[] {
    if (this.state === 'CLEANUP') return [];
    this.state = 'CLEANUP';
    const apology = 'The voice agent disconnected. Goodbye.';
    this.lastSpokenText = apology;
    return [
      { type: 'speak_text', text: apology },
      { type: 'end_call', reason: 'error' },
    ];
  }

  private onHangup(): CallEffect[] {
    if (this.state === 'CLEANUP') return [];
    this.state = 'CLEANUP';
    return [
      { type: 'send_call_end_to_agent', reason: 'hangup' },
      { type: 'end_call', reason: 'hangup' },
    ];
  }
}

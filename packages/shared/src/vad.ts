/**
 * Energy-based voice activity detector.
 *
 * Used by the bridge to decide when an inbound utterance from the caller has
 * ended, so it can flush buffered PCM to the on-device voice agent for
 * processing.
 *
 * This is a deliberately simple implementation:
 *   - Compute RMS of each ~20 ms frame.
 *   - Treat frames above `voiceThreshold` as speech.
 *   - Treat the utterance as ended after `silenceMs` of consecutive
 *     non-speech frames following at least `minSpeechMs` of speech.
 *
 * The plan calls out Silero VAD as a Phase 3 upgrade — see plan.md §2.1.
 */

export interface EnergyVadOptions {
  /**
   * RMS threshold above which a frame is considered speech.
   * For 16-bit PCM, sensible values land in [200, 1500] depending on call quality.
   * Default tuned for clean cellular audio.
   */
  voiceThreshold: number;
  /** Frame size in samples. At 16 kHz, 320 samples = 20 ms. */
  frameSamples: number;
  /** Sample rate of the input. */
  sampleRate: number;
  /** Minimum cumulative speech duration before an utterance can be ended. */
  minSpeechMs: number;
  /** Trailing silence required to declare end-of-utterance. */
  silenceMs: number;
  /** Hard cap on utterance length. Ends the utterance even if speech continues. */
  maxUtteranceMs: number;
}

export const DEFAULT_VAD_OPTIONS: EnergyVadOptions = {
  voiceThreshold: 600,
  frameSamples: 320,
  sampleRate: 16_000,
  minSpeechMs: 250,
  silenceMs: 700,
  maxUtteranceMs: 30_000,
};

export type VadEvent =
  | { type: 'speech_start'; atMs: number }
  | { type: 'speech_end'; atMs: number; durationMs: number }
  | { type: 'force_flush'; atMs: number; reason: 'max_duration' };

/**
 * Streaming VAD. Feed PCM frames in via `process()`; receive
 * speech-start / speech-end events back.
 */
export class EnergyVad {
  private readonly opts: EnergyVadOptions;
  private buffer: number[] = [];
  private inSpeech = false;
  private speechStartedAtMs: number | null = null;
  private lastSpeechAtMs: number | null = null;
  private cursorMs = 0;

  constructor(options: Partial<EnergyVadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  /**
   * Feed a chunk of PCM. Returns any VAD events this chunk produced.
   * Chunks of arbitrary length are fine — they're internally re-framed.
   */
  process(pcm: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    const frameMs = (this.opts.frameSamples / this.opts.sampleRate) * 1000;

    for (let i = 0; i < pcm.length; i++) this.buffer.push(pcm[i]!);

    while (this.buffer.length >= this.opts.frameSamples) {
      const frame = this.buffer.splice(0, this.opts.frameSamples);
      const rms = computeRms(frame);
      const isSpeech = rms >= this.opts.voiceThreshold;
      this.cursorMs += frameMs;

      if (isSpeech) {
        if (!this.inSpeech) {
          this.inSpeech = true;
          this.speechStartedAtMs = this.cursorMs;
          events.push({ type: 'speech_start', atMs: this.cursorMs });
        }
        this.lastSpeechAtMs = this.cursorMs;
      } else if (this.inSpeech && this.lastSpeechAtMs !== null && this.speechStartedAtMs !== null) {
        const silenceFor = this.cursorMs - this.lastSpeechAtMs;
        const speechDuration = this.lastSpeechAtMs - this.speechStartedAtMs;

        if (silenceFor >= this.opts.silenceMs && speechDuration >= this.opts.minSpeechMs) {
          events.push({
            type: 'speech_end',
            atMs: this.cursorMs,
            durationMs: this.cursorMs - this.speechStartedAtMs,
          });
          this.resetSpeechState();
        }
      }

      // Hard cap on utterance length.
      if (this.inSpeech && this.speechStartedAtMs !== null) {
        const elapsed = this.cursorMs - this.speechStartedAtMs;
        if (elapsed >= this.opts.maxUtteranceMs) {
          events.push({ type: 'force_flush', atMs: this.cursorMs, reason: 'max_duration' });
          this.resetSpeechState();
        }
      }
    }

    return events;
  }

  /** Reset all internal state. Call between calls. */
  reset(): void {
    this.buffer = [];
    this.cursorMs = 0;
    this.resetSpeechState();
  }

  /** True if the VAD currently believes the user is speaking. */
  get isSpeaking(): boolean {
    return this.inSpeech;
  }

  private resetSpeechState(): void {
    this.inSpeech = false;
    this.speechStartedAtMs = null;
    this.lastSpeechAtMs = null;
  }
}

function computeRms(samples: number[]): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

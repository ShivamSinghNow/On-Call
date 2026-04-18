import * as Speech from "expo-speech";

export interface TtsEngine {
  /**
   * Feed a chunk of text as it streams in. The engine buffers until it has
   * a natural break (sentence terminator or long phrase), then speaks. Call
   * `flush()` at the end of the stream to speak any trailing buffer.
   */
  speak(chunk: string): Promise<void>;

  /** Flush any buffered text immediately, regardless of sentence boundary. */
  flush(): Promise<void>;

  /** Stop any active or queued speech. */
  stop(): Promise<void>;
}

const SENTENCE_BOUNDARY = /([.!?]+["')\]]?\s+|\n+)/;
const MAX_BUFFER_CHARS = 160;

class ExpoTtsEngine implements TtsEngine {
  private buffer = "";
  private queue: string[] = [];
  private isSpeaking = false;

  async speak(chunk: string): Promise<void> {
    this.buffer += chunk;
    this.drainBuffer();
    await this.ensureSpeaking();
  }

  async flush(): Promise<void> {
    if (this.buffer.trim().length > 0) {
      this.queue.push(this.buffer.trim());
      this.buffer = "";
    }
    await this.ensureSpeaking();
  }

  async stop(): Promise<void> {
    this.buffer = "";
    this.queue = [];
    this.isSpeaking = false;
    await Speech.stop();
  }

  private drainBuffer(): void {
    while (true) {
      const match = SENTENCE_BOUNDARY.exec(this.buffer);
      if (match && match.index !== undefined) {
        const end = match.index + match[0].length;
        const sentence = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end);
        if (sentence.length > 0) this.queue.push(sentence);
        continue;
      }
      if (this.buffer.length >= MAX_BUFFER_CHARS) {
        const cut = this.lastWordBoundary(this.buffer, MAX_BUFFER_CHARS);
        const phrase = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut);
        if (phrase.length > 0) this.queue.push(phrase);
        continue;
      }
      return;
    }
  }

  private lastWordBoundary(s: string, limit: number): number {
    for (let i = Math.min(limit, s.length) - 1; i > limit * 0.5; i--) {
      if (/\s/.test(s[i]!)) return i + 1;
    }
    return limit;
  }

  private async ensureSpeaking(): Promise<void> {
    if (this.isSpeaking) return;
    const next = this.queue.shift();
    if (!next) return;
    this.isSpeaking = true;
    await new Promise<void>((resolve) => {
      Speech.speak(next, {
        rate: 1.0,
        onDone: () => {
          this.isSpeaking = false;
          resolve();
          void this.ensureSpeaking();
        },
        onStopped: () => {
          this.isSpeaking = false;
          resolve();
        },
        onError: () => {
          this.isSpeaking = false;
          resolve();
          void this.ensureSpeaking();
        },
      });
    });
  }
}

export const tts: TtsEngine = new ExpoTtsEngine();

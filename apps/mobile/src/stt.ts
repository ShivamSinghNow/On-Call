import { CactusSTT } from "cactus-react-native";

export interface SttEngine {
  init(onProgress?: (ratio: number) => void): Promise<void>;
  transcribe(fileUri: string): Promise<string>;
  transcribePcm(pcm: number[]): Promise<string>;
}

/**
 * The default model. Moonshine-Base is the lightest on-device option
 * supported by cactus-react-native (see plan "STT model choice" fork).
 * Swap to "whisper-small" for higher accuracy at ~2-3x size.
 */
const MODEL = "moonshine-base";
const QUANT: "int4" | "int8" = "int8";

class CactusSttEngine implements SttEngine {
  private engine: CactusSTT | null = null;
  private readyPromise: Promise<void> | null = null;

  async init(onProgress?: (ratio: number) => void): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      const engine = new CactusSTT({
        model: MODEL,
        options: { quantization: QUANT, pro: false },
      });

      await engine.download({
        onProgress: (ratio) => onProgress?.(ratio),
      });
      await engine.init();

      this.engine = engine;
    })().catch((err) => {
      this.readyPromise = null;
      throw err;
    });

    return this.readyPromise;
  }

  async transcribePcm(pcm: number[]): Promise<string> {
    if (!this.engine) {
      throw new Error("STT not initialized. Call init() first.");
    }
    const result = await this.engine.transcribe({
      audio: pcm,
      options: { maxTokens: 256, useVad: false },
    });
    if (!result.success) throw new Error("Transcription failed");
    return result.response;
  }

  async transcribe(fileUri: string): Promise<string> {
    if (!this.engine) {
      throw new Error("STT not initialized. Call init() first.");
    }

    const audio = fileUri.startsWith("file://")
      ? fileUri.slice("file://".length)
      : fileUri;

    const result = await this.engine.transcribe({
      audio,
      options: {
        maxTokens: 256,
        useVad: true,
      },
    });

    if (!result.success) {
      throw new Error("Transcription failed");
    }
    return result.response;
  }
}

export const stt: SttEngine = new CactusSttEngine();

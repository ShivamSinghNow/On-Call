/**
 * On-device voice agent built on Cactus + Gemma 4.
 *
 * Per the Gemma 4 / Cactus integration announcement
 * (https://docs.cactuscompute.com/latest/blog/gemma4/), Gemma 4 is a
 * multimodal model — it reasons over raw audio directly without an explicit
 * STT hop. Cactus exposes multimodal inputs via file paths on disk
 * (`multimodalCompletion(contextId, prompt, mediaPaths, params)` — see
 * `cactus-react-native/src/index.ts`). So for each inbound utterance we:
 *
 *   1. Write the buffered 16kHz int16 PCM to a temporary WAV file.
 *   2. Invoke `CactusVLM.completion(..., { images: [wavPath] })`, treating
 *      Cactus's `images` field as the generic "media path" channel. When a
 *      dedicated audio field lands in the public types, swap one line.
 *   3. Parse the model's reply as JSON (we prompt it to emit
 *      `{action, text, confidence}`).
 *
 * The model runs ask_followup up to 2 times per call, then is instructed to
 * forward whatever context it has to Claude Code.
 */

import { CactusVLM, type CactusOAICompatibleMessage } from 'cactus-react-native';
import { writePcmAsWav, cleanupWavFile, DEFAULT_PCM_SAMPLE_RATE } from './audio-file';

const SYSTEM_PROMPT = `You are a low-latency voice screener for a senior software engineer's hands-free coding assistant.

Your job is NOT to answer technical questions. Your job is to:
  1. Listen to what the developer said.
  2. Decide if you have enough context to forward a clean, well-formed prompt to Claude Code.
  3. If yes, reply with action="forward_to_claude_code" and text=the cleaned prompt.
  4. If you need ONE clarifying piece of info (language, framework, error message, file path, etc.), reply with action="ask_followup" and text=a single short question.
  5. If the user said something off-topic or impossible to act on, reply with action="abort" and text=a brief explanation.

Rules:
  - Ask AT MOST 2 follow-up questions per call. If you've already asked 2, forward whatever you have.
  - When forwarding, preserve the developer's exact technical wording. Do NOT paraphrase.
  - Strip filler ("um", "like", "you know"), false starts, and self-corrections.
  - Keep follow-up questions to one sentence.
  - You MUST respond with a single JSON object, no prose, no code fences:
    {"action": "ask_followup" | "forward_to_claude_code" | "abort", "text": "...", "confidence": 0.0..1.0}`;

const DECISION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['ask_followup', 'forward_to_claude_code', 'abort'],
    },
    text: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['action', 'text', 'confidence'],
  additionalProperties: false,
} as const;

export interface AgentDecision {
  action: 'ask_followup' | 'forward_to_claude_code' | 'abort';
  text: string;
  confidence: number;
  latencyMs: number;
}

export interface VoiceAgentOptions {
  /** Absolute path (or https:// url that Cactus will download) to the Gemma 4 GGUF weights. */
  modelPath: string;
  /** Absolute path (or https:// url) to the multimodal projector file (mmproj). */
  mmprojPath: string;
  /** Context window size. Gemma 4 E2B supports 128k but we only need conversation-scale. */
  contextSize?: number;
  /** GPU layers to offload. -1 = auto, 0 = CPU only. */
  nGpuLayers?: number;
}

export class VoiceAgent {
  private readonly opts: VoiceAgentOptions;
  private vlm: CactusVLM | null = null;
  private readonly history: CactusOAICompatibleMessage[] = [];
  private followupCount = 0;
  private modelDescription = 'uninitialized';

  constructor(opts: VoiceAgentOptions) {
    this.opts = opts;
    this.history.push({ role: 'system', content: SYSTEM_PROMPT });
  }

  /** Ensure the model weights are present locally and the runtime is initialized. */
  async ensureReady(onProgress?: (p: number) => void): Promise<void> {
    const { vlm, error } = await CactusVLM.init(
      {
        model: this.opts.modelPath,
        mmproj: this.opts.mmprojPath,
        n_ctx: this.opts.contextSize ?? 4096,
        ...(this.opts.nGpuLayers !== undefined
          ? { n_gpu_layers: this.opts.nGpuLayers }
          : {}),
      },
      onProgress,
    );
    if (error || !vlm) {
      throw error ?? new Error('CactusVLM.init returned neither vlm nor error');
    }
    this.vlm = vlm;
    this.modelDescription = deriveModelName(this.opts.modelPath);
  }

  get modelName(): string {
    return this.modelDescription;
  }

  /** Process a single completed utterance. Returns the structured decision. */
  async processUtterance(
    pcm16k: number[],
    onToken?: (token: string) => void,
  ): Promise<AgentDecision> {
    const vlm = this.vlm;
    if (!vlm) throw new Error('VoiceAgent.processUtterance called before ensureReady');
    const start = Date.now();

    const wavPath = await writePcmAsWav(pcm16k, DEFAULT_PCM_SAMPLE_RATE);
    try {
      const userMessage: CactusOAICompatibleMessage = {
        role: 'user',
        content: 'The developer just said the attached audio clip.',
      };
      this.history.push(userMessage);

      const result = await vlm.completion(
        this.history,
        {
          // Cactus's `images` field accepts any media path the underlying
          // multimodal projector supports; for Gemma 4 + Cactus this includes
          // audio files per the day-one integration blog post. If a future
          // Cactus release splits this into a dedicated `audios` field,
          // change this single line.
          images: [wavPath],
          temperature: 0.2,
          n_predict: 256,
          response_format: {
            type: 'json_schema',
            json_schema: { strict: true, schema: DECISION_JSON_SCHEMA },
          },
        },
        onToken ? (data) => onToken(data?.token ?? '') : undefined,
      );

      const raw = result.content ?? result.text ?? '';
      const decision = parseDecision(raw);

      this.history.push({ role: 'assistant', content: raw });

      if (decision.action === 'ask_followup') {
        this.followupCount += 1;
        if (this.followupCount >= 2) {
          this.history.push({
            role: 'system',
            content:
              'You have asked your maximum number of follow-ups. On the next user turn you MUST forward whatever you have to Claude Code.',
          });
        }
      }

      return { ...decision, latencyMs: Date.now() - start };
    } finally {
      await cleanupWavFile(wavPath);
    }
  }

  /** Reset between calls. */
  async reset(): Promise<void> {
    this.history.length = 0;
    this.history.push({ role: 'system', content: SYSTEM_PROMPT });
    this.followupCount = 0;
    if (this.vlm) {
      try {
        await this.vlm.rewind();
      } catch {
        // rewind is best-effort; if it fails the next completion will just reset
      }
    }
  }

  /** Free all resources. */
  async destroy(): Promise<void> {
    if (this.vlm) {
      try {
        await this.vlm.release();
      } catch {
        // best-effort
      }
      this.vlm = null;
    }
  }
}

function parseDecision(raw: string): Omit<AgentDecision, 'latencyMs'> {
  const trimmed = raw.trim();
  try {
    const stripped = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const action = String(parsed.action ?? '');
    const text = String(parsed.text ?? '');
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    if (
      action === 'ask_followup' ||
      action === 'forward_to_claude_code' ||
      action === 'abort'
    ) {
      return { action, text, confidence };
    }
  } catch {
    // fall through
  }
  return {
    action: 'ask_followup',
    text: 'Sorry, I missed that — could you repeat?',
    confidence: 0.1,
  };
}

function deriveModelName(modelPath: string): string {
  const last = modelPath.split(/[/\\]/).pop() ?? modelPath;
  return last.replace(/\.gguf$/i, '');
}

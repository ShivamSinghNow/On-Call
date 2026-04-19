/**
 * WebSocket protocol between the bridge server and the React Native voice-agent app.
 *
 * Direction conventions:
 *   - `BridgeToAgentMessage` flows server → app
 *   - `AgentToBridgeMessage` flows app → server
 *
 * Both sides exchange JSON-encoded text frames. Audio is shipped as plain
 * `number[]` arrays of 16-bit signed PCM samples at 16 kHz mono.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bridge → Agent
// ---------------------------------------------------------------------------

export const callStartSchema = z.object({
  type: z.literal('call_start'),
  callSid: z.string(),
  /** ISO-8601 timestamp the call was answered. */
  startedAt: z.string(),
  /** Optional caller phone number (E.164), if Twilio reported it. */
  from: z.string().optional(),
});
export type CallStartMessage = z.infer<typeof callStartSchema>;

export const audioChunkSchema = z.object({
  type: z.literal('audio'),
  callSid: z.string(),
  /** 16-bit signed PCM samples at 16 kHz mono. */
  pcm: z.array(z.number()),
  /** Monotonic chunk index starting at 0 for the call. */
  seq: z.number().int().nonnegative(),
});
export type AudioChunkMessage = z.infer<typeof audioChunkSchema>;

export const utteranceEndSchema = z.object({
  type: z.literal('utterance_end'),
  callSid: z.string(),
  /** Total duration of the buffered utterance in milliseconds. */
  durationMs: z.number().nonnegative(),
});
export type UtteranceEndMessage = z.infer<typeof utteranceEndSchema>;

export const callEndSchema = z.object({
  type: z.literal('call_end'),
  callSid: z.string(),
  reason: z.enum(['hangup', 'error', 'timeout', 'agent_abort']),
});
export type CallEndMessage = z.infer<typeof callEndSchema>;

export const pingSchema = z.object({
  type: z.literal('ping'),
  ts: z.number(),
});
export type PingMessage = z.infer<typeof pingSchema>;

export const bridgeToAgentSchema = z.discriminatedUnion('type', [
  callStartSchema,
  audioChunkSchema,
  utteranceEndSchema,
  callEndSchema,
  pingSchema,
]);
export type BridgeToAgentMessage = z.infer<typeof bridgeToAgentSchema>;

// ---------------------------------------------------------------------------
// Agent → Bridge
// ---------------------------------------------------------------------------

/**
 * The decision the on-device voice agent made for this utterance.
 *  - `ask_followup`: speak `text` to the caller and keep listening
 *  - `forward_to_claude_code`: send `text` to Claude Code via Telegram
 *  - `abort`: end the call (caller hit a dead end)
 */
export const agentDecisionSchema = z.object({
  type: z.literal('agent_decision'),
  callSid: z.string(),
  action: z.enum(['ask_followup', 'forward_to_claude_code', 'abort']),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  latencyMs: z.number().nonnegative(),
});
export type AgentDecisionMessage = z.infer<typeof agentDecisionSchema>;

export const agentProgressSchema = z.object({
  type: z.literal('agent_progress'),
  callSid: z.string(),
  /** Cumulative partial text generated so far this turn. */
  partialText: z.string(),
});
export type AgentProgressMessage = z.infer<typeof agentProgressSchema>;

export const agentReadySchema = z.object({
  type: z.literal('agent_ready'),
  /** Cactus model slug currently loaded, e.g. "gemma-4-E2B-int8". */
  model: z.string(),
  /** Device platform reported by the app. */
  platform: z.enum(['ios', 'android', 'macos', 'unknown']),
});
export type AgentReadyMessage = z.infer<typeof agentReadySchema>;

export const agentErrorSchema = z.object({
  type: z.literal('error'),
  callSid: z.string().optional(),
  message: z.string(),
});
export type AgentErrorMessage = z.infer<typeof agentErrorSchema>;

export const pongSchema = z.object({
  type: z.literal('pong'),
  ts: z.number(),
});
export type PongMessage = z.infer<typeof pongSchema>;

export const agentToBridgeSchema = z.discriminatedUnion('type', [
  agentDecisionSchema,
  agentProgressSchema,
  agentReadySchema,
  agentErrorSchema,
  pongSchema,
]);
export type AgentToBridgeMessage = z.infer<typeof agentToBridgeSchema>;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function encodeBridgeToAgent(msg: BridgeToAgentMessage): string {
  return JSON.stringify(msg);
}

export function encodeAgentToBridge(msg: AgentToBridgeMessage): string {
  return JSON.stringify(msg);
}

export function decodeBridgeToAgent(raw: string): BridgeToAgentMessage {
  return bridgeToAgentSchema.parse(JSON.parse(raw));
}

export function decodeAgentToBridge(raw: string): AgentToBridgeMessage {
  return agentToBridgeSchema.parse(JSON.parse(raw));
}

// ---------------------------------------------------------------------------
// Audio format constants
// ---------------------------------------------------------------------------

/** Sample rate the voice-agent app expects for PCM input to Cactus / Gemma 4. */
export const AGENT_PCM_SAMPLE_RATE = 16_000;

/** Sample rate Twilio Media Streams emits (mulaw). */
export const TWILIO_MULAW_SAMPLE_RATE = 8_000;

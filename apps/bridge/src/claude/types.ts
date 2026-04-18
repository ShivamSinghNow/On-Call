import type { Logger } from "../logger.js";

export interface ClaudeContext {
  callId: string;
  signal: AbortSignal;
  log: Logger;
}

/**
 * Pluggable seam for reaching the existing Telegram <-> Claude Code bot.
 *
 * Implementations must yield text chunks as they arrive (or the whole answer
 * as a single chunk if streaming isn't available). The bridge forwards each
 * chunk to the mobile app as an SSE `token` event.
 */
export type SendToClaude = (
  text: string,
  ctx: ClaudeContext,
) => AsyncIterable<string>;

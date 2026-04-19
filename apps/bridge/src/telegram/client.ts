/**
 * Wraps the existing Telegram bot that relays to the Claude Code session.
 *
 * Outbound: send `[call:<sid>] <prompt>` to a known chat ID. The Claude Code
 * bot is expected to echo the correlation tag back somewhere in its reply
 * (or — more commonly — answer in-line, in which case we route the response
 * to whatever call is currently `AWAITING_CLAUDE`).
 *
 * Correlation strategy:
 *   1. We attach a `[call:<sid>]` prefix on outbound messages.
 *   2. On inbound bot messages, we look for `[call:<sid>]` in the text first.
 *   3. If absent, we fall back to whichever single call is currently waiting.
 *      (V1 only handles one concurrent call, so this is unambiguous; multi-call
 *      support is a Phase 3 concern.)
 */

import { Telegraf, type Context } from 'telegraf';
import type { Logger } from '../logger.js';

const CALL_TAG_RE = /\[call:([A-Za-z0-9_-]+)\]/;

export type ClaudeReplyHandler = (callSid: string | null, text: string) => void;

export interface ClaudeCodeClientOptions {
  botToken: string;
  chatId: number;
  timeoutMs: number;
  logger: Logger;
}

export class ClaudeCodeClient {
  private readonly bot: Telegraf;
  private readonly chatId: number;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly replyHandlers: ClaudeReplyHandler[] = [];
  private started = false;

  constructor(opts: ClaudeCodeClientOptions) {
    this.chatId = opts.chatId;
    this.timeoutMs = opts.timeoutMs;
    this.logger = opts.logger.child({ component: 'claude-code' });
    this.bot = new Telegraf(opts.botToken);

    this.bot.on('message', (ctx) => this.handleInbound(ctx));
    this.bot.catch((err) => this.logger.error({ err }, 'telegraf error'));
  }

  async start(): Promise<void> {
    if (this.started) return;
    // Long-polling. For prod, swap in a webhook (see plan.md §2.5).
    void this.bot.launch().catch((err) => {
      this.logger.error({ err }, 'telegraf launch failed');
    });
    this.started = true;
    this.logger.info({ chatId: this.chatId }, 'claude code telegram client started');
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.bot.stop('SIGTERM');
    this.started = false;
  }

  /**
   * Forward a finalized prompt to the Claude Code bot.
   * Returns the raw Telegram `message_id` (useful for logging only).
   */
  async forward(callSid: string, prompt: string): Promise<number> {
    const text = `[call:${callSid}] ${prompt}`;
    const msg = await this.bot.telegram.sendMessage(this.chatId, text);
    this.logger.info({ callSid, messageId: msg.message_id }, 'forwarded prompt to claude code');
    return msg.message_id;
  }

  /** Subscribe to inbound replies. Returns an unsubscribe function. */
  onReply(handler: ClaudeReplyHandler): () => void {
    this.replyHandlers.push(handler);
    return () => {
      const i = this.replyHandlers.indexOf(handler);
      if (i >= 0) this.replyHandlers.splice(i, 1);
    };
  }

  get replyTimeoutMs(): number {
    return this.timeoutMs;
  }

  private handleInbound(ctx: Context): void {
    const msg = ctx.message;
    if (!msg || !('text' in msg) || typeof msg.text !== 'string') return;
    if (msg.chat.id !== this.chatId) return;

    const text = msg.text;
    // Ignore our own outbound messages echoed back.
    if (ctx.botInfo && msg.from?.id === ctx.botInfo.id) return;

    const match = CALL_TAG_RE.exec(text);
    const callSid = match?.[1] ?? null;
    const cleanText = match ? text.replace(match[0], '').trim() : text.trim();
    if (!cleanText) return;

    this.logger.info(
      { callSid, preview: cleanText.slice(0, 80) },
      'inbound claude code reply',
    );

    for (const handler of this.replyHandlers) {
      try {
        handler(callSid, cleanText);
      } catch (err) {
        this.logger.error({ err }, 'reply handler threw');
      }
    }
  }
}

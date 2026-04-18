import { request } from "undici";
import type { Config } from "../config.js";
import type { ClaudeContext, SendToClaude } from "./types.js";

/**
 * mode=telegram: fallback when we can't add an internal endpoint to the bot.
 *
 * 1. Post the user utterance into a dedicated relay chat the bot is a member of.
 * 2. Long-poll `getUpdates` for bot-authored messages that appear *after* our post.
 * 3. Yield the bot's reply as a single chunk. No streaming.
 *
 * This is intentionally simple and only correct for a single-user, serial
 * conversation. The `mode=local` path should be preferred.
 */
export function createTelegramSender(config: Config): SendToClaude {
  const token = config.TELEGRAM_BOT_TOKEN!;
  const chatId = config.TELEGRAM_RELAY_CHAT_ID!;
  let updateOffset = 0;

  return async function* sendTelegram(
    text: string,
    ctx: ClaudeContext,
  ): AsyncIterable<string> {
    const sentMsg = await tgCall<{ message_id: number; date: number }>(
      token,
      "sendMessage",
      { chat_id: chatId, text },
      ctx.signal,
    );

    const deadline = Date.now() + config.CLAUDE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error("aborted");

      const updates = await tgCall<TelegramUpdate[]>(
        token,
        "getUpdates",
        { offset: updateOffset, timeout: 20, allowed_updates: ["message"] },
        ctx.signal,
      );

      for (const u of updates) {
        updateOffset = Math.max(updateOffset, u.update_id + 1);
        const m = u.message;
        if (!m) continue;
        if (String(m.chat.id) !== String(chatId)) continue;
        if (m.from?.is_bot !== true) continue;
        if (m.date < sentMsg.date) continue;
        if (typeof m.text !== "string" || m.text.length === 0) continue;
        yield m.text;
        return;
      }
    }
    throw new Error("timed out waiting for Claude reply via Telegram");
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { id: number; is_bot: boolean };
    chat: { id: number };
  };
}

async function tgCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T> {
  const res = await request(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.body.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok || json.result === undefined) {
    throw new Error(`telegram ${method} failed: ${json.description ?? "unknown"}`);
  }
  return json.result;
}

import { request } from "undici";
import type { Config } from "../config.js";
import type { ClaudeContext, SendToClaude } from "./types.js";

/**
 * mode=local: call an internal HTTP endpoint exposed by the existing bot
 * process that reuses the same `claudeCodeSession.ask()` the bot already
 * calls.
 *
 * Expected bot contract, either:
 *   (a) JSON  -> `{ text: string }`
 *   (b) SSE   -> events named `token` with `data: <chunk>` and a final `done`
 *
 * We detect SSE via the `content-type` header.
 */
export function createLocalSender(config: Config): SendToClaude {
  return async function* sendLocal(
    text: string,
    ctx: ClaudeContext,
  ): AsyncIterable<string> {
    const timeout = setTimeout(() => {
      ctx.log.warn({ callId: ctx.callId }, "claude local call timed out");
    }, config.CLAUDE_TIMEOUT_MS);

    try {
      const res = await request(config.CLAUDE_LOCAL_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: ctx.callId, text }),
        signal: ctx.signal,
        bodyTimeout: config.CLAUDE_TIMEOUT_MS,
        headersTimeout: config.CLAUDE_TIMEOUT_MS,
      });

      if (res.statusCode >= 400) {
        const body = await res.body.text();
        throw new Error(
          `claude local bot returned ${res.statusCode}: ${body.slice(0, 200)}`,
        );
      }

      const contentType = String(res.headers["content-type"] ?? "");

      if (contentType.includes("text/event-stream")) {
        yield* parseSse(res.body, ctx);
        return;
      }

      const payload = (await res.body.json()) as { text?: unknown };
      if (typeof payload.text !== "string" || payload.text.length === 0) {
        throw new Error("claude local bot returned empty text");
      }
      yield payload.text;
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function* parseSse(
  body: NodeJS.ReadableStream,
  ctx: ClaudeContext,
): AsyncIterable<string> {
  let buf = "";
  let currentEvent = "message";
  for await (const chunk of body as AsyncIterable<Buffer>) {
    buf += chunk.toString("utf8");
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let data = "";
      currentEvent = "message";
      const lines = raw.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          let piece = line.slice(5);
          if (piece.startsWith(" ")) piece = piece.slice(1);
          if (data.length > 0) data += "\n";
          data += piece;
        }
      }

      if (currentEvent === "done") return;
      if (currentEvent === "error") {
        ctx.log.error({ callId: ctx.callId, data }, "claude upstream error");
        throw new Error(data || "upstream claude error");
      }
      if (data.length > 0) yield data;
    }
  }
}

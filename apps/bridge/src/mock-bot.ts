/**
 * Minimal stand-in for the existing Telegram <-> Claude Code bot.
 *
 * Implements the same `POST /internal/ask` contract documented in
 * docs/existing-bot-integration.md so the bridge and mobile app can be
 * smoke-tested before (or without) wiring the real bot.
 *
 * Modes:
 *   MOCK_MODE=json   -> returns { text } in one shot
 *   MOCK_MODE=sse    -> streams tokens
 *
 *   MOCK_PORT=5055   (default)
 */
import Fastify from "fastify";

const port = Number(process.env.MOCK_PORT ?? 5055);
const mode = (process.env.MOCK_MODE ?? "json") as "json" | "sse";

const app = Fastify({ logger: { level: "info" } });

function fakeAnswer(text: string): string {
  const trimmed = text.length > 80 ? `${text.slice(0, 80)}...` : text;
  return `You said: "${trimmed}". In a real setup, Claude Code would answer here.`;
}

app.post("/internal/ask", async (req, reply) => {
  const body = req.body as { callId?: string; text?: string } | undefined;
  const text = body?.text ?? "";
  const callId = body?.callId ?? "unknown";
  const answer = fakeAnswer(text);
  app.log.info({ callId, mode, textLen: text.length }, "mock: /internal/ask");

  if (mode === "json") {
    return reply.send({ text: answer });
  }

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const write = (event: string, data: string) => {
    reply.raw.write(`event: ${event}\n`);
    for (const line of data.split("\n")) reply.raw.write(`data: ${line}\n`);
    reply.raw.write("\n");
  };
  const tokens = answer.split(/(\s+)/);
  for (const t of tokens) {
    await new Promise((r) => setTimeout(r, 60));
    write("token", t);
  }
  write("done", "");
  reply.raw.end();
});

app.listen({ port, host: "127.0.0.1" }).then(() => {
  app.log.info({ port, mode }, "mock bot listening");
});

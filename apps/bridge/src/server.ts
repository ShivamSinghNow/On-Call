import Fastify from "fastify";
import FastifyWebSocket from "@fastify/websocket";
import { AskRequestSchema } from "@voice-bridge/shared";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createSendToClaude } from "./claude/index.js";

const config = loadConfig();
const log = createLogger(config);
const sendToClaude = createSendToClaude(config);
const startedAt = Date.now();

const inflight = new Map<string, AbortController>();

const app = Fastify({ loggerInstance: log, disableRequestLogging: true });
await app.register(FastifyWebSocket);

// iOS persistent WebSocket for callback notifications
let iosWs: import("ws").WebSocket | null = null;

app.get("/ios/stream", { websocket: true }, (socket) => {
  iosWs = socket;
  log.info("ios: connected");
  socket.on("close", () => {
    iosWs = null;
    log.info("ios: disconnected");
  });
});

app.addHook("onRequest", async (req, reply) => {
  const url = req.raw.url ?? "";
  if (url === "/health") return;
  const token = req.headers["x-bridge-token"];
  if (token !== config.BRIDGE_TOKEN) {
    log.warn({ url, ip: req.ip }, "rejected: bad bridge token");
    await reply.code(401).send({ error: "invalid bridge token" });
  }
});

app.get("/health", async () => ({
  ok: true as const,
  mode: config.CLAUDE_BRIDGE_MODE,
  uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
}));

app.post("/ask", async (req, reply) => {
  const parsed = AskRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const { callId, text } = parsed.data;

  if (inflight.has(callId)) {
    return reply.code(409).send({ error: "callId already in flight" });
  }

  const controller = new AbortController();
  inflight.set(callId, controller);

  reply.hijack();

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) controller.abort();
  });

  const write = (event: string, data: string) => {
    reply.raw.write(`event: ${event}\n`);
    for (const line of data.split("\n")) reply.raw.write(`data: ${line}\n`);
    reply.raw.write("\n");
  };

  const heartbeat = setInterval(() => {
    reply.raw.write(`: ping ${Date.now()}\n\n`);
  }, 15_000);

  const childLog = log.child({ callId });
  const t0 = Date.now();
  childLog.info({ textLen: text.length }, "ask: start");

  try {
    for await (const chunk of sendToClaude(text, {
      callId,
      signal: controller.signal,
      log: childLog,
    })) {
      if (controller.signal.aborted) break;
      write("token", chunk);
    }
    if (!controller.signal.aborted) write("done", "");
    childLog.info({ ms: Date.now() - t0 }, "ask: ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    childLog.error({ err: message }, "ask: error");
    try {
      write("error", message);
    } catch {
      // stream already closed
    }
  } finally {
    clearInterval(heartbeat);
    inflight.delete(callId);
    reply.raw.end();
  }
});

async function main() {
  await app.listen({ port: config.BRIDGE_PORT, host: "0.0.0.0" });
  log.info(
    { port: config.BRIDGE_PORT, mode: config.CLAUDE_BRIDGE_MODE },
    "voice-bridge listening",
  );
}

main().catch((err) => {
  log.fatal({ err }, "failed to start bridge");
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    log.info({ sig }, "shutting down");
    for (const [, c] of inflight) c.abort();
    await app.close();
    process.exit(0);
  });
}

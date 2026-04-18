# Wiring the existing Telegram <-> Claude Code bot into Voice Bridge

The Voice Bridge expects the existing bot process to expose **one new HTTP endpoint**
that reuses the same function the bot already calls to talk to Claude Code.

This is the only change required outside this repo.

---

## Endpoint contract

```
POST /internal/ask
Content-Type: application/json

{ "callId": "<opaque string>", "text": "<user utterance>" }
```

Two acceptable response shapes — pick whichever matches what your Claude
integration already supports.

### Option A — plain JSON (simplest)

```
200 OK
Content-Type: application/json

{ "text": "<full Claude reply>" }
```

Use this if the bot waits for the whole reply before posting to Telegram.

### Option B — Server-Sent Events (streams tokens as they arrive)

```
200 OK
Content-Type: text/event-stream

event: token
data: hello

event: token
data: there

event: done
data:
```

Use this if your Claude client exposes a streaming interface. Each `token`
event's `data` is appended to the spoken reply on the phone as it arrives.

On failure, emit `event: error` with a short human-readable message and close
the stream.

---

## Drop-in implementation (TypeScript / Fastify)

Paste this into the existing bot's server setup, replacing the `ask()` call
with whatever function the bot already uses to reach Claude Code.

```ts
// in the existing bot repo, next to the Telegram handlers
app.post("/internal/ask", async (req, reply) => {
  const { callId, text } = req.body as { callId: string; text: string };

  // Reuse exactly the same function the Telegram handler already calls.
  // Example name; rename to match your codebase.
  const answer = await claudeCodeSession.ask(text, { source: "voice-bridge", callId });

  return reply.send({ text: answer });
});
```

### Streaming variant (Option B)

```ts
app.post("/internal/ask", async (req, reply) => {
  const { callId, text } = req.body as { callId: string; text: string };

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

  try {
    for await (const chunk of claudeCodeSession.askStream(text, { source: "voice-bridge", callId })) {
      write("token", chunk);
    }
    write("done", "");
  } catch (err) {
    write("error", err instanceof Error ? err.message : String(err));
  } finally {
    reply.raw.end();
  }
});
```

### Python / FastAPI version

```python
# in the existing bot repo
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

@app.post("/internal/ask")
async def internal_ask(req: Request):
    body = await req.json()
    call_id = body["callId"]
    text = body["text"]

    # Reuse the same function the Telegram handler already calls.
    answer = await claude_code_session.ask(text, source="voice-bridge", call_id=call_id)
    return JSONResponse({"text": answer})
```

---

## Securing the endpoint

The bot's `/internal/ask` should be bound to `127.0.0.1` and/or gated by a
shared secret header so only the Voice Bridge process on the same host can
reach it. Example:

```ts
app.addHook("onRequest", async (req, reply) => {
  if (req.url !== "/internal/ask") return;
  if (req.headers["x-internal-token"] !== process.env.INTERNAL_TOKEN) {
    return reply.code(401).send();
  }
});
```

If you add the header, also update the bridge config:

```ts
// apps/bridge/src/claude/local.ts, inside createLocalSender headers:
headers: {
  "content-type": "application/json",
  "x-internal-token": process.env.CLAUDE_LOCAL_TOKEN ?? "",
},
```

---

## Verifying the integration

With the existing bot running locally on port 5055 (adjust as needed):

```bash
curl -s -X POST http://127.0.0.1:5055/internal/ask \
  -H 'content-type: application/json' \
  -d '{"callId":"test-1","text":"what files are in the repo?"}'
```

You should see a JSON `{ "text": "..." }` reply (or an SSE stream of `token`
events) that matches what Claude Code would say in Telegram.

Once that works, point the bridge at it:

```
CLAUDE_BRIDGE_MODE=local
CLAUDE_LOCAL_URL=http://127.0.0.1:5055/internal/ask
```

and start the bridge with `pnpm bridge`.

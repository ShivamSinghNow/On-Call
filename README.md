# Voice Bridge

A React Native app that lets you talk to your existing Telegram ↔ Claude Code
session with your voice. Speech-to-text runs on-device via `cactus-react-native`
(Gemma/Whisper/Moonshine). The reply is read back through the phone's built-in
TTS. A thin Node bridge owns the Telegram bot token and brokers requests.

```
phone mic -> CactusSTT (on-device) -> Node bridge -> existing Telegram/Claude bot
                                                            |
              phone speaker <- expo-speech TTS <-----------+
```

No Twilio. No phone numbers. No cloud inference. The phone is the phone.

---

## Layout

| Path | What |
|------|------|
| `apps/mobile/` | Expo + React Native app (push-to-talk UI, STT, TTS, SSE client) |
| `apps/bridge/` | Fastify bridge: `POST /ask` streams Claude's reply as SSE |
| `apps/bridge/src/mock-bot.ts` | Stand-in for the existing bot, for local smoke tests |
| `apps/bridge/docs/existing-bot-integration.md` | The one endpoint you add to the real bot |
| `packages/shared/` | Shared Zod schemas and types |

---

## First-time setup

```bash
pnpm install
cp .env.example .env        # then edit values (see below)
pnpm --filter @voice-bridge/shared build
pnpm --filter @voice-bridge/bridge build
```

Minimum `.env` keys:

```
BRIDGE_PORT=4000
BRIDGE_TOKEN=<pick something>
CLAUDE_BRIDGE_MODE=local
CLAUDE_LOCAL_URL=http://127.0.0.1:5055/internal/ask   # real bot, or the mock
EXPO_PUBLIC_BRIDGE_URL=http://<your-LAN-ip>:4000
EXPO_PUBLIC_BRIDGE_TOKEN=<same as BRIDGE_TOKEN>
```

`EXPO_PUBLIC_BRIDGE_URL` must be reachable **from the phone** — use your dev
machine's LAN IP (`ipconfig getifaddr en0` on macOS), not `localhost`.

---

## Wiring the existing Claude Code bot

Add one HTTP endpoint to the existing Telegram bot process so the bridge can
call the same function the bot already uses to reach Claude Code. See
[apps/bridge/docs/existing-bot-integration.md](apps/bridge/docs/existing-bot-integration.md)
for drop-in snippets (JSON and streaming SSE, Node and Python).

Until that endpoint exists you can run everything against the bundled mock bot
(see smoke tests below).

---

## Running the MVP

Three terminals. Two of these are only for local testing; swap in the real bot
when ready.

```bash
# Terminal 1 — mock bot (skip in production; point bridge at the real one)
pnpm --filter @voice-bridge/bridge mock-bot
# "mock bot listening"

# Terminal 2 — bridge
pnpm bridge
# "voice-bridge listening  port: 4000  mode: local"

# Terminal 3 — mobile app
pnpm mobile
# Scan the QR with Expo Go OR `i` / `a` for simulator.
```

On first launch the app downloads the Moonshine-Base STT model from Hugging
Face (~60 MB). A progress percentage is shown. After that, STT is fully offline.

To run on a **real device** you need a dev build rather than Expo Go, because
`cactus-react-native` is a native module:

```bash
cd apps/mobile
npx expo prebuild            # generates ios/ and android/ (first time)
npx expo run:ios             # or run:android
```

---

## The four MVP smoke tests

### 1. On-device transcription

Open the app on a device, hold the talk button, say "hello world", release.
Look at the Metro/Expo console for a log line with the transcribed text.
Requires the Moonshine model to have finished downloading.

### 2. Bridge SSE round-trip (no phone needed)

With the mock bot and bridge running from the commands above:

```bash
curl -N -X POST http://127.0.0.1:4000/ask \
  -H 'content-type: application/json' \
  -H "x-bridge-token: $BRIDGE_TOKEN" \
  -d '{"callId":"t1","text":"hi"}'
```

Expected: a series of `event: token` lines followed by `event: done`.

### 3. End-to-end on a real device

With the bridge pointed at the **real** bot and the app installed on a device
on the same LAN:

- Hold the talk button, ask a short coding question.
- Release. Watch the button turn blue, then see the transcript appear, then
  hear Claude's answer read aloud sentence-by-sentence.

### 4. Concurrency / no cross-talk

With the bridge running (mock or real), run two streams in parallel:

```bash
( curl -sN -X POST :4000/ask -H 'x-bridge-token: '"$BRIDGE_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"callId":"A","text":"one"}' | sed 's/^/[A] /' ) &
( curl -sN -X POST :4000/ask -H 'x-bridge-token: '"$BRIDGE_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"callId":"B","text":"two"}' | sed 's/^/[B] /' ) &
wait
```

Expected: `[A]` tokens only reference "one", `[B]` tokens only reference
"two". The bridge returns **409** if you reuse an in-flight `callId`.

---

## Explicit non-goals in this MVP

- No Twilio / phone numbers (tracked in the plan as a future adapter).
- No auth beyond a shared `x-bridge-token` header; bind the bridge to
  `127.0.0.1` or a VPN in production.
- One Claude Code session per bridge instance; no multi-user routing.
- Push-to-talk only — no streaming STT, no barge-in.
- Native platform TTS (`expo-speech`). Gemma TTS can drop in behind
  [apps/mobile/src/tts.ts](apps/mobile/src/tts.ts) without touching the UI.

---

## Plan reference

The original plan lives at `.cursor/plans/voice_bridge_rn_mvp_*.plan.md`. Every
file in this repo implements a specific todo from that plan.

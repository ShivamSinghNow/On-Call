# Voice Bridge

A React Native app that lets you talk to your running Claude Code session via voice. There are two modes:

1. **Push-to-talk** — hold a button, speak, release. On-device STT transcribes your speech and sends it to Claude Code. The reply streams back and is read aloud.
2. **Twilio call** — call a Twilio number. Audio streams to the channel server, the phone transcribes it on-device, Claude Code responds, and Twilio speaks the reply back to the caller.

```
Push-to-talk:
  phone mic -> CactusSTT (on-device) -> channel server -> Claude Code session
                                                                |
               phone speaker <- expo-speech TTS <--------------+

Twilio call:
  caller -> Twilio -> channel server -> phone (CactusSTT on-device)
                                                |
                          Claude Code session <-+
                                |
           Twilio speaks reply -+-> caller hears response
```

Everything runs locally. No cloud inference. Claude Code is the brain.

---

## How it works

The channel server is an MCP server that Claude Code spawns automatically via `.mcp.json`. It exposes two interfaces:

- **HTTP/SSE on port 4000** — the phone app posts text and receives streaming token replies
- **WebSocket `/twilio/stream`** — Twilio Media Streams audio arrives here, gets converted from mulaw 8kHz to 16kHz PCM, and forwarded to the phone for on-device transcription
- **WebSocket `/phone/stream`** — the React Native app connects here to receive audio chunks and send back transcriptions

---

## Layout

| Path | What |
|------|------|
| `apps/channel/` | MCP channel server — Claude Code spawns this; handles push-to-talk SSE, Twilio audio relay, and phone WebSocket |
| `apps/mobile/` | Expo + React Native app — push-to-talk UI, on-device STT, TTS, Twilio call handler |
| `packages/shared/` | Shared Zod schemas and types |

---

## First-time setup

**Requirements**: [Bun](https://bun.sh) and [ngrok](https://ngrok.com) installed.

```bash
pnpm install
cd apps/channel && bun add @modelcontextprotocol/sdk
cp .env.example .env   # then fill in values
```

`.env` keys:

```
BRIDGE_PORT=4000
BRIDGE_TOKEN=<pick something>
PUBLIC_URL=https://xxxx.ngrok-free.app   # set after starting ngrok
TWILIO_ACCOUNT_SID=<from Twilio console>
TWILIO_AUTH_TOKEN=<from Twilio console>
TWILIO_PHONE_NUMBER=<your Twilio number>
EXPO_PUBLIC_BRIDGE_URL=http://<your-LAN-ip>:4000
EXPO_PUBLIC_BRIDGE_TOKEN=<same as BRIDGE_TOKEN>
```

`EXPO_PUBLIC_BRIDGE_URL` must be reachable from the phone — use your machine's LAN IP (`ipconfig getifaddr en0` on macOS), not `localhost`.

---

## Running

```bash
# Terminal 1 — start ngrok and copy the URL into .env as PUBLIC_URL
ngrok http 4000

# Terminal 2 — start Claude Code (spawns the channel server automatically)
claude --dangerously-load-development-channels server:voice

# Terminal 3 — mobile app
pnpm mobile
```

On first launch the app downloads the Moonshine-Base STT model (~60 MB). A progress percentage is shown. After that, STT is fully offline.

To run on a **real device** you need a dev build because `cactus-react-native` is a native module:

```bash
cd apps/mobile
npx expo prebuild       # generates ios/ and android/ (first time)
npx expo run:ios        # or run:android
```

---

## Twilio setup (one-time)

1. Start ngrok: `ngrok http 4000`
2. Copy the URL into `.env` as `PUBLIC_URL`
3. In the [Twilio console](https://console.twilio.com), set your phone number's **Voice webhook** to: `https://xxxx.ngrok-free.app/twilio/voice`
4. Restart Claude Code with the channel flag

Then call your Twilio number. You'll hear silence while the system processes your speech, then Claude's response read back to you.

---

## Smoke tests

### 1. Channel server SSE round-trip

With Claude Code running:

```bash
curl -N -X POST http://127.0.0.1:4000/ask \
  -H 'content-type: application/json' \
  -H "x-bridge-token: $BRIDGE_TOKEN" \
  -d '{"callId":"t1","text":"what files are in this repo?"}'
```

Expected: `event: token` lines streaming in, followed by `event: done`.

### 2. Push-to-talk on a real device

With the app installed and Claude Code running, hold the button, ask a coding question, release. You should see the transcript appear and hear Claude's answer read aloud.

### 3. Twilio call

With ngrok running and the Twilio webhook configured, call your Twilio number and speak. Claude Code responds and Twilio reads the reply back.

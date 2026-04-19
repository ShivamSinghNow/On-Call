# On-Call

Hands-free Claude Code via phone. Call a Twilio number from anywhere → Gemma 4 (E2B) running on-device via Cactus screens the request and asks any clarifying questions → the cleaned-up prompt is forwarded to your Claude Code session through Telegram → Claude's answer is spoken back via Polly TTS.

See [`plan.md`](./plan.md) for the full architecture and roadmap.

## Repo layout

```
.
├── apps/
│   ├── bridge/        # Node.js orchestrator (Fastify + WebSocket)
│   └── voice-agent/   # React Native (Expo) headless app hosting Cactus + Gemma 4
└── packages/
    └── shared/        # WS protocol types, mulaw decoding, VAD helpers
```

## Quick start

### Prereqs

- Node.js ≥ 20.10
- pnpm ≥ 9
- A Twilio account with a phone number
- A Telegram bot already connected to your Claude Code session
- An iPhone / iPad / Android phone / Apple Silicon Mac to run the voice-agent app
- An ngrok-style HTTPS tunnel for local bridge development

### Install

```bash
pnpm install
cp .env.example .env
# Fill in TWILIO_*, TELEGRAM_*, AGENT_AUTH_TOKEN
```

### Run the bridge (dev)

```bash
pnpm dev:bridge
# In another terminal:
ngrok http 3000
# Paste the ngrok URL into your Twilio number's voice webhook:
#   https://<ngrok>/twilio/voice
```

### Run the voice agent (dev)

```bash
cd apps/voice-agent
pnpm install
pnpm prebuild         # Generates ios/ and android/ projects (Cactus needs native modules)
pnpm ios              # or `pnpm android`
```

The first launch will prompt the app to download Gemma 4 weights via Cactus (~1-2 GB depending on quantization). After that, the app holds a persistent WebSocket to the bridge and processes audio chunks on-device.

### Smoke test

1. Confirm the bridge is up: `curl https://<ngrok>/healthz` → `{ "ok": true }`.
2. Confirm the voice agent app shows "Connected to bridge" on its debug screen.
3. Call your Twilio number. You should hear the Polly greeting, then be able to speak a coding question.

## Scripts

```bash
pnpm typecheck   # Run tsc --noEmit across all packages
pnpm test        # Run unit tests
pnpm build       # Build all packages
```

## Configuration

All bridge configuration is via environment variables — see [`.env.example`](./.env.example) for the full list.

Voice-agent configuration (WebSocket URL, model slug) is via `EXPO_PUBLIC_*` vars baked at build time. Override per-environment by passing `--env-file` or using `eas.json` for production builds.

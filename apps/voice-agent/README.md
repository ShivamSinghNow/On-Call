# @on-call/voice-agent

Headless React Native (Expo) app that hosts the on-device voice agent — Cactus runtime + Gemma 4 (E2B). Holds a persistent WebSocket to the bridge server, processes audio chunks per call, and emits structured screening decisions.

See [`../../plan.md`](../../plan.md) for the full architecture.

## Setup

```bash
# From the monorepo root
pnpm install

# In this directory
cp .env.example .env.local   # see below
pnpm prebuild                # generates ios/ and android/ projects
pnpm ios                     # or `pnpm android`
```

## Environment

Set these as `EXPO_PUBLIC_*` vars in `.env.local` (auto-loaded by Expo) or pass at build time:

```
EXPO_PUBLIC_BRIDGE_WS_URL=wss://your-bridge.example.com/agent
EXPO_PUBLIC_AGENT_AUTH_TOKEN=<same value as bridge AGENT_AUTH_TOKEN>
EXPO_PUBLIC_GEMMA_MODEL_SLUG=gemma-4-E2B
```

## Native modules

Cactus requires `react-native-nitro-modules` and ships with native iOS / Android code. You **must** run `pnpm prebuild` before the first `ios` / `android` build to materialize the native projects. Re-run after any plugin or `app.json` change.

## Background execution

- **iOS:** `app.json` declares `UIBackgroundModes: ["audio", "voip"]` so the WS and Cactus inference keep running when the screen locks.
- **Android:** Foreground service permission is declared. The current code keeps the screen awake via `expo-keep-awake`. A real Android foreground service is a Phase 3 follow-up.

## Debug UI

The app shows a minimal status panel:

- Model download progress + currently loaded model identifier
- WebSocket connection status (`connecting | open | reconnecting | error`)
- Active call SID (if any)
- Last screening decision
- Rolling log of the most recent 100 events

This is the only UI by design — see plan.md §2.3.

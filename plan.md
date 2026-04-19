# On-Call: Hands-Free Claude Code via Phone
### Product & Technical Roadmap

---

## Vision

A hands-free, phone-accessible AI coding assistant. The user calls a Twilio number from any phone. A low-latency voice agent — **Gemma 4 (E2B) running on-device via Cactus inside a headless React Native app** — listens to raw audio, asks any clarifying questions it needs, then forwards a clean, well-formed prompt to a Claude Code session through the existing Telegram bot. Claude Code's response comes back, gets spoken to the caller via Twilio's Polly TTS, and the loop continues. The whole thing should feel like talking to a competent technical colleague who knows when to dig deeper before bothering the senior engineer.

---

## Key Architectural Constraints (read first)

1. **Cactus is an on-device runtime**, not a GPU hosting service. Gemma 4 runs on a real ARM device (iPhone, iPad, Android phone, Apple Silicon Mac). There is no FastAPI server wrapping the model — the React Native app *is* the inference host.
2. **Gemma 4 is the voice agent**, not a transcription primitive. It consumes raw audio directly (per the Cactus + Gemma 4 day-one integration: "the model doesn't transcribe then think — it reasons over the raw modality"). Pipeline latency target: ~300ms from end-of-utterance to first response token on an M-series device.
3. **The React Native app has no UI.** It runs as a foreground process whose sole job is to host the Cactus runtime and shuttle audio/text over a persistent WebSocket to the Bridge Server.
4. **Twilio handles TTS** via Polly Neural voices in TwiML. We do **not** synthesize audio on-device; Cactus + Gemma 4 do not provide TTS.
5. **The React Native app does not talk to Claude Code.** Only the Bridge Server does, via the existing Telegram bot integration.

---

## Component Inventory

| Component | Role | Technology |
|---|---|---|
| Twilio | Telephony + TTS | Twilio Programmable Voice, Media Streams API, TwiML `<Say>` with Polly Neural |
| Bridge Server | Stateful orchestrator. Routes audio between Twilio and the RN app, routes text between the RN app and Telegram, manages call state machines | Node.js + TypeScript (Fastify or Hono), `ws` for WebSocket server |
| React Native App ("Voice Agent Host") | Headless host for Cactus + Gemma 4. Runs on a dedicated device (the user's iPhone or an always-on Android tablet). Persistent outbound WebSocket to the Bridge Server | React Native (Expo bare workflow or RN CLI), `cactus-react-native`, `react-native-nitro-modules` |
| Gemma 4 (E2B) on Cactus | Low-latency voice agent. Consumes raw audio, generates clarifying questions or finalized prompts | `CactusLM` with `model: 'gemma-4-E2B'`, audio passed via vision/audio modality input |
| Telegram Bot | Existing relay to the Claude Code session — **already working, do not redesign** | Telegram Bot API, existing integration |
| Claude Code | Does the actual coding work | Existing Claude Code session |

---

## Phase 0 — Foundation & Proof of Concept

**Goal:** Confirm each link in the chain works independently before any integration.

### 0.1 Telegram ↔ Claude Code Verification

- Confirm the existing Claude Code ↔ Telegram bot integration is stable.
- Document the message format: what gets sent to the bot, what Claude Code returns. Specifically capture: max message length, how multi-message responses arrive, how long-running tool calls are surfaced.
- Identify latency characteristics (p50 / p95 round-trip from sending a message to receiving Claude Code's first response chunk).
- Add structured logging on the Telegram bot so every inbound and outbound message is captured with `{ messageId, callId?, timestamp, direction, text }`.
- Verify the bot exposes (or can expose) a programmatic interface the Bridge Server can call — at minimum, Telegram's `sendMessage` HTTP API + a webhook for inbound messages from the bot.

### 0.2 Cactus + Gemma 4 On-Device Smoke Test (React Native)

- Scaffold a minimal React Native app (Expo bare workflow recommended for native module access).
- Install dependencies: `npm install cactus-react-native react-native-nitro-modules`. Run pod install for iOS.
- In a single screen, instantiate `CactusLM` with `model: 'gemma-4-E2B'`, options `{ quantization: 'int8' }`. (Confirm via `getRegistry()` that the exact slug is `gemma-4-E2B` once the model is published — fall back to whatever Cactus exposes.)
- Run the model download with progress UI (one-time, weights are persisted by Cactus).
- Hello-world inference paths to verify:
  - **Text in → text out.** `cactusLM.complete({ messages: [{ role: 'user', content: 'Write a haiku about kubernetes.' }] })`. Log `timeToFirstTokenMs`, `decodeTps`, `ramUsageMb`.
  - **Audio in → text out.** Load a bundled `.wav` of a recorded question, pass it as a multimodal input via `CactusLMMessage` (using whatever field Cactus exposes for audio inputs — the Gemma 4 integration treats audio as a first-class modality alongside `images`). Confirm the response is a coherent answer to the spoken question, not just a transcription.
- Benchmark on the actual target device (not the simulator):
  - Cold init time (first `complete()` after app launch).
  - Warm time-to-first-token for a 5-second audio clip.
  - RAM usage at idle vs. peak.
  - Battery drain over a 10-minute continuous-conversation simulation.
- **Decision gate:** if E2B latency on the target device is above ~1.5s end-to-end for a short utterance, document it and consider whether the project is viable on that device class.

### 0.3 Twilio Voice Smoke Test

- Purchase a Twilio phone number.
- Stand up a minimal webhook endpoint (`POST /twilio/voice`) that returns TwiML answering the call with a static `<Say voice="Polly.Joanna-Neural">Hello from On-Call.</Say>` and `<Hangup/>`.
- Confirm: inbound calls connect, audio plays clearly, hangup is clean, webhook is reachable from Twilio's IP range.
- Add Twilio Media Streams: switch the TwiML to `<Connect><Stream url="wss://.../twilio/stream"/></Connect>` and confirm raw mulaw/8kHz audio frames arrive at the WebSocket endpoint with the expected JSON envelope (`event: 'media'`, `payload: <base64 mulaw>`).

### Deliverable

A short written status doc confirming: (a) Telegram ↔ Claude Code round-trips work and the bot has a programmatic surface, (b) Gemma 4 (E2B) runs on-device via Cactus with measured latency numbers, (c) Twilio inbound calls answer and Media Streams deliver audio. **No integration between the three yet.**

---

## Phase 1 — Voice Agent Loop (Offline / Batch)

**Goal:** Build the on-device Gemma 4 voice agent in isolation. Prove that it can take an audio clip, hold a multi-turn clarification dialogue with simulated user input, and emit a structured "ready to send to Claude Code" prompt — all without any network involvement.

### 1.1 Voice Agent Prompt & State Design

Design the system prompt that turns Gemma 4 into a coding-assistant-screener. Requirements:

- The model receives raw audio of the user's utterance plus a short conversation history.
- The model outputs **structured JSON** (use Gemma 4's tool-calling support via `CactusLMTool`):
  - `action: "ask_followup" | "forward_to_claude_code" | "abort"`
  - `text: string` — the clarifying question to speak to the user, OR the finalized prompt to send to Claude Code, OR an explanation if aborting.
  - `confidence: number` — model's own assessment of whether the prompt is ready (used for telemetry, not control flow).
- The system prompt explicitly instructs the model to: ask at most 2-3 clarifying questions before forwarding; never attempt to answer coding questions itself; preserve the user's exact wording when forwarding (don't paraphrase the technical content); strip filler words and false starts from the final prompt.

### 1.2 On-Device Voice Agent Module

Inside the React Native app (still no UI beyond debug controls):

- Wrap `CactusLM` in a `VoiceAgent` class that owns:
  - The Gemma 4 instance (lazy-initialized, kept warm).
  - Per-call conversation history (`CactusLMMessage[]`).
  - The structured tool definition for the JSON output above.
- Public methods:
  - `processUtterance(audioPcm: number[]): Promise<{ action, text, confidence }>` — feeds audio + history into `cactusLM.complete()`, parses the function-call output, appends to history, returns the decision.
  - `reset()` — clear history at the start of a new call.
- Stream tokens via the `onToken` callback so we can begin TTS pipeline preparation before generation finishes.

### 1.3 Batch Test Harness

Build a debug-only screen in the RN app (or a CLI test driver in `apps/voice-agent/`) that:

- Loads a folder of recorded `.wav` test clips (real questions you'd ask Claude Code: "the deploy is failing with an OOM, what do I do", "refactor my auth middleware to use JWT", etc.).
- For each clip, runs `voiceAgent.processUtterance()`.
- Prints the full transcript of decisions, latency per turn, and the final forwarded prompt.
- Includes "follow-up" clips for multi-turn scenarios (clip 1 = vague question, clip 2 = clarification answer, etc.) and confirms the agent eventually emits `forward_to_claude_code` with a coherent prompt.

### Deliverable

A demo script: `npm run voice-agent:batch -- --input ./test-clips/oom-deploy.wav` that runs entirely offline on the device and produces a clean prompt suitable to paste into Claude Code, with measured per-turn latency.

---

## Phase 2 — Real-Time Voice Bridge

**Goal:** Connect the three pieces — Twilio ↔ Bridge Server ↔ React Native app ↔ (existing) Telegram bot ↔ Claude Code — so a real phone call results in spoken Claude Code answers.

### 2.1 Bridge Server (Core)

The central orchestrator. Stateless to disk; in-memory state per active call.

**Responsibilities:**

- HTTP endpoint `POST /twilio/voice` returning TwiML that opens a Media Stream to `wss://bridge/twilio/:callSid`.
- Twilio Media Stream WebSocket handler at `/twilio/:callSid`:
  - Receives 8kHz mulaw audio frames.
  - Decodes mulaw → 16-bit PCM @ 16kHz (resample) — the format Gemma 4 / Cactus expects for audio input.
  - Buffers PCM until a Voice Activity Detection (VAD) endpoint signals end-of-utterance.
- Persistent WebSocket connection to the React Native app at `/agent` (the app is the *client*, the bridge is the *server*; the app reconnects with exponential backoff on drop).
- Per-call state machine:

```
IDLE → LISTENING → BUFFERING_UTTERANCE → SENT_TO_AGENT
     → (agent says ASK_FOLLOWUP) → SPEAKING → LISTENING
     → (agent says FORWARD_TO_CLAUDE_CODE) → AWAITING_CLAUDE → SPEAKING → LISTENING
     → (caller hangs up) → CLEANUP
```

- Routing rules:
  - Audio chunks → React Native app (with `callSid` envelope).
  - Agent response with `action: ask_followup` → speak `text` to caller via injected TwiML `<Say>`, return to LISTENING.
  - Agent response with `action: forward_to_claude_code` → send `text` to the Telegram bot (tagged with `callSid` for correlation), enter AWAITING_CLAUDE.
  - Telegram bot reply for a known `callSid` → speak via TwiML `<Say>`, return to LISTENING.

**Implementation choices:**

- **Voice Activity Detection.** Run VAD on the bridge server using `node-vad` (Silero port) or run it on-device via Cactus's `CactusAudio.vad()`. Recommendation: do it on the bridge to keep the device-side code simple and to avoid sending dead air over the WebSocket.
- **TTS playback.** During `SPEAKING`, the bridge can't simply append `<Say>` mid-stream because Media Streams is bidirectional and continuous. Two options:
  1. **Stream Polly audio back through the Media Stream** as outbound mulaw frames (more complex, lower latency).
  2. **Use Twilio `redirect`** to a fresh TwiML document that does `<Say>` then re-`<Connect><Stream>` (simpler, ~500ms gap per turn).

  Start with option 2; promote to option 1 in Phase 3 if turn-taking feels sluggish.
- **Concurrency model.** One async context per active call (Node.js naturally handles this with one WebSocket connection per call). A single React Native device can serialize processing — document this limit and reject second concurrent calls with a polite "I'm busy, try again in a moment" TwiML response in V1.

### 2.2 React Native App ↔ Bridge WebSocket Protocol

Define a small JSON protocol over the persistent WebSocket. Messages from bridge → app:

```ts
{ type: 'call_start', callSid: string }
{ type: 'audio', callSid: string, pcm: number[] }     // 16kHz s16le PCM samples
{ type: 'utterance_end', callSid: string }            // VAD signaled silence; process now
{ type: 'call_end', callSid: string }
```

Messages from app → bridge:

```ts
{ type: 'agent_decision', callSid: string,
  action: 'ask_followup' | 'forward_to_claude_code' | 'abort',
  text: string,
  confidence: number,
  latencyMs: number }
{ type: 'agent_progress', callSid: string, partialText: string }   // streamed tokens
{ type: 'error', callSid: string, message: string }
```

The app keeps one `VoiceAgent` instance per active `callSid` (with its own conversation history) and disposes it on `call_end`.

### 2.3 React Native App: Background Execution & Resilience

The app must stay alive and responsive while a call is in progress:

- **iOS.** Enable the `audio` background mode in `Info.plist` so the WebSocket and Cactus inference can keep running when the screen locks. Long-term, evaluate VoIP push (PushKit) so the app can be woken by the bridge when a call arrives instead of staying always-on.
- **Android.** Run the WebSocket + Cactus in a foreground service with a persistent notification ("On-Call voice agent active"). Use `react-native-foreground-service` or a small custom native module.
- **Reconnection.** Exponential backoff (1s, 2s, 4s, ..., capped at 30s). On reconnect, the bridge tells the app about any in-progress call.
- **Memory pressure.** Listen for OS memory warnings; call `cactusLM.reset()` between calls to clear KV cache; never hold more than one VoiceAgent instance at a time in V1.

### 2.4 Twilio Integration (Production)

- Configure the Twilio number's voice webhook to `POST https://bridge.<your-domain>/twilio/voice`.
- TwiML on call connect: greet briefly (`<Say voice="Polly.Joanna-Neural">Connected. Go ahead.</Say>`), then `<Connect><Stream/></Connect>`.
- Implement Twilio status callbacks (`call.completed`, `call.failed`) to clean up bridge state.
- DTMF handling: `*` to hang up, `0` to repeat the last spoken response (bridge keeps the last `<Say>` text in call state).
- Authenticate the Twilio webhook with the `X-Twilio-Signature` header.

### 2.5 Telegram Bot Adapter (in the Bridge Server)

- Wrap the existing Telegram bot interaction in a `ClaudeCodeClient` class with two methods:
  - `forward(callSid: string, prompt: string): Promise<void>` — sends to the Telegram chat where the Claude Code bot is listening, prefixing the message with a correlation tag (e.g., `[call:abc123]`) the bot can echo back.
  - On inbound bot messages, parse the correlation tag and dispatch the response text to the bridge's per-call state machine.
- Edge cases:
  - **Claude Code is taking too long.** After 15s of `AWAITING_CLAUDE`, speak "still thinking, one moment" via injected TTS; reset the timer.
  - **Empty or error response from Claude.** Speak "Claude returned an error, try rephrasing" and return to LISTENING.
  - **Multi-message Claude responses.** Buffer chunks for a 1.5s quiet window before speaking, to avoid choppy turn-taking.

### 2.6 End-to-End Testing

- Call the Twilio number from a real phone.
- Test scenarios:
  1. **Clear ask:** "Why is my pod stuck in CrashLoopBackoff after the latest deploy?" → Gemma 4 should forward immediately.
  2. **Vague ask:** "Something's broken" → Gemma 4 should ask 1-2 clarifying questions before forwarding.
  3. **Multi-turn:** Ask a follow-up after Claude responds. Confirm history is preserved across turns within the same call.
  4. **Hangup mid-response:** Caller hangs up while Claude is generating. Bridge must abort cleanly without leaking state.
  5. **App offline:** RN device loses network during a call. Bridge should detect WebSocket drop within 5s, speak "voice agent disconnected" and end the call gracefully.
  6. **Gibberish:** Speak nonsense. Gemma 4 should ask for clarification rather than forward garbage.

### Deliverable

A working phone number you can call from any phone to talk to your Claude Code session, with on-device Gemma 4 doing the screening and Polly speaking the answers. End-to-end latency from end-of-utterance to start of TTS playback should be under ~2.5s for the simple-ask case.

---

## Phase 3 — Latency, Robustness, Polish

Optional but high-value follow-ups once the loop works.

- **Streaming TTS.** Replace the redirect-based `<Say>` pattern with outbound mulaw frames over the Media Stream so Polly audio starts playing while Claude is still generating.
- **Barge-in.** Detect caller speech during TTS playback and interrupt — common UX in phone agents, requires bidirectional VAD on the bridge.
- **Multiple concurrent calls.** Run multiple RN devices behind the bridge (or run multiple `VoiceAgent` instances per device if memory allows on a beefier phone/tablet) and shard calls across them.
- **Conversation memory across calls.** Persist a short summary of the previous call into the next call's Gemma 4 system prompt so the agent has context.
- **Hybrid handoff.** Per the Cactus blog's "knowing when to ask for help" pattern, let Gemma 4 itself answer trivial questions (e.g., "what's the kubectl command to list pods") without ever forwarding to Claude Code, using the `confidenceThreshold` / `cloudHandoffThreshold` knobs already in the Cactus API.
- **Call recording + transcripts.** Store the audio and a written log per call for debugging and training.
- **E4B as opt-in.** Let the user (via a config flag, since there's no UI) switch to Gemma 4 E4B on devices with enough RAM for the quality bump.

---

## Open Questions / Risks

- **Audio modality input shape for Cactus.** Inspecting `cactus-react-native@0.2.11` shows multimodal media is passed as **file paths** via `multimodalCompletion(contextId, prompt, mediaPaths, params)` or (equivalently) `CactusVLM.completion(messages, { images: [path], ... })`. The `images` field is the generic media-path channel and Gemma 4 interprets audio clips written to it. The voice-agent implementation writes each utterance's PCM to a temp WAV and passes that path through `images: [wavPath]`. If a future Cactus release splits this into a dedicated `audios: string[]` field, change the single line in `apps/voice-agent/src/voice-agent.ts` that constructs the completion params.
- **Gemma 4 asset URLs.** The Cactus Gemma 4 blog post announces day-one support but we treat the GGUF + mmproj asset URLs as deployment configuration (`EXPO_PUBLIC_GEMMA_MODEL_PATH`, `EXPO_PUBLIC_GEMMA_MMPROJ_PATH`). Confirm the canonical Hugging Face URLs against the Cactus model registry or blog release notes before first deploy.
- **iOS background reliability.** Long-running foreground audio sessions on iOS are workable but fragile. If the always-on requirement becomes painful, consider a small Apple Silicon Mac (M-series Mac mini) running the React Native app via Mac Catalyst — Cactus's M5 benchmarks suggest this is the most robust deployment target.
- **Telegram as the Claude Code transport.** This is preserved from the original plan because it already works, but it's the longest, most fragile leg of the round-trip. A future phase could replace it with a direct Claude Agent SDK call from the Bridge Server.

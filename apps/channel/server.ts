#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config ---
const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const PORT = Number(process.env.BRIDGE_PORT ?? 4000);
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");

// --- State ---
// Push-to-talk: pending SSE emitters keyed by callId
const pendingSSE = new Map<string, (event: string, data: string) => void>();

// Twilio calls: accumulate Claude's reply then respond to Twilio
const pendingTwilio = new Map<string, { callSid: string; replyText: string }>();

// Phone WebSocket — the React Native app connects here
let phoneWs: { send: (msg: object) => void } | null = null;

// iOS WebSocket — the Swift app connects here for callback notifications
let iosWs: { send: (msg: object) => void } | null = null;

// Active Twilio media streams keyed by streamSid
interface TwilioStreamState {
  callSid: string;
  buffer: number[];
  timer: ReturnType<typeof setTimeout> | null;
}
const twilioStreams = new Map<string, TwilioStreamState>();

// --- MCP Server ---
const mcp = new Server(
  { name: "voice-bridge", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      'Voice messages arrive as <channel source="voice-bridge" chat_id="...">text</channel>.',
      "The user is speaking to you via voice — keep responses concise and conversational as they will be read aloud.",
      "Always reply using the reply tool, passing the chat_id from the channel tag.",
      "For longer responses, call reply multiple times with sentence-sized chunks of text.",
      "Always set is_final=true on the last reply call to signal the response is complete.",
    ].join("\n"),
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Send a voice reply to the user. Call multiple times to stream sentence chunks. Set is_final=true on the last call.",
      inputSchema: {
        type: "object",
        properties: {
          chat_id: {
            type: "string",
            description: "The chat_id from the channel tag",
          },
          text: {
            type: "string",
            description: "Text chunk to speak to the user",
          },
          is_final: {
            type: "boolean",
            description: "Set to true on the last reply call",
          },
        },
        required: ["chat_id", "text", "is_final"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== "reply") {
    throw new Error(`unknown tool: ${req.params.name}`);
  }

  const { chat_id, text, is_final } = req.params.arguments as {
    chat_id: string;
    text: string;
    is_final: boolean;
  };

  // Route to push-to-talk SSE stream
  const sseEmit = pendingSSE.get(chat_id);
  if (sseEmit) {
    sseEmit("token", text);
    if (is_final) {
      sseEmit("done", "");
      pendingSSE.delete(chat_id);
    }
    return { content: [{ type: "text", text: "sent" }] };
  }

  // Route to Twilio call
  const twilio = pendingTwilio.get(chat_id);
  if (twilio) {
    twilio.replyText += text;
    if (is_final) {
      const { callSid, replyText } = twilio;
      pendingTwilio.delete(chat_id);
      await respondToTwilioCall(callSid, replyText).catch(console.error);
    }
    return { content: [{ type: "text", text: "sent" }] };
  }

  // Route to iOS app as a callback notification
  if (is_final && iosWs) {
    iosWs.send({ type: "callback", chat_id, text });
    return { content: [{ type: "text", text: "sent to ios" }] };
  }

  return { content: [{ type: "text", text: "no pending connection" }] };
});

await mcp.connect(new StdioServerTransport());

// --- Audio: mulaw G.711 → 16kHz linear PCM ---
function mulawDecode(byte: number): number {
  byte = ~byte & 0xff;
  const sign = byte & 0x80 ? -1 : 1;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  const magnitude = ((mantissa << 1) + 33) << exponent;
  return sign * (magnitude - 33);
}

function decodeTwilioPayload(base64: string): number[] {
  const bytes = Buffer.from(base64, "base64");
  // Decode mulaw 8kHz -> linear 8kHz
  const pcm8k: number[] = new Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    pcm8k[i] = mulawDecode(bytes[i]);
  }
  // Upsample 8kHz -> 16kHz via linear interpolation
  const pcm16k: number[] = new Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] =
      i < pcm8k.length - 1
        ? Math.round((pcm8k[i] + pcm8k[i + 1]) / 2)
        : pcm8k[i];
  }
  return pcm16k;
}

// --- Twilio REST API ---
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function respondToTwilioCall(
  callSid: string,
  text: string,
): Promise<void> {
  const streamWsUrl = PUBLIC_URL.replace(/^https/, "wss").replace(
    /^http/,
    "ws",
  ) + "/twilio/stream";

  const twiml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `  <Say voice="Polly.Joanna">${escapeXml(text)}</Say>`,
    "  <Connect>",
    `    <Stream url="${streamWsUrl}" />`,
    "  </Connect>",
    "</Response>",
  ].join("\n");

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `Twiml=${encodeURIComponent(twiml)}`,
    },
  );
}

// --- WebSocket Handlers ---
function handleTwilioMessage(raw: string) {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.event === "start") {
    const { callSid, streamSid } = msg.start as {
      callSid: string;
      streamSid: string;
    };
    twilioStreams.set(streamSid, { callSid, buffer: [], timer: null });
  }

  if (msg.event === "media") {
    const streamSid = msg.streamSid as string;
    const state = twilioStreams.get(streamSid);
    if (!state) return;

    const pcm = decodeTwilioPayload(msg.media.payload as string);
    state.buffer.push(...pcm);

    // Send accumulated audio to phone after 1.5s of silence
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      if (state.buffer.length > 0 && phoneWs) {
        phoneWs.send({
          type: "audio",
          pcm: state.buffer,
          callSid: state.callSid,
        });
        state.buffer = [];
      }
      state.timer = null;
    }, 1500);
  }

  if (msg.event === "stop") {
    const streamSid = msg.streamSid as string;
    const state = twilioStreams.get(streamSid);
    if (state?.timer) clearTimeout(state.timer);
    twilioStreams.delete(streamSid);
  }
}

async function handlePhoneMessage(raw: string) {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "transcription" && msg.text && msg.callSid) {
    const { text, callSid } = msg as { text: string; callSid: string };
    // Register pending Twilio reply before notifying Claude
    pendingTwilio.set(callSid, { callSid, replyText: "" });

    await mcp
      .notification({
        method: "notifications/claude/channel",
        params: { content: text, meta: { chat_id: callSid } },
      })
      .catch(console.error);
  }
}

// --- HTTP Handler ---
async function handleHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/health") {
    return Response.json({ status: "ok" });
  }

  // Twilio webhook — no token auth (Twilio doesn't send it)
  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    const streamWsUrl = PUBLIC_URL.replace(/^https/, "wss").replace(
      /^http/,
      "ws",
    ) + "/twilio/stream";
    const twiml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      "  <Connect>",
      `    <Stream url="${streamWsUrl}" />`,
      "  </Connect>",
      "</Response>",
    ].join("\n");
    return new Response(twiml, { headers: { "Content-Type": "text/xml" } });
  }

  // Token auth for remaining routes
  if (TOKEN && req.headers.get("x-bridge-token") !== TOKEN) {
    return new Response("unauthorized", { status: 401 });
  }

  if (req.method === "POST" && url.pathname === "/ask") {
    let body: { callId?: string; text?: string };
    try {
      body = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const { callId, text } = body;
    if (!callId || !text) return new Response("bad request", { status: 400 });
    if (pendingSSE.has(callId)) return new Response("conflict", { status: 409 });

    const response = await new Promise<string>((resolve, reject) => {
      let accumulated = "";

      const emit = (event: string, data: string) => {
        if (event === "token") accumulated += data;
        if (event === "done") resolve(accumulated);
        if (event === "error") reject(new Error(data));
      };

      pendingSSE.set(callId, emit);

      mcp
        .notification({
          method: "notifications/claude/channel",
          params: { content: text, meta: { chat_id: callId } },
        })
        .catch((err) => {
          pendingSSE.delete(callId);
          reject(err);
        });

      req.signal.addEventListener("abort", () => {
        pendingSSE.delete(callId);
        reject(new Error("aborted"));
      });
    });

    return Response.json({ response });
  }

  return new Response("not found", { status: 404 });
}

// --- Bun HTTP + WebSocket Server ---
interface WsData {
  type: "twilio" | "phone" | "ios";
}

Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/twilio/stream") {
      if (server.upgrade(req, { data: { type: "twilio" } })) return undefined;
    }

    if (url.pathname === "/phone/stream") {
      if (server.upgrade(req, { data: { type: "phone" } })) return undefined;
    }

    if (url.pathname === "/ios/stream") {
      if (server.upgrade(req, { data: { type: "ios" } })) return undefined;
    }

    return handleHttp(req);
  },

  websocket: {
    open(ws) {
      if (ws.data.type === "phone") {
        phoneWs = { send: (msg) => ws.send(JSON.stringify(msg)) };
      } else if (ws.data.type === "ios") {
        iosWs = { send: (msg) => ws.send(JSON.stringify(msg)) };
        console.log("[ios] connected");
      }
    },

    message(ws, raw) {
      const text = typeof raw === "string" ? raw : raw.toString();
      if (ws.data.type === "twilio") {
        handleTwilioMessage(text);
      } else if (ws.data.type === "phone") {
        void handlePhoneMessage(text);
      }
    },

    close(ws) {
      if (ws.data.type === "phone") {
        phoneWs = null;
      } else if (ws.data.type === "ios") {
        iosWs = null;
        console.log("[ios] disconnected");
      }
    },
  },
});

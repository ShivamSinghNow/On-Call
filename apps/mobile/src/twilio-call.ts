import { stt } from "./stt";
import { config } from "./config";

/**
 * Connects to the channel server's /phone/stream WebSocket.
 * When a Twilio call comes in, the server sends PCM audio chunks here.
 * We transcribe them on-device and send the text back.
 *
 * Returns a cleanup function to disconnect.
 */
export function connectTwilioCallHandler(): () => void {
  const wsUrl =
    config.bridgeUrl
      .replace(/^https/, "wss")
      .replace(/^http/, "ws")
      .replace(/\/$/, "") + "/phone/stream";

  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function connect() {
    if (stopped) return;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("[twilio-call] connected to channel server");
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(
          typeof event.data === "string" ? event.data : "",
        ) as { type: string; pcm: number[]; callSid: string };

        if (msg.type === "audio" && Array.isArray(msg.pcm)) {
          const text = await stt.transcribePcm(msg.pcm);
          if (text.trim() && ws?.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "transcription",
                text: text.trim(),
                callSid: msg.callSid,
              }),
            );
          }
        }
      } catch (err) {
        console.error("[twilio-call] error processing audio:", err);
      }
    };

    ws.onclose = () => {
      if (!stopped) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

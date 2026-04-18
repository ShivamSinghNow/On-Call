import EventSource from "react-native-sse";
import { config } from "./config";

export interface AskHandlers {
  onToken: (chunk: string) => void;
  onDone: () => void;
  onError: (message: string) => void;
}

export interface AskHandle {
  cancel: () => void;
}

type VoiceBridgeEvent = "token" | "done" | "error";

export function ask(callId: string, text: string, handlers: AskHandlers): AskHandle {
  const url = `${config.bridgeUrl.replace(/\/$/, "")}/ask`;
  const es = new EventSource<VoiceBridgeEvent>(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-token": config.bridgeToken,
    },
    body: JSON.stringify({ callId, text }),
    pollingInterval: 0,
    timeout: 120_000,
  });

  let finished = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    try {
      fn();
    } finally {
      es.removeAllEventListeners();
      es.close();
    }
  };

  es.addEventListener("token", (ev) => {
    if (ev.data) handlers.onToken(ev.data);
  });

  es.addEventListener("done", () => {
    finish(() => handlers.onDone());
  });

  es.addEventListener("error", (ev) => {
    const message =
      "message" in ev && typeof ev.message === "string" && ev.message.length > 0
        ? ev.message
        : "connection error";
    finish(() => handlers.onError(message));
  });

  return {
    cancel: () => {
      finish(() => {});
    },
  };
}

import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import * as Haptics from "expo-haptics";
import { newCallId } from "@voice-bridge/shared";
import { canPressToTalk, initialState, type AppState } from "./src/state";
import { Recorder } from "./src/recording";
import { stt } from "./src/stt";
import { tts } from "./src/tts";
import { ask, type AskHandle } from "./src/ask";

export default function App() {
  const [state, setState] = useState<AppState>(initialState);
  const [modelReady, setModelReady] = useState(false);
  const [modelProgress, setModelProgress] = useState(0);

  const recorderRef = useRef<Recorder>(new Recorder());
  const askHandleRef = useRef<AskHandle | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await stt.init((ratio) => {
          if (!cancelled) setModelProgress(ratio);
        });
        if (!cancelled) setModelReady(true);
      } catch (err) {
        if (!cancelled)
          setState({
            kind: "error",
            message: `STT init failed: ${String((err as Error).message ?? err)}`,
          });
      }
    })();
    return () => {
      cancelled = true;
      askHandleRef.current?.cancel();
      void tts.stop();
    };
  }, []);

  const onPressIn = useCallback(async () => {
    if (!canPressToTalk(state) || !modelReady) return;
    try {
      askHandleRef.current?.cancel();
      await tts.stop();
      const ok = await recorderRef.current.ensurePermission();
      if (!ok) {
        setState({ kind: "error", message: "Microphone permission denied." });
        return;
      }
      await recorderRef.current.start();
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setState({ kind: "recording", startedAt: Date.now() });
    } catch (err) {
      setState({
        kind: "error",
        message: `Recording failed: ${(err as Error).message}`,
      });
    }
  }, [state, modelReady]);

  const onPressOut = useCallback(async () => {
    if (state.kind !== "recording") return;
    setState({ kind: "transcribing" });
    try {
      const uri = await recorderRef.current.stop();
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const transcript = (await stt.transcribe(uri)).trim();
      if (!transcript) {
        setState({ kind: "error", message: "Nothing transcribed. Try again." });
        return;
      }
      await runAsk(transcript);
    } catch (err) {
      setState({
        kind: "error",
        message: `Transcription failed: ${(err as Error).message}`,
      });
    }
  }, [state]);

  const runAsk = useCallback(async (transcript: string) => {
    const callId = newCallId();
    setState({ kind: "awaiting", callId, transcript, reply: "" });

    askHandleRef.current = ask(callId, transcript, {
      onToken: (chunk) => {
        setState((prev) => {
          if (prev.kind !== "awaiting" && prev.kind !== "speaking") return prev;
          const next = prev.reply + chunk;
          void tts.speak(chunk);
          return { ...prev, kind: "speaking", reply: next };
        });
      },
      onDone: () => {
        void tts.flush();
        setState((prev) => {
          if (prev.kind !== "awaiting" && prev.kind !== "speaking") return prev;
          return { kind: "idle" };
        });
      },
      onError: (message) => {
        setState({ kind: "error", message });
      },
    });
  }, []);

  const statusLabel = renderStatus(state, modelReady, modelProgress);
  const pressable = canPressToTalk(state) && modelReady;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Voice Bridge</Text>
      <Text style={styles.subtitle}>Hold to talk to Claude Code</Text>

      <Pressable
        style={[
          styles.talkButton,
          state.kind === "recording" && styles.talkButtonActive,
          !pressable && styles.talkButtonDisabled,
        ]}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        disabled={!pressable}
      >
        <Text style={styles.talkLabel}>
          {state.kind === "recording" ? "LISTENING..." : "HOLD TO TALK"}
        </Text>
      </Pressable>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>{statusLabel}</Text>
        {(state.kind === "awaiting" || state.kind === "speaking") && (
          <View style={styles.transcriptBox}>
            <Text style={styles.transcriptLabel}>You</Text>
            <Text style={styles.transcriptText}>{state.transcript}</Text>
            <Text style={styles.transcriptLabel}>Claude Code</Text>
            <Text style={styles.transcriptText}>
              {state.reply || "thinking..."}
            </Text>
          </View>
        )}
        {state.kind === "error" && (
          <Pressable
            onPress={() => setState({ kind: "idle" })}
            style={styles.resetButton}
          >
            <Text style={styles.resetLabel}>Reset</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function renderStatus(
  s: AppState,
  modelReady: boolean,
  modelProgress: number,
): string {
  if (!modelReady) {
    const pct = Math.round(modelProgress * 100);
    return `Loading on-device STT model... ${pct}%`;
  }
  switch (s.kind) {
    case "idle":
      return "Ready. Press and hold the button to speak.";
    case "recording":
      return "Recording... release to send.";
    case "transcribing":
      return "Transcribing on device...";
    case "awaiting":
      return "Claude Code is thinking...";
    case "speaking":
      return "Claude Code is speaking...";
    case "error":
      return `Error: ${s.message}`;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b0f1a",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  title: {
    color: "#f5f7fa",
    fontSize: 32,
    fontWeight: "700",
    marginBottom: 4,
  },
  subtitle: {
    color: "#8a97b2",
    fontSize: 15,
    marginBottom: 36,
  },
  talkButton: {
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "#2563eb",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#2563eb",
    shadowOpacity: 0.6,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
  },
  talkButtonActive: {
    backgroundColor: "#dc2626",
    shadowColor: "#dc2626",
  },
  talkButtonDisabled: {
    backgroundColor: "#334155",
    shadowOpacity: 0,
  },
  talkLabel: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  statusBox: {
    marginTop: 36,
    alignItems: "center",
    width: "100%",
  },
  statusText: {
    color: "#cbd5e1",
    fontSize: 14,
    textAlign: "center",
  },
  transcriptBox: {
    marginTop: 20,
    width: "100%",
    backgroundColor: "#111827",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1f2937",
  },
  transcriptLabel: {
    color: "#64748b",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: 6,
    marginBottom: 2,
  },
  transcriptText: {
    color: "#e5e7eb",
    fontSize: 15,
    lineHeight: 21,
  },
  resetButton: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: "#334155",
  },
  resetLabel: { color: "white", fontSize: 14, fontWeight: "600" },
});

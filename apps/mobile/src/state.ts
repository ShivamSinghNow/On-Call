export type AppState =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "transcribing" }
  | { kind: "awaiting"; callId: string; transcript: string; reply: string }
  | { kind: "speaking"; callId: string; transcript: string; reply: string }
  | { kind: "error"; message: string };

export const initialState: AppState = { kind: "idle" };

export function canPressToTalk(s: AppState): boolean {
  return s.kind === "idle" || s.kind === "error";
}

import { z } from "zod";

export const CallIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "callId must be URL-safe");

export type CallId = z.infer<typeof CallIdSchema>;

export const AskRequestSchema = z.object({
  callId: CallIdSchema,
  text: z.string().min(1).max(8000),
});

export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskReplyEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type AskReplyEvent = z.infer<typeof AskReplyEventSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  mode: z.enum(["local", "telegram"]),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function newCallId(): CallId {
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36);
  return `${ts}-${rand}`;
}

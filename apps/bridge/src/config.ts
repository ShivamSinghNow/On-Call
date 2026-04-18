import "dotenv/config";
import { z } from "zod";

const EnvSchema = z
  .object({
    BRIDGE_PORT: z.coerce.number().int().positive().default(4000),
    BRIDGE_TOKEN: z.string().min(1).default("dev-secret-change-me"),
    CLAUDE_BRIDGE_MODE: z.enum(["local", "telegram"]).default("local"),
    CLAUDE_LOCAL_URL: z.string().url().default("http://localhost:5055/internal/ask"),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_RELAY_CHAT_ID: z.string().optional(),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    LOG_LEVEL: z
      .enum(["trace", "debug", "info", "warn", "error", "fatal"])
      .default("info"),
  })
  .superRefine((env, ctx) => {
    if (env.CLAUDE_BRIDGE_MODE === "telegram") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TELEGRAM_BOT_TOKEN"],
          message: "TELEGRAM_BOT_TOKEN required when CLAUDE_BRIDGE_MODE=telegram",
        });
      }
      if (!env.TELEGRAM_RELAY_CHAT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TELEGRAM_RELAY_CHAT_ID"],
          message:
            "TELEGRAM_RELAY_CHAT_ID required when CLAUDE_BRIDGE_MODE=telegram",
        });
      }
    }
  });

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

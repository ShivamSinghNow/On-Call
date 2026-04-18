import pino from "pino";
import type { Config } from "./config.js";

export function createLogger(config: Config) {
  const isDev = process.env.NODE_ENV !== "production";
  return pino({
    level: config.LOG_LEVEL,
    transport: isDev
      ? {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        }
      : undefined,
    base: { service: "voice-bridge" },
  });
}

export type Logger = ReturnType<typeof createLogger>;

import type { Config } from "../config.js";
import { createLocalSender } from "./local.js";
import { createTelegramSender } from "./telegram.js";
import type { SendToClaude } from "./types.js";

export function createSendToClaude(config: Config): SendToClaude {
  switch (config.CLAUDE_BRIDGE_MODE) {
    case "local":
      return createLocalSender(config);
    case "telegram":
      return createTelegramSender(config);
  }
}

export type { SendToClaude, ClaudeContext } from "./types.js";

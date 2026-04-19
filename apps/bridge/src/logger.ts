import { pino } from 'pino';
import { loadConfig } from './config.js';

export type Logger = ReturnType<typeof pino>;

let cached: Logger | null = null;

export function getLogger(): Logger {
  if (cached) return cached;
  const config = loadConfig();
  cached = pino({
    level: config.LOG_LEVEL,
    base: { service: 'on-call-bridge' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return cached;
}

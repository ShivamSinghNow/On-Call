/**
 * Bridge server entry point. Wires together:
 *   - Fastify HTTP server (Twilio webhooks, /healthz)
 *   - Fastify WebSocket plugin (Twilio Media Streams, agent socket)
 *   - Telegraf bot client (Telegram → Claude Code)
 *   - In-memory call manager
 */

import Fastify, { type FastifyBaseLogger } from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { loadConfig } from './config.js';
import { getLogger } from './logger.js';
import { AgentConnection } from './agent/connection.js';
import { registerAgentRoute } from './agent/route.js';
import { ClaudeCodeClient } from './telegram/client.js';
import { TwilioCallController } from './twilio/controller.js';
import { CallManager } from './call/manager.js';
import { registerTwilioRoutes } from './twilio/webhook.js';
import { registerTwilioMediaStream } from './twilio/media-stream.js';

const GREETING = 'Connected to your Claude Code session. Go ahead.';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = getLogger();

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
  });

  await app.register(formbody);
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });

  const agent = new AgentConnection(logger.child({ component: 'agent' }));
  const claudeCode = new ClaudeCodeClient({
    botToken: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
    timeoutMs: config.CLAUDE_CODE_TIMEOUT_MS,
    logger,
  });
  const twilioController = new TwilioCallController({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken: config.TWILIO_AUTH_TOKEN,
    publicUrl: config.PUBLIC_URL,
    ttsVoice: config.TWILIO_TTS_VOICE,
    logger,
  });

  const callManager = new CallManager({
    agent,
    claudeCode,
    twilio: twilioController,
    logger: logger.child({ component: 'call-manager' }),
    greeting: GREETING,
  });
  callManager.start();
  await claudeCode.start();

  registerAgentRoute(app, agent, config);
  registerTwilioRoutes(app, callManager, config);
  registerTwilioMediaStream(app, callManager);

  app.get('/healthz', async () => ({
    ok: true,
    agent: {
      connected: agent.isConnected,
      model: agent.currentModel,
    },
    calls: callManager.snapshot(),
  }));

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    callManager.stop();
    await claudeCode.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: '0.0.0.0', port: config.PORT });
  logger.info({ port: config.PORT, publicUrl: config.PUBLIC_URL }, 'bridge listening');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

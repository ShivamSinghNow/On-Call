/**
 * WebSocket endpoint the React Native voice-agent app dials to register itself
 * with the bridge. Authenticated via a pre-shared `?token=` query param.
 */

import type { FastifyInstance } from 'fastify';
import type { AgentConnection } from './connection.js';
import type { Config } from '../config.js';

export function registerAgentRoute(
  app: FastifyInstance,
  agent: AgentConnection,
  config: Config,
): void {
  app.get('/agent', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (token !== config.AGENT_AUTH_TOKEN) {
      app.log.warn({ ip: req.ip }, 'agent auth failed');
      socket.close(4401, 'unauthorized');
      return;
    }
    agent.attach(socket);
  });
}

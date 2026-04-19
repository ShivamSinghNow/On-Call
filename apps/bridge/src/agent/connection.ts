/**
 * Singleton holder for the React Native voice-agent's WebSocket connection.
 *
 * The agent is the *client*; the bridge is the *server*. There is one agent
 * device at a time in V1 (per plan.md §2.1: "A single React Native device can
 * serialize processing — document this limit"), so we just hold a single
 * `WebSocket | null` reference and dispatch all per-call traffic through it.
 *
 * If the agent disconnects, all active calls receive an `AGENT_DISCONNECTED`
 * event so they can wind down.
 */

import type { WebSocket } from 'ws';
import {
  encodeBridgeToAgent,
  type BridgeToAgentMessage,
  type AgentToBridgeMessage,
  decodeAgentToBridge,
} from '@on-call/shared';
import type { Logger } from '../logger.js';

export type AgentMessageHandler = (msg: AgentToBridgeMessage) => void;
export type AgentDisconnectHandler = () => void;

export class AgentConnection {
  private socket: WebSocket | null = null;
  private model: string | null = null;
  private platform: 'ios' | 'android' | 'macos' | 'unknown' = 'unknown';
  private readonly messageHandlers: AgentMessageHandler[] = [];
  private readonly disconnectHandlers: AgentDisconnectHandler[] = [];
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  /** True when an authenticated agent is currently connected. */
  get isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === 1; // WebSocket.OPEN
  }

  /** Currently-loaded model on the connected agent, if any. */
  get currentModel(): string | null {
    return this.model;
  }

  attach(socket: WebSocket): void {
    if (this.socket !== null) {
      // Already connected — boot the old socket so the new one wins.
      this.logger.warn('agent already connected; replacing existing connection');
      try {
        this.socket.close(4000, 'replaced by new connection');
      } catch {
        // ignore
      }
      this.detachInternal({ notify: false });
    }

    this.socket = socket;
    this.logger.info('agent connected');

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      let msg: AgentToBridgeMessage;
      try {
        msg = decodeAgentToBridge(text);
      } catch (err) {
        this.logger.warn({ err, text: text.slice(0, 200) }, 'invalid agent message');
        return;
      }

      if (msg.type === 'agent_ready') {
        this.model = msg.model;
        this.platform = msg.platform;
        this.logger.info({ model: msg.model, platform: msg.platform }, 'agent ready');
        return;
      }

      if (msg.type === 'pong') {
        // Heartbeat response — just observe.
        return;
      }

      for (const handler of this.messageHandlers) {
        try {
          handler(msg);
        } catch (err) {
          this.logger.error({ err }, 'agent message handler threw');
        }
      }
    });

    socket.on('close', (code, reason) => {
      this.logger.warn({ code, reason: reason?.toString() }, 'agent disconnected');
      this.detachInternal({ notify: true });
    });

    socket.on('error', (err) => {
      this.logger.error({ err }, 'agent socket error');
    });

    this.startHeartbeat();
  }

  /** Send a message to the agent. Returns false if the agent is not connected. */
  send(msg: BridgeToAgentMessage): boolean {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(encodeBridgeToAgent(msg));
      return true;
    } catch (err) {
      this.logger.error({ err, msgType: msg.type }, 'failed to send to agent');
      return false;
    }
  }

  onMessage(handler: AgentMessageHandler): () => void {
    this.messageHandlers.push(handler);
    return () => {
      const i = this.messageHandlers.indexOf(handler);
      if (i >= 0) this.messageHandlers.splice(i, 1);
    };
  }

  onDisconnect(handler: AgentDisconnectHandler): () => void {
    this.disconnectHandlers.push(handler);
    return () => {
      const i = this.disconnectHandlers.indexOf(handler);
      if (i >= 0) this.disconnectHandlers.splice(i, 1);
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.send({ type: 'ping', ts: Date.now() });
    }, 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private detachInternal(opts: { notify: boolean }): void {
    this.socket = null;
    this.model = null;
    this.platform = 'unknown';
    this.stopHeartbeat();
    if (opts.notify) {
      for (const handler of this.disconnectHandlers) {
        try {
          handler();
        } catch (err) {
          this.logger.error({ err }, 'agent disconnect handler threw');
        }
      }
    }
  }
}

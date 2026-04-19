/**
 * Persistent WebSocket client to the bridge server.
 *
 * Responsibilities:
 *   - Reconnect with exponential backoff.
 *   - Buffer inbound `audio` chunks per callSid until `utterance_end` arrives,
 *     then hand the assembled PCM to the VoiceAgent for inference.
 *   - Send back agent_decision / agent_progress / agent_ready / error frames.
 *
 * NOTE: This module assumes one VoiceAgent instance (one call at a time).
 * Multi-call support is a Phase 3 concern per plan.md.
 */

import { Platform } from 'react-native';
import {
  decodeBridgeToAgent,
  encodeAgentToBridge,
  type BridgeToAgentMessage,
  type AgentToBridgeMessage,
} from '@on-call/shared';
import type { VoiceAgent } from './voice-agent';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

export interface BridgeClientOptions {
  url: string;
  authToken: string;
  agent: VoiceAgent;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onCallStart?: (callSid: string) => void;
  onCallEnd?: (callSid: string) => void;
  onDecision?: (callSid: string, action: string, text: string) => void;
}

export class BridgeClient {
  private socket: WebSocket | null = null;
  private opts: BridgeClientOptions;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Per-call PCM buffer (samples accumulate across `audio` frames). */
  private pcmBuffers = new Map<string, number[]>();
  private stopped = false;

  constructor(opts: BridgeClientOptions) {
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close(1000, 'client stop');
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.pcmBuffers.clear();
  }

  private connect(): void {
    if (this.stopped) return;
    const url = `${this.opts.url}?token=${encodeURIComponent(this.opts.authToken)}`;
    this.opts.onStatus?.('connecting');
    const ws = new WebSocket(url);
    this.socket = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onStatus?.('open');
      this.sendReady();
    };

    ws.onmessage = (ev: WebSocketMessageEvent) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      let msg: BridgeToAgentMessage;
      try {
        msg = decodeBridgeToAgent(raw);
      } catch {
        return;
      }
      void this.handleMessage(msg);
    };

    ws.onerror = () => {
      this.opts.onStatus?.('error', 'websocket error');
    };

    ws.onclose = (ev: WebSocketCloseEvent) => {
      this.socket = null;
      this.pcmBuffers.clear();
      if (this.stopped) return;
      const detail = ev.reason || `code ${ev.code}`;
      this.opts.onStatus?.('reconnecting', detail);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1_000 * Math.pow(2, this.reconnectAttempt - 1));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private async handleMessage(msg: BridgeToAgentMessage): Promise<void> {
    switch (msg.type) {
      case 'call_start': {
        await this.opts.agent.reset();
        this.pcmBuffers.set(msg.callSid, []);
        this.opts.onCallStart?.(msg.callSid);
        break;
      }
      case 'audio': {
        const buf = this.pcmBuffers.get(msg.callSid);
        if (!buf) return;
        for (let i = 0; i < msg.pcm.length; i++) buf.push(msg.pcm[i]!);
        break;
      }
      case 'utterance_end': {
        const buf = this.pcmBuffers.get(msg.callSid);
        if (!buf || buf.length === 0) return;
        const pcm = buf.slice();
        this.pcmBuffers.set(msg.callSid, []);
        try {
          const decision = await this.opts.agent.processUtterance(pcm, (token) => {
            this.send({
              type: 'agent_progress',
              callSid: msg.callSid,
              partialText: token,
            });
          });
          this.send({
            type: 'agent_decision',
            callSid: msg.callSid,
            action: decision.action,
            text: decision.text,
            confidence: decision.confidence,
            latencyMs: decision.latencyMs,
          });
          this.opts.onDecision?.(msg.callSid, decision.action, decision.text);
        } catch (err) {
          this.send({
            type: 'error',
            callSid: msg.callSid,
            message: err instanceof Error ? err.message : 'agent failure',
          });
        }
        break;
      }
      case 'call_end': {
        this.pcmBuffers.delete(msg.callSid);
        await this.opts.agent.reset();
        this.opts.onCallEnd?.(msg.callSid);
        break;
      }
      case 'ping': {
        this.send({ type: 'pong', ts: msg.ts });
        break;
      }
    }
  }

  private send(msg: AgentToBridgeMessage): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    try {
      this.socket.send(encodeAgentToBridge(msg));
    } catch {
      // best-effort
    }
  }

  private sendReady(): void {
    const platform: 'ios' | 'android' | 'macos' | 'unknown' =
      Platform.OS === 'ios'
        ? 'ios'
        : Platform.OS === 'android'
          ? 'android'
          : Platform.OS === 'macos'
            ? 'macos'
            : 'unknown';
    this.send({
      type: 'agent_ready',
      model: this.opts.agent.modelName,
      platform,
    });
  }
}

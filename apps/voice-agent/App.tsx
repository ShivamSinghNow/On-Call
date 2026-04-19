/**
 * Headless voice-agent host. The app's only UI is a status panel for
 * debugging — per plan.md §2.3 the app's job is to host Cactus + Gemma 4
 * and shuttle data over a WebSocket, not to be looked at.
 *
 * Lifecycle:
 *   1. Read config (bridge URL, auth token, model slug).
 *   2. Construct VoiceAgent (Cactus + Gemma 4).
 *   3. Download weights (~once, persisted).
 *   4. Initialize the runtime.
 *   5. Open a persistent WebSocket to the bridge; reconnect with backoff.
 *   6. Keep the screen awake so iOS/Android don't suspend us mid-call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { loadAppConfig } from './src/config';
import { VoiceAgent } from './src/voice-agent';
import { BridgeClient, type ConnectionStatus } from './src/bridge-client';

interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export default function App() {
  useKeepAwake();

  const [bootError, setBootError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadDone, setDownloadDone] = useState(false);
  const [agentReady, setAgentReady] = useState(false);
  const [connection, setConnection] = useState<ConnectionStatus>('idle');
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const agentRef = useRef<VoiceAgent | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);

  const log = useCallback((level: LogLine['level'], msg: string) => {
    setLogs((prev) => [{ ts: Date.now(), level, msg }, ...prev].slice(0, 100));
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      let config;
      try {
        config = loadAppConfig();
      } catch (err) {
        setBootError(err instanceof Error ? err.message : String(err));
        return;
      }

      const agent = new VoiceAgent({
        modelPath: config.gemmaModelPath,
        mmprojPath: config.gemmaMmprojPath,
      });
      agentRef.current = agent;
      log('info', `Loading model ${config.gemmaModelPath}…`);

      try {
        await agent.ensureReady((p) => {
          if (cancelled) return;
          setDownloadProgress(p);
          if (p >= 1) setDownloadDone(true);
        });
        if (cancelled) return;
        setDownloadDone(true);
        setAgentReady(true);
        log('info', `Model ready: ${agent.modelName}`);
      } catch (err) {
        log('error', `Model init failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      const client = new BridgeClient({
        url: config.bridgeWsUrl,
        authToken: config.agentAuthToken,
        agent,
        onStatus: (status, detail) => {
          if (cancelled) return;
          setConnection(status);
          setConnectionDetail(detail ?? null);
          log('info', `WS: ${status}${detail ? ` (${detail})` : ''}`);
        },
        onCallStart: (callSid) => {
          if (cancelled) return;
          setActiveCall(callSid);
          setLastDecision(null);
          log('info', `Call start: ${callSid}`);
        },
        onCallEnd: (callSid) => {
          if (cancelled) return;
          setActiveCall(null);
          log('info', `Call end: ${callSid}`);
        },
        onDecision: (_callSid, action, text) => {
          if (cancelled) return;
          setLastDecision(`${action}: ${text}`);
          log('info', `Decision ${action}: ${text.slice(0, 60)}`);
        },
      });
      clientRef.current = client;
      client.start();
    })();

    return () => {
      cancelled = true;
      clientRef.current?.stop();
      clientRef.current = null;
      void agentRef.current?.destroy();
      agentRef.current = null;
    };
  }, [log]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>On-Call · Voice Agent</Text>

      {bootError && (
        <View style={[styles.row, styles.error]}>
          <Text style={styles.errorText}>{bootError}</Text>
        </View>
      )}

      <View style={styles.row}>
        <Text style={styles.label}>Model</Text>
        {!downloadDone ? (
          <Text style={styles.value}>
            Downloading… {Math.round(downloadProgress * 100)}%
          </Text>
        ) : agentReady ? (
          <Text style={styles.value}>{agentRef.current?.modelName ?? 'ready'}</Text>
        ) : (
          <ActivityIndicator />
        )}
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Bridge</Text>
        <Text style={styles.value}>
          {connection}
          {connectionDetail ? ` · ${connectionDetail}` : ''}
        </Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Active call</Text>
        <Text style={styles.value}>{activeCall ?? 'none'}</Text>
      </View>

      <View style={styles.row}>
        <Text style={styles.label}>Last decision</Text>
        <Text style={styles.value}>{lastDecision ?? '—'}</Text>
      </View>

      <Text style={[styles.label, styles.logHeader]}>Recent log</Text>
      <ScrollView style={styles.logBox}>
        {logs.map((line) => (
          <Text
            key={`${line.ts}-${line.msg}`}
            style={[
              styles.logLine,
              line.level === 'warn'
                ? styles.logWarn
                : line.level === 'error'
                  ? styles.logError
                  : null,
            ]}
          >
            {formatTs(line.ts)}  {line.msg}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  title: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 24,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomColor: '#222',
    borderBottomWidth: 1,
  },
  label: {
    color: '#888',
    fontSize: 13,
  },
  value: {
    color: '#fff',
    fontSize: 13,
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 12,
  },
  logHeader: {
    marginTop: 24,
    marginBottom: 8,
  },
  logBox: {
    flex: 1,
    backgroundColor: '#111',
    borderRadius: 8,
    padding: 10,
  },
  logLine: {
    color: '#bbb',
    fontFamily: 'Menlo',
    fontSize: 11,
    marginBottom: 3,
  },
  logWarn: {
    color: '#f5d76e',
  },
  logError: {
    color: '#ff7373',
  },
  error: {
    backgroundColor: '#3a0a0a',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  errorText: {
    color: '#ffb3b3',
    fontSize: 13,
  },
});

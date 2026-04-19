import Constants from 'expo-constants';

interface AppConfig {
  bridgeWsUrl: string;
  agentAuthToken: string;
  /** URL or on-device absolute path to the Gemma 4 GGUF weights. */
  gemmaModelPath: string;
  /** URL or on-device absolute path to the multimodal projector file. */
  gemmaMmprojPath: string;
}

function readExtra(): Partial<AppConfig> {
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  return {
    bridgeWsUrl: typeof extra.bridgeWsUrl === 'string' ? extra.bridgeWsUrl : undefined,
    agentAuthToken:
      typeof extra.agentAuthToken === 'string' ? extra.agentAuthToken : undefined,
    gemmaModelPath:
      typeof extra.gemmaModelPath === 'string' ? extra.gemmaModelPath : undefined,
    gemmaMmprojPath:
      typeof extra.gemmaMmprojPath === 'string' ? extra.gemmaMmprojPath : undefined,
  };
}

export function loadAppConfig(): AppConfig {
  const extra = readExtra();
  const bridgeWsUrl =
    process.env.EXPO_PUBLIC_BRIDGE_WS_URL ?? extra.bridgeWsUrl ?? '';
  const agentAuthToken =
    process.env.EXPO_PUBLIC_AGENT_AUTH_TOKEN ?? extra.agentAuthToken ?? '';
  const gemmaModelPath =
    process.env.EXPO_PUBLIC_GEMMA_MODEL_PATH ?? extra.gemmaModelPath ?? '';
  const gemmaMmprojPath =
    process.env.EXPO_PUBLIC_GEMMA_MMPROJ_PATH ?? extra.gemmaMmprojPath ?? '';

  const required: Array<[string, string]> = [
    ['EXPO_PUBLIC_BRIDGE_WS_URL', bridgeWsUrl],
    ['EXPO_PUBLIC_AGENT_AUTH_TOKEN', agentAuthToken],
    ['EXPO_PUBLIC_GEMMA_MODEL_PATH', gemmaModelPath],
    ['EXPO_PUBLIC_GEMMA_MMPROJ_PATH', gemmaMmprojPath],
  ];
  for (const [name, value] of required) {
    if (!value || value.startsWith('${')) {
      throw new Error(`${name} is not set. Configure it via .env or app.json.`);
    }
  }

  return { bridgeWsUrl, agentAuthToken, gemmaModelPath, gemmaMmprojPath };
}

const rawUrl = process.env.EXPO_PUBLIC_BRIDGE_URL;
const rawToken = process.env.EXPO_PUBLIC_BRIDGE_TOKEN;

if (!rawUrl) {
  console.warn(
    "[voice-bridge] EXPO_PUBLIC_BRIDGE_URL is not set. " +
      "Copy .env.example to .env and set it to your bridge URL (e.g. http://192.168.1.10:4000).",
  );
}

export const config = {
  bridgeUrl: rawUrl ?? "http://localhost:4000",
  bridgeToken: rawToken ?? "dev-secret-change-me",
};

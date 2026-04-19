/**
 * Write 16-bit signed PCM samples to a temp WAV file on disk so Cactus can
 * ingest them as a multimodal file path. Uses expo-file-system's cache dir.
 */

import * as FileSystem from 'expo-file-system';

export const DEFAULT_PCM_SAMPLE_RATE = 16_000;

/** Encode 16-bit PCM mono into a Base64-encoded WAV (header + samples). */
function encodeWavBase64(pcm: number[], sampleRate: number): string {
  const bytesPerSample = 2;
  const numChannels = 1;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * bytesPerSample;
  const totalSize = 44 + dataSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  let offset = 0;

  writeString(view, offset, 'RIFF'); offset += 4;
  view.setUint32(offset, totalSize - 8, true); offset += 4;
  writeString(view, offset, 'WAVE'); offset += 4;

  writeString(view, offset, 'fmt '); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;        // fmt chunk size
  view.setUint16(offset, 1, true); offset += 2;         // PCM
  view.setUint16(offset, numChannels, true); offset += 2;
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, byteRate, true); offset += 4;
  view.setUint16(offset, blockAlign, true); offset += 2;
  view.setUint16(offset, bytesPerSample * 8, true); offset += 2;

  writeString(view, offset, 'data'); offset += 4;
  view.setUint32(offset, dataSize, true); offset += 4;

  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-32768, Math.min(32767, pcm[i] ?? 0));
    view.setInt16(offset, s, true);
    offset += 2;
  }

  return arrayBufferToBase64(buffer);
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary);
  return base64EncodeFallback(binary);
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64EncodeFallback(input: string): string {
  let output = '';
  for (let i = 0; i < input.length; i += 3) {
    const a = input.charCodeAt(i);
    const b = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const c = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    const t = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
    output += B64_CHARS[(t >> 18) & 0x3f] ?? '';
    output += B64_CHARS[(t >> 12) & 0x3f] ?? '';
    output += isNaN(b) ? '=' : (B64_CHARS[(t >> 6) & 0x3f] ?? '');
    output += isNaN(c) ? '=' : (B64_CHARS[t & 0x3f] ?? '');
  }
  return output;
}

/** Write PCM to a fresh WAV file; returns the absolute path. */
export async function writePcmAsWav(pcm: number[], sampleRate: number): Promise<string> {
  const dir = FileSystem.cacheDirectory ?? `${FileSystem.documentDirectory ?? ''}cache/`;
  const path = `${dir}utterance-${Date.now()}.wav`;
  const base64 = encodeWavBase64(pcm, sampleRate);
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return path;
}

/** Best-effort delete of a WAV we created with writePcmAsWav. */
export async function cleanupWavFile(path: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(path, { idempotent: true });
  } catch {
    // best-effort
  }
}

/**
 * G.711 µ-law (mulaw) ↔ 16-bit signed PCM conversion.
 *
 * Twilio Media Streams emits 8 kHz µ-law mono. The voice-agent app wants
 * 16-bit signed PCM (16 kHz mono after resampling).
 *
 * Reference: ITU-T G.711, plus the canonical implementation by Sun Microsystems
 * (the de-facto algorithm used by every audio library that handles G.711).
 */

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

/** Decode one µ-law byte to a signed 16-bit PCM sample. */
export function mulawDecodeSample(mulawByte: number): number {
  const u = ~mulawByte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/** Encode one signed 16-bit PCM sample to a µ-law byte. */
export function mulawEncodeSample(pcmSample: number): number {
  let sample = pcmSample;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

/** Decode a buffer of µ-law bytes to an Int16Array of PCM samples. */
export function mulawDecode(mulaw: Uint8Array): Int16Array {
  const out = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    out[i] = mulawDecodeSample(mulaw[i]!);
  }
  return out;
}

/** Encode an Int16Array of PCM samples to a Uint8Array of µ-law bytes. */
export function mulawEncode(pcm: Int16Array): Uint8Array {
  const out = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = mulawEncodeSample(pcm[i]!);
  }
  return out;
}

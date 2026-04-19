/**
 * Simple sample-rate conversion between 8 kHz (Twilio mulaw) and 16 kHz
 * (Cactus / Gemma 4 PCM).
 *
 * For 8 → 16 kHz we use linear interpolation, which is good enough for speech
 * being fed into a multimodal LLM. If quality becomes a concern, swap in a
 * proper polyphase filter (e.g. `libsamplerate` via WASM).
 */

/** Linear-interpolate-upsample by an integer factor (e.g. 2 for 8k → 16k). */
export function upsampleLinear(input: Int16Array, factor: number): Int16Array {
  if (factor < 1 || !Number.isInteger(factor)) {
    throw new RangeError(`upsample factor must be a positive integer, got ${factor}`);
  }
  if (factor === 1) return input.slice();

  const out = new Int16Array(input.length * factor);
  for (let i = 0; i < input.length - 1; i++) {
    const a = input[i]!;
    const b = input[i + 1]!;
    for (let j = 0; j < factor; j++) {
      const t = j / factor;
      out[i * factor + j] = Math.round(a + (b - a) * t);
    }
  }
  // Tail: pad with the last sample.
  const last = input[input.length - 1] ?? 0;
  for (let j = 0; j < factor; j++) {
    out[(input.length - 1) * factor + j] = last;
  }
  return out;
}

/** Decimate by an integer factor (e.g. 2 for 16k → 8k). Crude but fine for speech. */
export function downsampleAverage(input: Int16Array, factor: number): Int16Array {
  if (factor < 1 || !Number.isInteger(factor)) {
    throw new RangeError(`downsample factor must be a positive integer, got ${factor}`);
  }
  if (factor === 1) return input.slice();

  const outLen = Math.floor(input.length / factor);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) {
      sum += input[i * factor + j]!;
    }
    out[i] = Math.round(sum / factor);
  }
  return out;
}

/** Convenience: 8 kHz → 16 kHz upsample. */
export function upsample8kTo16k(input: Int16Array): Int16Array {
  return upsampleLinear(input, 2);
}

/** Convenience: 16 kHz → 8 kHz downsample. */
export function downsample16kTo8k(input: Int16Array): Int16Array {
  return downsampleAverage(input, 2);
}

/** Convert an Int16Array to a plain number[] for JSON serialization. */
export function int16ToArray(samples: Int16Array): number[] {
  const out: number[] = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]!;
  return out;
}

/** Convert a plain number[] (received over JSON) back to an Int16Array. */
export function arrayToInt16(samples: number[]): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]!;
  return out;
}

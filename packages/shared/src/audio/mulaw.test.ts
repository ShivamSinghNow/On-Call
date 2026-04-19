import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulawDecodeSample, mulawEncodeSample, mulawDecode, mulawEncode } from './mulaw.js';

describe('mulaw codec', () => {
  it('round-trips silence', () => {
    const silenceMulaw = 0xff;
    assert.equal(mulawDecodeSample(silenceMulaw), 0);
    assert.equal(mulawEncodeSample(0), silenceMulaw);
  });

  it('round-trips small positive samples within mulaw quantization error', () => {
    // mulaw is logarithmic, so we test that re-encoding stays close.
    for (const sample of [128, 512, 2048, 8192, 16384, 30000]) {
      const encoded = mulawEncodeSample(sample);
      const decoded = mulawDecodeSample(encoded);
      // Mulaw quantization error grows with magnitude; allow ~10% relative error.
      const err = Math.abs(decoded - sample) / sample;
      assert.ok(err < 0.12, `${sample} → ${decoded} (err=${err.toFixed(3)})`);
    }
  });

  it('round-trips small negative samples', () => {
    for (const sample of [-128, -512, -2048, -8192, -16384, -30000]) {
      const encoded = mulawEncodeSample(sample);
      const decoded = mulawDecodeSample(encoded);
      const err = Math.abs(decoded - sample) / Math.abs(sample);
      assert.ok(err < 0.12, `${sample} → ${decoded} (err=${err.toFixed(3)})`);
    }
  });

  it('clips above the mulaw maximum', () => {
    const big = mulawEncodeSample(50_000);
    const decoded = mulawDecodeSample(big);
    assert.ok(decoded <= 32_767);
    assert.ok(decoded > 30_000);
  });

  it('processes whole buffers', () => {
    const pcm = new Int16Array([0, 100, -100, 1000, -1000, 16000, -16000]);
    const mulaw = mulawEncode(pcm);
    assert.equal(mulaw.length, pcm.length);
    const decoded = mulawDecode(mulaw);
    assert.equal(decoded.length, pcm.length);
    assert.equal(decoded[0], 0);
  });
});

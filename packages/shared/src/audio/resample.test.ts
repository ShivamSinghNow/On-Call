import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { upsample8kTo16k, downsample16kTo8k, upsampleLinear } from './resample.js';

describe('resampler', () => {
  it('upsample doubles length for factor 2', () => {
    const input = new Int16Array([0, 100, 200, 300]);
    const out = upsample8kTo16k(input);
    assert.equal(out.length, input.length * 2);
  });

  it('upsample interpolates between samples', () => {
    const input = new Int16Array([0, 100]);
    const out = upsampleLinear(input, 2);
    assert.equal(out[0], 0);
    assert.equal(out[1], 50);
  });

  it('downsample halves length for factor 2', () => {
    const input = new Int16Array([0, 100, 200, 300, 400, 500]);
    const out = downsample16kTo8k(input);
    assert.equal(out.length, 3);
    assert.equal(out[0], 50);
    assert.equal(out[1], 250);
    assert.equal(out[2], 450);
  });

  it('rejects non-integer factors', () => {
    assert.throws(() => upsampleLinear(new Int16Array([1, 2]), 1.5), RangeError);
  });
});

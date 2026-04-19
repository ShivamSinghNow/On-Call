import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnergyVad } from './vad.js';

function makeSilence(samples: number): Int16Array {
  return new Int16Array(samples);
}

function makeTone(samples: number, amplitude = 5000): Int16Array {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16_000));
  }
  return out;
}

describe('EnergyVad', () => {
  it('emits no events for pure silence', () => {
    const vad = new EnergyVad();
    const events = vad.process(makeSilence(16_000)); // 1s silence
    assert.equal(events.length, 0);
    assert.equal(vad.isSpeaking, false);
  });

  it('detects speech start when audio crosses the threshold', () => {
    const vad = new EnergyVad();
    const events = vad.process(makeTone(8_000)); // 500 ms of tone
    const start = events.find((e) => e.type === 'speech_start');
    assert.ok(start, 'expected a speech_start event');
    assert.equal(vad.isSpeaking, true);
  });

  it('emits speech_end after a tone followed by silence', () => {
    const vad = new EnergyVad();
    vad.process(makeTone(16_000)); // 1s of speech (well past minSpeechMs=250)
    const events = vad.process(makeSilence(16_000)); // 1s of silence (past silenceMs=700)
    const end = events.find((e) => e.type === 'speech_end');
    assert.ok(end, 'expected a speech_end event');
    if (end && end.type === 'speech_end') {
      assert.ok(end.durationMs > 0);
    }
    assert.equal(vad.isSpeaking, false);
  });

  it('force-flushes utterances longer than maxUtteranceMs', () => {
    const vad = new EnergyVad({ maxUtteranceMs: 500 });
    const events = vad.process(makeTone(16_000)); // 1s straight, no silence
    const flush = events.find((e) => e.type === 'force_flush');
    assert.ok(flush, 'expected a force_flush event');
  });

  it('reset clears state', () => {
    const vad = new EnergyVad();
    vad.process(makeTone(8_000));
    vad.reset();
    assert.equal(vad.isSpeaking, false);
  });
});

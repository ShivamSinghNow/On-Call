import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CallStateMachine, type CallEffect } from './state.js';

function newMachine() {
  return new CallStateMachine({ callSid: 'CA123', greeting: 'Connected. Go ahead.' });
}

function effectTypes(effects: CallEffect[]): string[] {
  return effects.map((e) => e.type);
}

describe('CallStateMachine', () => {
  it('answers a call by greeting and notifying the agent', () => {
    const m = newMachine();
    const effects = m.handle({ type: 'CALL_ANSWERED', from: '+15555550100' });
    assert.deepEqual(effectTypes(effects), ['send_call_start_to_agent', 'speak_text']);
    assert.equal(m.currentState, 'SPEAKING');
    assert.equal(m.lastSpoken, 'Connected. Go ahead.');
  });

  it('drops audio chunks while speaking', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    const effects = m.handle({ type: 'AUDIO_CHUNK', pcm: new Int16Array(160) });
    assert.equal(effects.length, 0);
  });

  it('forwards audio while listening', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    const effects = m.handle({ type: 'AUDIO_CHUNK', pcm: new Int16Array(160) });
    assert.deepEqual(effectTypes(effects), ['send_audio_to_agent']);
  });

  it('captures a complete utterance and asks for follow-up', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    m.handle({ type: 'SPEECH_START' });
    assert.equal(m.currentState, 'BUFFERING_UTTERANCE');

    const endEffects = m.handle({ type: 'SPEECH_END', durationMs: 1500 });
    assert.deepEqual(effectTypes(endEffects), ['send_utterance_end_to_agent']);
    assert.equal(m.currentState, 'SENT_TO_AGENT');

    const decisionEffects = m.handle({
      type: 'AGENT_DECISION',
      action: 'ask_followup',
      text: 'What language is the project in?',
    });
    assert.deepEqual(effectTypes(decisionEffects), ['speak_text']);
    assert.equal(m.currentState, 'SPEAKING');
  });

  it('forwards a finalized prompt to Claude Code and waits', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    m.handle({ type: 'SPEECH_START' });
    m.handle({ type: 'SPEECH_END', durationMs: 2000 });

    const effects = m.handle({
      type: 'AGENT_DECISION',
      action: 'forward_to_claude_code',
      text: 'My pod is OOMKilled. Help diagnose.',
    });
    assert.deepEqual(effectTypes(effects), ['forward_to_claude_code']);
    assert.equal(m.currentState, 'AWAITING_CLAUDE');
  });

  it('speaks Claude reply when it arrives', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    m.handle({ type: 'SPEECH_START' });
    m.handle({ type: 'SPEECH_END', durationMs: 2000 });
    m.handle({ type: 'AGENT_DECISION', action: 'forward_to_claude_code', text: 'Help.' });

    const effects = m.handle({ type: 'CLAUDE_REPLY', text: 'Increase memory limits.' });
    assert.deepEqual(effectTypes(effects), ['speak_text']);
    assert.equal(m.currentState, 'SPEAKING');
    assert.equal(m.lastSpoken, 'Increase memory limits.');
  });

  it('returns to listening after TTS finishes', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    assert.equal(m.currentState, 'LISTENING');
  });

  it('handles agent abort', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    m.handle({ type: 'SPEECH_START' });
    m.handle({ type: 'SPEECH_END', durationMs: 800 });

    const effects = m.handle({
      type: 'AGENT_DECISION',
      action: 'abort',
      text: "I can't help with that — goodbye.",
    });
    assert.deepEqual(effectTypes(effects), [
      'speak_text',
      'end_call',
      'send_call_end_to_agent',
    ]);
    assert.equal(m.currentState, 'CLEANUP');
  });

  it('hangup tears down cleanly', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    const effects = m.handle({ type: 'HANGUP' });
    assert.deepEqual(effectTypes(effects), ['send_call_end_to_agent', 'end_call']);
    assert.equal(m.currentState, 'CLEANUP');
  });

  it('agent disconnect ends the call gracefully', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    const effects = m.handle({ type: 'AGENT_DISCONNECTED' });
    assert.deepEqual(effectTypes(effects), ['speak_text', 'end_call']);
    assert.equal(m.currentState, 'CLEANUP');
  });

  it('claude timeout speaks a filler without changing state', () => {
    const m = newMachine();
    m.handle({ type: 'CALL_ANSWERED' });
    m.handle({ type: 'TTS_FINISHED' });
    m.handle({ type: 'SPEECH_START' });
    m.handle({ type: 'SPEECH_END', durationMs: 2000 });
    m.handle({ type: 'AGENT_DECISION', action: 'forward_to_claude_code', text: 'Help.' });

    const effects = m.handle({ type: 'CLAUDE_TIMEOUT' });
    assert.deepEqual(effectTypes(effects), ['speak_text']);
    assert.equal(m.currentState, 'AWAITING_CLAUDE'); // still waiting
  });
});

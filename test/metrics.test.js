import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, rms, TurnTracker } from '../public/metrics.js';

test('percentile: nearest-rank', () => {
  assert.equal(percentile([100, 200, 300, 400], 50), 200);
  assert.equal(percentile([400, 100, 300, 200], 95), 400);
  assert.equal(percentile([42], 95), 42);
});

test('percentile: empty and null values', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([null, undefined, NaN], 50), null);
  assert.equal(percentile([null, 300, 100], 50), 100);
});

test('rms', () => {
  assert.equal(rms(new Float32Array([0, 0, 0])), 0);
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
  assert.equal(rms(new Float32Array([])), 0);
});

test('summarize: counts and percentiles', () => {
  const turns = [
    { eventLatencyMs: 400, acousticLatencyMs: 900, interrupted: false, bargeInStopMs: null },
    { eventLatencyMs: 600, acousticLatencyMs: 1100, interrupted: true, bargeInStopMs: 250 },
  ];
  assert.deepEqual(summarize(turns), {
    turns: 2,
    interruptions: 1,
    eventLatencyMs: { p50: 400, p95: 600 },
    acousticLatencyMs: { p50: 900, p95: 1100 },
    bargeInStopMs: { p50: 250, p95: 250 },
  });
});

// Feeds levels every 20 ms over [from, to).
function feed(tracker, from, to, micRms, botRms) {
  for (let t = from; t < to; t += 20) tracker.levels(t, micRms, botRms);
}

test('TurnTracker: event and acoustic latency', () => {
  const tr = new TurnTracker();
  feed(tr, 0, 1020, 0.1, 0);      // user speaks, last loud frame at 1000
  feed(tr, 1020, 1500, 0, 0);     // silence
  tr.event(1500, 'input_audio_buffer.speech_stopped');
  feed(tr, 1500, 1900, 0, 0);
  tr.event(1900, 'output_audio_buffer.started');
  tr.levels(1950, 0, 0.1);        // first bot sound
  const [turn] = tr.turns;
  assert.equal(tr.turns.length, 1);
  assert.equal(turn.eventLatencyMs, 400);
  assert.equal(turn.acousticLatencyMs, 950);
  assert.equal(turn.interrupted, false);
});

test('TurnTracker: barge-in marks turn and measures stop time', () => {
  const tr = new TurnTracker();
  feed(tr, 0, 500, 0.1, 0);
  tr.event(600, 'input_audio_buffer.speech_stopped');
  tr.event(900, 'output_audio_buffer.started');
  feed(tr, 1000, 2500, 0, 0.1);           // bot speaks
  feed(tr, 2500, 2820, 0.1, 0.1);         // user starts at 2500, bot still audible until 2800
  tr.event(2700, 'input_audio_buffer.speech_started');
  feed(tr, 2820, 3100, 0.1, 0);           // bot silent
  const [turn] = tr.turns;
  assert.equal(turn.interrupted, true);
  assert.equal(turn.bargeInStopMs, 300);  // 2800 - 2500
});

test('TurnTracker: speech_started while bot is silent is not a barge-in', () => {
  const tr = new TurnTracker();
  tr.event(100, 'input_audio_buffer.speech_stopped');
  feed(tr, 200, 1000, 0, 0.1);
  feed(tr, 1000, 2000, 0, 0);             // bot finished long ago
  tr.event(2000, 'input_audio_buffer.speech_started');
  assert.equal(tr.turns[0].interrupted, false);
  assert.equal(tr.turns[0].bargeInStopMs, null);
});

test('TurnTracker: output_audio_buffer.cleared marks interruption', () => {
  const tr = new TurnTracker();
  tr.event(100, 'input_audio_buffer.speech_stopped');
  tr.event(300, 'output_audio_buffer.cleared');
  assert.equal(tr.turns[0].interrupted, true);
});

test('TurnTracker: events without a turn do not throw', () => {
  const tr = new TurnTracker();
  tr.event(0, 'output_audio_buffer.started');
  tr.event(0, 'output_audio_buffer.cleared');
  tr.event(0, 'input_audio_buffer.speech_started');
  assert.equal(tr.turns.length, 0);
});

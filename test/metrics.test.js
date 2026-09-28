import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize, rms } from '../public/metrics.js';

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

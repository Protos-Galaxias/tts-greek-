// Pure metric logic: shared by the browser (app.js) and node --test.

export const SPEECH_RMS = 0.02;
export const BOT_SILENCE_MS = 200;

export function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

export function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const idx = Math.max(0, Math.ceil((p / 100) * nums.length) - 1);
  return nums[idx];
}

const stats = (values) => ({ p50: percentile(values, 50), p95: percentile(values, 95) });

export function summarize(turns) {
  return {
    turns: turns.length,
    interruptions: turns.filter((t) => t.interrupted).length,
    eventLatencyMs: stats(turns.map((t) => t.eventLatencyMs)),
    acousticLatencyMs: stats(turns.map((t) => t.acousticLatencyMs)),
    bargeInStopMs: stats(turns.map((t) => t.bargeInStopMs)),
  };
}

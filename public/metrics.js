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

// If the mic has been "loud" continuously for longer than this (echo, noise),
// the start of the user's speech is taken as the speech_started time.
const MAX_MIC_RUN_MS = 2000;

export class TurnTracker {
  constructor({ speechRms = SPEECH_RMS, botSilenceMs = BOT_SILENCE_MS } = {}) {
    this.speechRms = speechRms;
    this.botSilenceMs = botSilenceMs;
    this.turns = [];
    this.micLoud = false;
    this.micRunStartAt = null;
    this.micLastLoudAt = null;
    this.botLastLoudAt = null;
    this.bargeIn = null; // { turn, userStartAt }
  }

  get current() {
    return this.turns.at(-1) ?? null;
  }

  botSpeakingAt(t) {
    return this.botLastLoudAt !== null && t - this.botLastLoudAt < this.botSilenceMs;
  }

  levels(t, micRms, botRms) {
    const micLoud = micRms > this.speechRms;
    if (micLoud) {
      if (!this.micLoud) this.micRunStartAt = t;
      this.micLastLoudAt = t;
    }
    this.micLoud = micLoud;

    if (botRms > this.speechRms) {
      this.botLastLoudAt = t;
      const turn = this.current;
      if (turn && turn.acousticLatencyMs === null && turn.micLastLoudAt !== null && t > turn.speechStoppedAt) {
        turn.acousticLatencyMs = Math.round(t - turn.micLastLoudAt);
      }
    } else if (this.bargeIn && t - this.botLastLoudAt >= this.botSilenceMs) {
      this.bargeIn.turn.bargeInStopMs = Math.max(0, Math.round(this.botLastLoudAt - this.bargeIn.userStartAt));
      this.bargeIn = null;
    }
  }

  event(t, type) {
    const turn = this.current;
    switch (type) {
      case 'input_audio_buffer.speech_started':
        if (turn && this.botSpeakingAt(t)) {
          turn.interrupted = true;
          const runOk = this.micRunStartAt !== null && t - this.micRunStartAt < MAX_MIC_RUN_MS;
          this.bargeIn = { turn, userStartAt: runOk ? this.micRunStartAt : t };
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        this.turns.push({
          index: this.turns.length + 1,
          speechStoppedAt: t,
          micLastLoudAt: this.micLastLoudAt,
          eventLatencyMs: null,
          acousticLatencyMs: null,
          interrupted: false,
          bargeInStopMs: null,
        });
        break;
      case 'output_audio_buffer.started':
        if (turn && turn.eventLatencyMs === null) turn.eventLatencyMs = Math.round(t - turn.speechStoppedAt);
        break;
      case 'output_audio_buffer.cleared':
        if (turn) turn.interrupted = true;
        break;
    }
  }
}

# Realtime Greek Voice Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demo page for talking to OpenAI Realtime in Greek or English with barge-in, plus per-turn latency and interruption metrics exported as JSON.

**Architecture:** Browser ↔ OpenAI directly via WebRTC (`/v1/realtime/calls`). A zero-dependency Node server only mints ephemeral keys (`/v1/realtime/client_secrets`) and serves static files. Metric logic lives in a pure ES module (`public/metrics.js`), shared by the browser and `node --test`.

**Tech Stack:** Node 20+ (tested on 24), `node:http`, `node:test`, vanilla HTML/JS, WebRTC, Web Audio API. No npm dependencies.

**Spec:** `docs/superpowers/specs/2026-09-28-realtime-greek-prototype-design.md`

**Verified API facts (OpenAI docs, 2026-09-28):**
- Ephemeral key: `POST https://api.openai.com/v1/realtime/client_secrets`, body `{ session: { type: "realtime", model, audio: { output: { voice } } } }`, response field `value`.
- SDP: `POST https://api.openai.com/v1/realtime/calls`, `Authorization: Bearer <ek>`, `Content-Type: application/sdp`, body = offer SDP, response = answer SDP.
- Data channel `oai-events`. `session.update` takes `session: { type: "realtime", instructions, audio: { input: { turn_detection, transcription: { model } } } }`.
- Voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar (marin/cedar recommended).
- Events: `input_audio_buffer.speech_started|speech_stopped`, `output_audio_buffer.started|stopped|cleared` (WebRTC only), `conversation.item.input_audio_transcription.completed`, `response.output_audio_transcript.done`, `response.done` (`status: "cancelled"` on interruption).
- Transcription model per the docs: `gpt-live-transcribe`. It is an editable field in the UI in case it gets rejected.

---

## File map

| File | Responsibility |
|---|---|
| `package.json` | `"type": "module"`, scripts `start` and `test` |
| `.env.example` | Key template |
| `server.js` | `createServer()` (static files + `POST /token`), `loadEnv()`, entry point |
| `public/metrics.js` | `rms`, `percentile`, `summarize`, `TurnTracker`: pure logic, no DOM |
| `public/index.html` | Markup and styles |
| `public/app.js` | WebRTC, audio analysers, event handling, rendering, export |
| `test/metrics.test.js` | Metric tests |
| `test/server.test.js` | Server tests (mocked fetch) |
| `README.md` | Run instructions and manual checklist |

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "tts-greek-realtime-prototype",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `.env.example`**

```
OPENAI_API_KEY=sk-...
PORT=3000
```

- [ ] **Step 3: Commit**

```bash
git add package.json .env.example
git commit -m "chore: project skeleton"
```

---

### Task 2: Metrics, `percentile` and `summarize` (TDD)

**Files:**
- Create: `test/metrics.test.js`, `public/metrics.js`

- [ ] **Step 1: Write failing tests**

`test/metrics.test.js`:

```js
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
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `node --test test/`
Expected: FAIL, `Cannot find module '.../public/metrics.js'`

- [ ] **Step 3: Implement**

`public/metrics.js`:

```js
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
```

- [ ] **Step 4: Run and confirm PASS**

Run: `node --test test/`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add public/metrics.js test/metrics.test.js
git commit -m "feat: percentile, rms and summary metrics"
```

---

### Task 3: `TurnTracker` (TDD)

Build turns from the server event timeline and audio levels.

**Files:**
- Modify: `public/metrics.js` (append the class at the end)
- Modify: `test/metrics.test.js` (append tests)

- [ ] **Step 1: Write failing tests** (append to `test/metrics.test.js`; the import line becomes the one shown)

Replace the import line with:

```js
import { percentile, summarize, rms, TurnTracker } from '../public/metrics.js';
```

Append at the end of the file:

```js
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
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `node --test test/`
Expected: FAIL, `TurnTracker is not a constructor` (or a SyntaxError on the import).

- [ ] **Step 3: Implement** (append to the end of `public/metrics.js`)

```js
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
```

- [ ] **Step 4: Run and confirm PASS**

Run: `node --test test/`
Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add public/metrics.js test/metrics.test.js
git commit -m "feat: TurnTracker for latency and barge-in metrics"
```

---

### Task 4: Server (TDD)

**Files:**
- Create: `test/server.test.js`, `server.js`

- [ ] **Step 1: Write failing tests**

`test/server.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

async function withServer(opts, fn) {
  const server = createServer({ publicDir, ...opts });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const postToken = (base, body) =>
  fetch(`${base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('POST /token forwards model/voice and returns ephemeral key', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ value: 'ek_test' }), { status: 200 });
  };
  await withServer({ apiKey: 'sk-test', fetchImpl }, async (base) => {
    const res = await postToken(base, { model: 'gpt-realtime-2.1', voice: 'marin' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { value: 'ek_test' });
  });
  assert.equal(captured.url, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(JSON.parse(captured.init.body), {
    session: { type: 'realtime', model: 'gpt-realtime-2.1', audio: { output: { voice: 'marin' } } },
  });
});

test('POST /token without API key returns 500 with message', async () => {
  await withServer({ apiKey: undefined }, async (base) => {
    const res = await postToken(base, { model: 'm', voice: 'v' });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /OPENAI_API_KEY/);
  });
});

test('POST /token propagates upstream error status', async () => {
  const fetchImpl = async () => new Response('{"error":{"message":"bad key"}}', { status: 401 });
  await withServer({ apiKey: 'sk-bad', fetchImpl }, async (base) => {
    const res = await postToken(base, { model: 'm', voice: 'v' });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /bad key/);
  });
});

test('POST /token validates body', async () => {
  await withServer({ apiKey: 'sk-test' }, async (base) => {
    const res = await postToken(base, { model: 'm' });
    assert.equal(res.status, 400);
  });
});

test('GET serves static files from public/', async () => {
  await withServer({ apiKey: 'sk-test' }, async (base) => {
    const res = await fetch(`${base}/metrics.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  });
});

test('GET blocks path traversal', async () => {
  await withServer({ apiKey: 'sk-test' }, async (base) => {
    const res = await fetch(`${base}/..%2Fserver.js`);
    assert.equal(res.status, 403);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL**

Run: `node --test test/`
Expected: FAIL, `Cannot find module '.../server.js'`

- [ ] **Step 3: Implement**

`server.js`:

```js
// Minimal server: serves public/ and mints OpenAI Realtime ephemeral keys.
// Audio does not pass through it; the browser talks to OpenAI directly over WebRTC.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function handleToken(req, res, apiKey, fetchImpl) {
  if (!apiKey) return sendJson(res, 500, { error: 'OPENAI_API_KEY is not set (see .env.example)' });
  const { model, voice } = await readJson(req);
  if (!model || !voice) return sendJson(res, 400, { error: 'model and voice are required' });
  const upstream = await fetchImpl(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: { type: 'realtime', model, audio: { output: { voice } } } }),
  });
  const text = await upstream.text();
  if (!upstream.ok) return sendJson(res, upstream.status, { error: `OpenAI ${upstream.status}: ${text}` });
  sendJson(res, 200, { value: JSON.parse(text).value });
}

async function serveStatic(res, publicDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

export function createServer({ apiKey, fetchImpl = fetch, publicDir = path.join(ROOT, 'public') }) {
  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && pathname === '/token') return await handleToken(req, res, apiKey, fetchImpl);
      if (req.method === 'GET') return await serveStatic(res, publicDir, pathname);
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv(path.join(ROOT, '.env'));
  const port = Number(process.env.PORT) || 3000;
  createServer({ apiKey: process.env.OPENAI_API_KEY }).listen(port, () => {
    console.log(`Prototype: http://localhost:${port}`);
  });
}
```

- [ ] **Step 4: Run and confirm PASS**

Run: `node --test test/`
Expected: 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server.js test/server.test.js
git commit -m "feat: token-minting static server"
```

---

### Task 5: Page markup

**Files:**
- Create: `public/index.html`

- [ ] **Step 1: Create `public/index.html`**

```html
<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Realtime Voice — Greek/English</title>
  <style>
    :root { --bg:#fafafa; --fg:#1d1d1f; --muted:#6e6e73; --card:#fff; --line:#e3e3e8; --accent:#2563eb; --bad:#dc2626; }
    @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#9a9aa0; --card:#1b1b1d; --line:#2e2e33; --accent:#60a5fa; --bad:#f87171; } }
    * { box-sizing: border-box; }
    body { margin:0; font:15px/1.45 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
    main { max-width: 980px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
    section { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; }
    h1 { font-size: 20px; margin: 0; } h2 { font-size: 15px; margin: 0 0 10px; color: var(--muted); }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
    label { display:grid; gap:4px; font-size:13px; color:var(--muted); }
    input, select, textarea, button { font: inherit; color: inherit; background: var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
    textarea { width:100%; min-height: 70px; }
    button { cursor:pointer; } button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
    button:disabled { opacity:.5; cursor:default; }
    .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    #status { color: var(--muted); }
    #error { color: var(--bad); display:none; }
    .meter { height: 10px; background: var(--line); border-radius: 5px; overflow:hidden; flex: 1; min-width: 120px; }
    .meter > div { height:100%; width:0; background: var(--accent); transition: width 50ms linear; }
    #transcript { display:grid; gap:6px; max-height: 320px; overflow:auto; }
    .msg { padding:6px 10px; border-radius:8px; background: var(--bg); }
    .msg.user { border-left: 3px solid var(--muted); } .msg.bot { border-left: 3px solid var(--accent); }
    table { width:100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align:right; padding: 4px 6px; border-bottom: 1px solid var(--line); } th:first-child, td:first-child { text-align:left; }
    .table-wrap { overflow-x:auto; }
  </style>
</head>
<body>
<main>
  <h1>Realtime Voice — Greek / English</h1>

  <section>
    <h2>Настройки (применяются при подключении)</h2>
    <div class="grid">
      <label>Модель
        <select id="model">
          <option>gpt-realtime-2.1</option>
          <option>gpt-realtime-2.1-mini</option>
        </select>
      </label>
      <label>Другая модель (перекрывает выбор)
        <input id="modelCustom" placeholder="напр. gpt-realtime-2">
      </label>
      <label>Голос
        <select id="voice">
          <option>marin</option><option>cedar</option><option>alloy</option><option>ash</option><option>ballad</option>
          <option>coral</option><option>echo</option><option>sage</option><option>shimmer</option><option>verse</option>
        </select>
      </label>
      <label>VAD
        <select id="vad">
          <option value="semantic_vad">semantic_vad</option>
          <option value="server_vad">server_vad</option>
        </select>
      </label>
      <label>eagerness (semantic_vad)
        <select id="eagerness"><option>auto</option><option>low</option><option>medium</option><option>high</option></select>
      </label>
      <label>silence_duration_ms (server_vad)
        <input id="silenceMs" type="number" value="500" min="100" step="50">
      </label>
      <label>Модель транскрипции
        <input id="transcribeModel" value="gpt-live-transcribe">
      </label>
    </div>
    <label style="margin-top:10px">Системный промпт
      <textarea id="prompt"></textarea>
    </label>
  </section>

  <section>
    <div class="row">
      <button id="connect" class="primary">Подключиться</button>
      <button id="mute" disabled>Выключить микрофон</button>
      <button id="export">Экспорт JSON</button>
      <span id="status">Не подключено</span>
    </div>
    <p id="error"></p>
    <div class="row" style="margin-top:10px">🎙️ <div class="meter"><div id="micMeter"></div></div>
      🤖 <div class="meter"><div id="botMeter"></div></div></div>
    <audio id="botAudio" autoplay></audio>
  </section>

  <section>
    <h2>Метрики</h2>
    <p id="summary">—</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Событийная, мс</th><th>Акустическая, мс</th><th>Перебит</th><th>Остановка после перебивания, мс</th></tr></thead>
        <tbody id="turns"></tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Транскрипт</h2>
    <div id="transcript"></div>
  </section>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Check that it is served**

Run: `node server.js & sleep 1; curl -s localhost:3000/ | head -5; kill %1`
Expected: the first lines of HTML (`<!doctype html>`).

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat: prototype page markup"
```

---

### Task 6: Client logic `app.js`

**Files:**
- Create: `public/app.js`

- [ ] **Step 1: Create `public/app.js`**

```js
import { TurnTracker, summarize, rms } from './metrics.js';

const DEFAULT_PROMPT =
  'Ты голосовой ассистент. Отвечай на языке собеседника — греческом или английском. ' +
  'Говори коротко и разговорно, 1–3 предложения.';
const CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
const LEVEL_INTERVAL_MS = 20;

const $ = (id) => document.getElementById(id);
const now = () => performance.now();

let pc = null;
let dc = null;
let micStream = null;
let audioCtx = null;
let levelTimer = null;
let analysers = { mic: null, bot: null };
let tracker = new TurnTracker();
let session = newSessionLog(null);

$('prompt').value = DEFAULT_PROMPT;
$('connect').onclick = () => (pc ? disconnect() : connect());
$('mute').onclick = toggleMute;
$('export').onclick = exportJson;

function newSessionLog(settings) {
  return { settings, startedAt: now(), events: [], transcript: [], cancelledResponses: new Set() };
}

function readSettings() {
  return {
    model: $('modelCustom').value.trim() || $('model').value,
    voice: $('voice').value,
    vad: $('vad').value,
    eagerness: $('eagerness').value,
    silenceMs: Number($('silenceMs').value) || 500,
    transcribeModel: $('transcribeModel').value.trim(),
    prompt: $('prompt').value.trim() || DEFAULT_PROMPT,
  };
}

function setStatus(text) {
  $('status').textContent = text;
}

function showError(text) {
  $('error').textContent = text;
  $('error').style.display = text ? 'block' : 'none';
}

async function connect() {
  showError('');
  const settings = readSettings();
  tracker = new TurnTracker();
  session = newSessionLog(settings);
  renderMetrics();
  $('transcript').innerHTML = '';
  $('connect').disabled = true;
  setStatus('Получаю токен…');

  try {
    const tokenRes = await fetch('/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model, voice: settings.voice }),
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(`Токен: ${token.error}`);

    setStatus('Запрашиваю микрофон…');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw new Error(`Нет доступа к микрофону: ${err.message}`);
    }

    audioCtx = new AudioContext();
    analysers.mic = createAnalyser(micStream);

    pc = new RTCPeerConnection();
    pc.ontrack = (e) => {
      $('botAudio').srcObject = e.streams[0];
      analysers.bot = createAnalyser(e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'disconnected'].includes(pc.connectionState)) {
        showError(`Соединение: ${pc.connectionState}`);
        disconnect();
      }
    };
    pc.addTrack(micStream.getAudioTracks()[0], micStream);

    dc = pc.createDataChannel('oai-events');
    dc.onopen = () => {
      sendSessionUpdate(settings);
      setStatus(`Подключено: ${settings.model} / ${settings.voice}. Говорите.`);
    };
    dc.onmessage = (e) => handleServerEvent(JSON.parse(e.data));

    setStatus('Соединяюсь с OpenAI…');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdpRes = await fetch(CALLS_URL, {
      method: 'POST',
      body: offer.sdp,
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' },
    });
    if (!sdpRes.ok) throw new Error(`SDP ${sdpRes.status}: ${await sdpRes.text()}`);
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

    levelTimer = setInterval(sampleLevels, LEVEL_INTERVAL_MS);
    $('connect').textContent = 'Отключиться';
    $('mute').disabled = false;
  } catch (err) {
    showError(err.message);
    disconnect();
  } finally {
    $('connect').disabled = false;
  }
}

function disconnect() {
  clearInterval(levelTimer);
  levelTimer = null;
  dc?.close();
  pc?.close();
  micStream?.getTracks().forEach((t) => t.stop());
  audioCtx?.close();
  pc = dc = micStream = audioCtx = null;
  analysers = { mic: null, bot: null };
  $('botAudio').srcObject = null;
  $('connect').textContent = 'Подключиться';
  $('mute').disabled = true;
  $('mute').textContent = 'Выключить микрофон';
  $('micMeter').style.width = $('botMeter').style.width = '0';
  setStatus('Не подключено');
}

function toggleMute() {
  const track = micStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('mute').textContent = track.enabled ? 'Выключить микрофон' : 'Включить микрофон';
}

function sendSessionUpdate(s) {
  const turn_detection =
    s.vad === 'semantic_vad'
      ? { type: 'semantic_vad', eagerness: s.eagerness }
      : { type: 'server_vad', silence_duration_ms: s.silenceMs };
  const input = { turn_detection };
  if (s.transcribeModel) input.transcription = { model: s.transcribeModel };
  dc.send(JSON.stringify({
    type: 'session.update',
    session: { type: 'realtime', instructions: s.prompt, audio: { input } },
  }));
}

function createAnalyser(stream) {
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  return { analyser, buf: new Float32Array(analyser.fftSize) };
}

function levelOf(a) {
  if (!a) return 0;
  a.analyser.getFloatTimeDomainData(a.buf);
  return rms(a.buf);
}

function sampleLevels() {
  const mic = levelOf(analysers.mic);
  const bot = levelOf(analysers.bot);
  tracker.levels(now(), mic, bot);
  $('micMeter').style.width = `${Math.min(100, mic * 400)}%`;
  $('botMeter').style.width = `${Math.min(100, bot * 400)}%`;
  if (tracker.turns.some((t) => t.bargeInStopMs !== null && !t.rendered)) renderMetrics();
}

function handleServerEvent(ev) {
  const t = now();
  if (!ev.type.endsWith('.delta')) {
    session.events.push({ t: Math.round(t - session.startedAt), ...ev });
  }
  tracker.event(t, ev.type);

  switch (ev.type) {
    case 'conversation.item.input_audio_transcription.completed':
      addMessage('user', ev.transcript);
      break;
    case 'response.output_audio_transcript.done':
      addMessage('bot', ev.transcript, ev.response_id);
      break;
    case 'response.done':
      if (ev.response?.status === 'cancelled') markCancelled(ev.response.id);
      break;
    case 'error':
      showError(`OpenAI: ${ev.error?.message ?? JSON.stringify(ev.error)}`);
      break;
  }
  if (ev.type.startsWith('input_audio_buffer.') || ev.type.startsWith('output_audio_buffer.')) renderMetrics();
}

function addMessage(role, text, responseId = null) {
  const cancelled = responseId !== null && session.cancelledResponses.has(responseId);
  const entry = { role, text, responseId, cancelled, t: Math.round(now() - session.startedAt) };
  session.transcript.push(entry);
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.dataset.responseId = responseId ?? '';
  div.textContent = `${role === 'user' ? '🧑' : '🤖'} ${text}${cancelled ? ' ✂️' : ''}`;
  $('transcript').append(div);
  div.scrollIntoView({ block: 'nearest' });
}

function markCancelled(responseId) {
  session.cancelledResponses.add(responseId);
  const entry = session.transcript.find((e) => e.responseId === responseId);
  if (!entry || entry.cancelled) return;
  entry.cancelled = true;
  const div = $('transcript').querySelector(`[data-response-id="${CSS.escape(responseId)}"]`);
  if (div) div.textContent += ' ✂️';
}

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));

function renderMetrics() {
  $('turns').innerHTML = tracker.turns
    .map((t) => {
      t.rendered = t.bargeInStopMs !== null;
      return `<tr><td>${t.index}</td><td>${fmt(t.eventLatencyMs)}</td><td>${fmt(t.acousticLatencyMs)}</td>` +
        `<td>${t.interrupted ? '✂️' : ''}</td><td>${fmt(t.bargeInStopMs)}</td></tr>`;
    })
    .join('');
  const s = summarize(tracker.turns);
  $('summary').textContent =
    `Ходов: ${s.turns}, перебиваний: ${s.interruptions}. ` +
    `Событийная p50/p95: ${fmt(s.eventLatencyMs.p50)}/${fmt(s.eventLatencyMs.p95)} мс. ` +
    `Акустическая p50/p95: ${fmt(s.acousticLatencyMs.p50)}/${fmt(s.acousticLatencyMs.p95)} мс. ` +
    `Остановка при перебивании p50/p95: ${fmt(s.bargeInStopMs.p50)}/${fmt(s.bargeInStopMs.p95)} мс.`;
}

function exportJson() {
  const turns = tracker.turns.map(({ rendered, ...t }) => t);
  const data = {
    exportedAt: new Date().toISOString(),
    settings: session.settings,
    summary: summarize(turns),
    turns,
    transcript: session.transcript,
    events: session.events,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const model = session.settings?.model ?? 'session';
  a.href = URL.createObjectURL(blob);
  a.download = `realtime-${model}-${data.exportedAt.replace(/[:.]/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/app.js && node --test test/`
Expected: no output from `--check`; 15 tests pass.

- [ ] **Step 3: Commit**

```bash
git add public/app.js
git commit -m "feat: WebRTC client with live metrics and JSON export"
```

---

### Task 7: README and manual check

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

````markdown
# Прототип: голосовой агент OpenAI Realtime (греческий / английский)

Страница для голосового разговора с OpenAI Realtime с возможностью перебивать и замерами задержки.
Отчёт по рынку: `report-realtime-voice-greek.md`. Дизайн: `docs/superpowers/specs/`.

## Запуск

```bash
cp .env.example .env    # вписать OPENAI_API_KEY
npm start               # или: node server.js
# открыть http://localhost:3000 в Chrome
```

Нужен Node 20+. Зависимостей нет. Тесты: `npm test`.

**Для замеров используйте наушники**: без них эхо от динамиков вызывает ложные перебивания.

## Метрики

- **Событийная задержка**: от `speech_stopped` (сервер решил, что вы закончили) до `output_audio_buffer.started`.
- **Акустическая задержка**: от последнего громкого кадра микрофона до первого звука бота. Это ощущаемая задержка, она включает ожидание VAD.
- **Остановка после перебивания**: от начала вашей речи до тишины бота (≥ 200 мс без звука).
- Порог громкости `SPEECH_RMS` находится в `public/metrics.js`.

«Экспорт JSON» сохраняет настройки, метрики, транскрипт и лог событий. Файлы разных прогонов сравниваются между собой.

## Ручной чек-лист

1. Греческая фраза («Καλημέρα, τι καιρό κάνει σήμερα στην Αθήνα;») → ответ по-гречески.
2. Английская фраза → ответ по-английски.
3. Попросить длинный рассказ и перебить посередине → бот замолкает, в транскрипте ✂️, в таблице заполнено время остановки.
4. Сказать «ναι» или «ага» во время ответа → посмотреть, прерывается ли бот (сравнить semantic_vad и server_vad).
5. Назвать своё имя, через 3 реплики спросить «Πώς με λένε;» → бот помнит.
6. Числа и даты: «Πόσο κάνει 1.250 ευρώ συν 18%;», «25 Μαρτίου 2027».
7. Смешанная речь: греческая фраза с английскими терминами.
8. «Экспорт JSON» → файл открывается, `summary` заполнен.
````

- [ ] **Step 2: Smoke test the server without a key**

Run: `PORT=3099 node server.js & sleep 1; curl -s -X POST localhost:3099/token -H 'Content-Type: application/json' -d '{"model":"gpt-realtime-2.1","voice":"marin"}'; echo; curl -s -o /dev/null -w '%{http_code}\n' localhost:3099/app.js; kill %1`
Expected: `{"error":"OPENAI_API_KEY is not set (see .env.example)"}` (if `.env` has no key) and `200`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with run instructions and manual checklist"
```

- [ ] **Step 4: Live check (user, with a key)**

Put the key in `.env`, `npm start`, go through the README checklist in Chrome. Anything the API rejects shows up in the red error banner; if `session.update` fails because of the transcription model, clear the "Модель транскрипции" field and reconnect.

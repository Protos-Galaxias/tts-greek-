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

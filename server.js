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

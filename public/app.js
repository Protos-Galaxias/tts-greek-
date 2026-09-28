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

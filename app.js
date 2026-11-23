import { RATE, FRAME, Resampler, Framer, Vad, Segmenter, floatToInt16, assembleWavParts } from './audio-core.js';
import * as db from './db.js';
import { loadEngine, disposeEngine, synthesize } from './tts.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'hypna.diary.v1';
const DEFAULT_PROMPTS = [
  'Was ist gerade da?',
  'Was geht dir gerade durch den Kopf?',
  'Wie fühlt es sich gerade an, zu sein?',
  'Wo bist du gerade?',
  'Was war das Letzte, bevor ich gefragt habe?',
  'Gibt es gerade ein Ich? Wie ist es?',
].join('\n');

const DEFAULT_SETTINGS = {
  maxSilenceSec: 5,
  promptAfterMin: 5,
  maxPrompts: 6,
  promptOrder: 'sequence',
  sensitivityDb: 12,
  chime: true,
  chimeGapSec: 2,
  insertPrompts: true,
  autoLock: true,
  volume: 0.8,
  promptTexts: DEFAULT_PROMPTS,
  voice: '',
  temperature: null, // null = Standard des Modells
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
let settings = loadSettings();

function outText(key) {
  if (key === 'volume') return `${Math.round(settings.volume * 100)} %`;
  return String(settings[key]);
}

function bindSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    const apply = () => {
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
      const out = $(`[data-out="${key}"]`);
      if (out) out.textContent = outText(key);
    };
    apply();
    el._apply = apply;
    el.addEventListener('input', () => {
      if (el.type === 'checkbox') settings[key] = el.checked;
      else if (el.type === 'number' || el.type === 'range') {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) settings[key] = v;
      } else settings[key] = el.value;
      const out = $(`[data-out="${key}"]`);
      if (out) out.textContent = outText(key);
      saveSettings();
      applyLiveSettings();
    });
  });
  $('#btnReset').addEventListener('click', () => {
    const keep = { promptTexts: settings.promptTexts, voice: settings.voice, temperature: settings.temperature };
    settings = { ...DEFAULT_SETTINGS, ...keep };
    saveSettings();
    document.querySelectorAll('[data-setting]').forEach((el) => el._apply && el._apply());
    applyLiveSettings();
  });
}

function applyLiveSettings() {
  if (S.vad) S.vad.sensitivityDb = settings.sensitivityDb;
  if (S.segmenter) S.segmenter.setMaxSilence(settings.maxSilenceSec);
  if (S.gain) S.gain.gain.value = settings.volume;
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const S = {
  phase: 'idle',           // idle | starting | listening | prompting | saving
  session: null,
  startedAt: 0,
  ctx: null,
  gain: null,
  stream: null,
  source: null,
  worklet: null,
  sink: null,
  wakeLock: null,
  resampler: null,
  framer: null,
  vad: null,
  segmenter: null,
  seq: 0,
  spokenSec: 0,
  lastActivity: 0,
  promptsAsked: 0,
  promptIndex: 0,
  promptBuffers: [],       // [{ text, buffer }]
  suppressUntil: 0,
  lastDb: -100,
  uiTimer: null,
  pending: Promise.resolve(),
};
const now = () => performance.now() / 1000;
const running = () => ['listening', 'prompting'].includes(S.phase);

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------
const logEl = $('#log');
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function appendLogLine(ev) {
  const li = document.createElement('li');
  li.innerHTML = `<b>${fmtTime(ev.ts)}</b> `;
  li.append(document.createTextNode(ev.msg));
  logEl.prepend(li);
  while (logEl.children.length > 200) logEl.lastChild.remove();
}
function log(msg) {
  const ev = { ts: Date.now(), session: S.session, msg };
  appendLogLine(ev);
  db.addEvent(ev).catch(() => {});
  console.log('[hypna]', msg);
}
async function loadLog() {
  try { (await db.listEvents()).slice(-200).forEach(appendLogLine); } catch { /* ignore */ }
}

function showWarn(msg) { const el = $('#warn'); el.textContent = msg; el.hidden = false; }
function hideWarn() { $('#warn').hidden = true; }

// ---------------------------------------------------------------------------
// Nachfragen: Texte, Vertonung mit Pocket TTS, Speicher
// ---------------------------------------------------------------------------
const PROMPTS_KEY = 'prompts';

function promptLines() {
  return settings.promptTexts.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function getPromptSet() {
  try { return (await db.getFile(PROMPTS_KEY)) || null; } catch { return null; }
}

let previewAudio = null;
function playPreview(blob) {
  if (previewAudio) {
    previewAudio.pause();
    URL.revokeObjectURL(previewAudio.src);
    previewAudio = null;
  }
  previewAudio = new Audio(URL.createObjectURL(blob));
  previewAudio.volume = settings.volume;
  previewAudio.play().catch((e) => showWarn(`Abspielen fehlgeschlagen: ${e.message}`));
}

async function renderPromptList() {
  const set = await getPromptSet();
  const list = $('#promptList');
  list.innerHTML = '';
  const lines = promptLines();
  const byText = new Map((set?.items || []).map((it) => [it.text, it]));
  let missing = 0;
  for (const text of lines) {
    const it = byText.get(text);
    const li = document.createElement('li');
    li.innerHTML = '<div class="prompt-item"><span></span><em class="tag"></em></div>';
    $('span', li).textContent = text;
    if (it) {
      $('.tag', li).textContent = it.voice || '';
      const b = document.createElement('button');
      b.textContent = '▶︎';
      b.addEventListener('click', () => playPreview(it.blob));
      $('.prompt-item', li).append(b);
    } else {
      missing++;
      $('.tag', li).textContent = 'nicht vertont';
      $('.tag', li).classList.add('stale');
    }
    list.append(li);
  }
  const st = $('#ttsStatus');
  if (!set) st.textContent = 'Noch nicht vertont. Ohne Vertonung liest die Sprachausgabe des Handys vor.';
  else if (missing) st.innerHTML = `<span class="stale">${missing} Frage(n) noch nicht vertont – tippe auf „Nachfragen vertonen“.</span>`;
  else st.textContent = `Alle ${lines.length} Nachfragen sind vertont und gespeichert.`;
}

function stageLabel(stage) {
  const s = String(stage || '').toLowerCase();
  if (s.includes('model') || s.includes('weight') || s.includes('download') || s.includes('fetch')) return 'Lade Sprachmodell';
  if (s.includes('asset') || s.includes('token') || s.includes('voice')) return 'Lade Stimmen';
  return 'Lade';
}

function setProgress(frac, text) {
  $('#ttsProgress').hidden = frac == null;
  if (frac != null) $('#ttsProgressFill').style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  if (text != null) $('#ttsStatus').textContent = text;
}

async function getEngine() {
  setProgress(0, 'Starte Pocket TTS …');
  const engine = await loadEngine((stage, p) => {
    const total = p && p.total;
    const loaded = p && p.loaded;
    if (total) setProgress(loaded / total, `${stageLabel(stage)} … ${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB`);
    else setProgress(null, `${stageLabel(stage)} …`);
  });
  fillVoices(engine);
  return engine;
}

function fillVoices(engine) {
  const sel = $('#voiceSelect');
  const voices = engine.voices || [];
  sel.innerHTML = '';
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v === engine.defaultVoice ? `${v} (Standard)` : v;
    sel.append(o);
  }
  if (!settings.voice || !voices.includes(settings.voice)) settings.voice = engine.defaultVoice || voices[0] || '';
  sel.value = settings.voice;
  try { localStorage.setItem('hypna.voices', JSON.stringify({ voices, def: engine.defaultVoice })); } catch { /* ignore */ }
  saveSettings();
}

function restoreVoiceList() {
  try {
    const v = JSON.parse(localStorage.getItem('hypna.voices') || 'null');
    if (v) fillVoices({ voices: v.voices, defaultVoice: v.def });
  } catch { /* ignore */ }
}

let generating = false;
async function generatePrompts({ onlyFirst = false } = {}) {
  if (generating) return;
  const lines = promptLines();
  if (!lines.length) return showWarn('Bitte mindestens eine Frage eintragen.');
  generating = true;
  $('#btnGenerate').disabled = true;
  $('#btnTry').disabled = true;
  hideWarn();
  try {
    const engine = await getEngine();
    const voice = settings.voice || engine.defaultVoice;
    if (onlyFirst) {
      setProgress(null, 'Erzeuge Probe …');
      const t0 = performance.now();
      const blob = await synthesize(engine, lines[0], voice, { temperature: settings.temperature });
      setProgress(null, `Probe fertig (${((performance.now() - t0) / 1000).toFixed(1)} s Rechenzeit).`);
      playPreview(blob);
      return;
    }
    const old = await getPromptSet();
    const reuse = new Map(
      (old?.items || []).filter((it) => it.voice === voice && it.temperature === settings.temperature).map((it) => [it.text, it])
    );
    const items = [];
    const t0 = performance.now();
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      setProgress(i / lines.length, `Vertone ${i + 1} / ${lines.length}: „${text}“`);
      const keep = reuse.get(text);
      if (keep) {
        items.push(keep);
        continue;
      }
      const blob = await synthesize(engine, text, voice, { temperature: settings.temperature });
      items.push({ text, voice, temperature: settings.temperature, blob });
    }
    await db.putFile(PROMPTS_KEY, { createdAt: Date.now(), items });
    setProgress(null);
    log(`${items.length} Nachfragen vertont (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
    await renderPromptList();
  } catch (e) {
    setProgress(null, '');
    renderPromptList();
    showWarn(`Vertonung fehlgeschlagen: ${e.message || e}. Ist das Handy online? Beim ersten Mal wird das Modell geladen.`);
    log(`TTS-Fehler: ${e.message || e}`);
  } finally {
    // Modell freigeben: nachts wird es nicht gebraucht, und es belegt viel Speicher
    await disposeEngine();
    generating = false;
    $('#btnGenerate').disabled = false;
    $('#btnTry').disabled = false;
  }
}

function bindPrompts() {
  const ta = $('#promptTexts');
  ta.value = settings.promptTexts;
  ta.addEventListener('input', () => {
    settings.promptTexts = ta.value;
    saveSettings();
    clearTimeout(ta._t);
    ta._t = setTimeout(renderPromptList, 400);
  });
  const sel = $('#voiceSelect');
  sel.addEventListener('change', () => { settings.voice = sel.value; saveSettings(); });
  const tr = $('#tempRange');
  tr.value = settings.temperature ?? 0.7;
  $('#tempOut').textContent = settings.temperature ?? 'Standard';
  tr.addEventListener('input', () => {
    settings.temperature = parseFloat(tr.value);
    $('#tempOut').textContent = settings.temperature;
    saveSettings();
  });
  $('#btnGenerate').addEventListener('click', () => generatePrompts());
  $('#btnTry').addEventListener('click', () => generatePrompts({ onlyFirst: true }));
  restoreVoiceList();
  renderPromptList();
}

// ---------------------------------------------------------------------------
// Wiedergabe
// ---------------------------------------------------------------------------
function later(ms) { return new Promise((r) => setTimeout(r, ms)); }

function playBuffer(buffer, fadeInSec = 0.5) {
  return new Promise((resolve) => {
    const src = S.ctx.createBufferSource();
    src.buffer = buffer;
    const g = S.ctx.createGain();
    const t0 = S.ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(1, t0 + fadeInSec);
    src.connect(g);
    g.connect(S.gain);
    src.onended = () => resolve();
    src.start();
  });
}

function chimeBuffer() {
  const rate = S.ctx.sampleRate;
  const dur = 3;
  const buf = S.ctx.createBuffer(1, Math.round(rate * dur), rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / rate;
    const env = Math.min(1, t / 0.02) * Math.exp(-t * 1.8);
    d[i] = 0.3 * env * (Math.sin(2 * Math.PI * 523.25 * t) + 0.35 * Math.sin(2 * Math.PI * 1046.5 * t) + 0.12 * Math.sin(2 * Math.PI * 1568 * t));
  }
  return buf;
}

function speakFallback(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    u.rate = 0.85;
    u.volume = settings.volume;
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    u.onend = fin;
    u.onerror = fin;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(fin, 4000 + text.length * 150);
  });
}

// Fügt Audio (z. B. Nachfrage) als eigenen Abschnitt in die Aufnahme ein
function bufferTo16k(buffer) {
  const ch = buffer.getChannelData(0);
  const rs = new Resampler(buffer.sampleRate, RATE);
  return rs.process(ch);
}

// ---------------------------------------------------------------------------
// Aufnahme
// ---------------------------------------------------------------------------
function storeChunk(pcmFloat, contiguous, kind = 'speech') {
  const pcm = floatToInt16(pcmFloat);
  if (kind === 'speech') S.spokenSec += pcm.length / RATE;
  const chunk = { session: S.session, seq: S.seq++, kind, contiguous, ts: Date.now(), pcm: pcm.buffer };
  // Nacheinander speichern, damit die Reihenfolge stimmt
  S.pending = S.pending.then(() => db.addChunk(chunk)).catch((e) => log(`Speichern fehlgeschlagen: ${e.message}`));
}

function onFrame(frame) {
  const t = now();
  let speech = S.vad.process(frame);
  S.lastDb = S.vad.db;
  if (S.phase === 'prompting' || t < S.suppressUntil) speech = false;
  if (speech) S.lastActivity = t;
  for (const seg of S.segmenter.push(frame, speech)) storeChunk(seg.pcm, seg.contiguous);
}

function onAudioBlock(e) {
  if (!running()) return;
  const block = e.data;
  S.framer.push(S.resampler.process(block), onFrame);
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch (e) {
    log(`Bildschirm kann nicht wach gehalten werden: ${e.message}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!running()) return;
  if (document.visibilityState === 'visible') {
    if (!S.wakeLock) requestWakeLock();
    if (S.ctx && S.ctx.state !== 'running') S.ctx.resume();
    log('App wieder im Vordergrund');
  } else {
    log('Achtung: App im Hintergrund – Aufnahme kann pausieren');
  }
});

async function loadPromptBuffers() {
  S.promptBuffers = [];
  const set = await getPromptSet();
  const byText = new Map((set?.items || []).map((it) => [it.text, it]));
  for (const text of promptLines()) {
    const it = byText.get(text);
    let buffer = null;
    if (it) {
      try {
        const data = await it.blob.arrayBuffer();
        buffer = await new Promise((res, rej) => {
          const p = S.ctx.decodeAudioData(data, res, rej);
          if (p && p.then) p.then(res, rej);
        });
      } catch { buffer = null; }
    }
    S.promptBuffers.push({ text, buffer });
  }
}

async function startSession() {
  $('#btnStart').disabled = true;
  hideWarn();
  S.phase = 'starting';
  renderStatus();
  try {
    // Alles, was einen Tap braucht, zuerst
    const Ctx = window.AudioContext || window.webkitAudioContext;
    S.ctx = new Ctx();
    S.ctx.resume();
    S.gain = S.ctx.createGain();
    S.gain.gain.value = settings.volume;
    S.gain.connect(S.ctx.destination);
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
    if (!navigator.mediaDevices) throw new Error('Mikrofon wird von diesem Browser nicht unterstützt (HTTPS nötig).');
    S.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!S.ctx.audioWorklet) throw new Error('AudioWorklet fehlt – bitte Browser aktualisieren.');
    await S.ctx.audioWorklet.addModule('./capture-worklet.js');
    S.source = S.ctx.createMediaStreamSource(S.stream);
    S.worklet = new AudioWorkletNode(S.ctx, 'capture');
    S.sink = S.ctx.createGain();
    S.sink.gain.value = 0; // nur damit der Worklet sicher „gezogen“ wird
    S.source.connect(S.worklet);
    S.worklet.connect(S.sink);
    S.sink.connect(S.ctx.destination);
    S.worklet.port.onmessage = onAudioBlock;

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await requestWakeLock();
    await loadPromptBuffers();
  } catch (e) {
    showWarn(e.message || String(e));
    log(`Start fehlgeschlagen: ${e.message || e}`);
    await teardown();
    S.phase = 'idle';
    renderStatus();
    $('#btnStart').disabled = false;
    return;
  }

  S.session = new Date().toISOString();
  S.startedAt = now();
  S.lastActivity = now();
  S.seq = 0;
  S.spokenSec = 0;
  S.promptsAsked = 0;
  S.promptIndex = 0;
  S.resampler = new Resampler(S.ctx.sampleRate, RATE);
  S.framer = new Framer(FRAME);
  S.vad = new Vad({ sensitivityDb: settings.sensitivityDb });
  S.segmenter = new Segmenter({ maxSilenceSec: settings.maxSilenceSec });
  S.suppressUntil = now() + 1; // Klick-Geräusch beim Start ignorieren
  S.phase = 'listening';
  const voiced = S.promptBuffers.filter((p) => p.buffer).length;
  log(`Session gestartet (${S.promptBuffers.length} Nachfragen, ${voiced} vertont, ${Math.round(S.ctx.sampleRate / 1000)} kHz)`);
  toggleRunningUI(true);
  if (settings.autoLock) showNight(true);
}

function nextPrompt() {
  const n = S.promptBuffers.length;
  if (!n) return null;
  let i;
  if (settings.promptOrder === 'random') {
    i = Math.floor(Math.random() * n);
    if (n > 1 && i === S.promptIndex) i = (i + 1) % n;
  } else {
    i = S.promptsAsked % n;
  }
  S.promptIndex = i;
  return S.promptBuffers[i];
}

async function askPrompt(reason) {
  if (S.phase !== 'listening') return;
  const p = nextPrompt();
  if (!p) return;
  S.phase = 'prompting';
  S.promptsAsked++;
  log(`Nachfrage ${S.promptsAsked} (${reason}): „${p.text}“`);
  // Laufenden Abschnitt abschließen, damit die Frage an der richtigen Stelle steht
  for (const seg of S.segmenter.flush()) storeChunk(seg.pcm, seg.contiguous);
  try {
    if (settings.chime) {
      await playBuffer(chimeBuffer(), 0.01);
      await later(settings.chimeGapSec * 1000);
    }
    if (S.phase !== 'prompting') return;
    if (p.buffer) {
      if (settings.insertPrompts) storeChunk(bufferTo16k(p.buffer), false, 'prompt');
      await playBuffer(p.buffer, 0.8);
    } else {
      await speakFallback(p.text);
    }
  } catch (e) {
    log(`Nachfrage fehlgeschlagen: ${e.message}`);
  }
  if (S.phase !== 'prompting') return;
  S.suppressUntil = now() + 0.4;
  S.lastActivity = now();
  S.phase = 'listening';
}

async function teardown() {
  try { S.worklet && (S.worklet.port.onmessage = null); } catch { /* ignore */ }
  try { S.source && S.source.disconnect(); } catch { /* ignore */ }
  try { S.worklet && S.worklet.disconnect(); } catch { /* ignore */ }
  if (S.stream) S.stream.getTracks().forEach((t) => t.stop());
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (S.wakeLock) { try { await S.wakeLock.release(); } catch { /* ignore */ } }
  if (S.ctx) { try { await S.ctx.close(); } catch { /* ignore */ } }
  Object.assign(S, { stream: null, source: null, worklet: null, sink: null, wakeLock: null, ctx: null, gain: null });
}

async function stopSession() {
  if (!running()) return;
  S.phase = 'saving';
  renderStatus();
  for (const seg of S.segmenter.flush()) storeChunk(seg.pcm, seg.contiguous);
  await teardown();
  await S.pending;
  const session = S.session;
  const saved = await finalizeSession(session, { prompts: S.promptsAsked });
  log(saved ? `Gespeichert: ${Math.round(saved.durationSec)} s Aufnahme` : 'Session beendet – nichts gesprochen, nichts gespeichert');
  S.phase = 'idle';
  S.session = null;
  toggleRunningUI(false);
  showNight(false);
  $('#btnStart').disabled = false;
  renderStatus();
  renderRecordings();
}

// Abschnitte einer Session zu einer WAV-Datei zusammensetzen und aufräumen
async function finalizeSession(session, meta = {}) {
  const chunks = (await db.listChunks(session)).sort((a, b) => a.seq - b.seq);
  if (!chunks.some((c) => c.kind === 'speech')) {
    await db.deleteChunks(session);
    return null;
  }
  const { parts, seconds } = assembleWavParts(chunks);
  const blob = new Blob(parts, { type: 'audio/wav' });
  const rec = {
    ts: chunks[0].ts,
    session,
    durationSec: seconds,
    prompts: meta.prompts ?? chunks.filter((c) => c.kind === 'prompt').length,
    recovered: !!meta.recovered,
    mime: 'audio/wav',
    blob,
  };
  await db.addRecording(rec);
  await db.deleteChunks(session);
  return rec;
}

// Nach einem Absturz: übrig gebliebene Abschnitte retten
async function recoverSessions() {
  try {
    const sessions = await db.listAllChunkSessions();
    for (const s of sessions) {
      const rec = await finalizeSession(s, { recovered: true });
      if (rec) log(`Unterbrochene Session wiederhergestellt (${Math.round(rec.durationSec)} s)`);
    }
    if (sessions.length) renderRecordings();
  } catch (e) {
    log(`Wiederherstellung fehlgeschlagen: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function toggleRunningUI(on) {
  $('#btnStart').hidden = on;
  $('#btnStop').hidden = !on;
  $('#btnLock').hidden = !on;
  $('#btnAsk').hidden = !on;
}

function promptsLeft() {
  return settings.maxPrompts === 0 || S.promptsAsked < settings.maxPrompts;
}

function renderStatus() {
  const t = now();
  let title = 'Bereit';
  let detail = 'Tippe auf Start, leg dich hin und sprich, wann immer etwas auftaucht.';
  if (S.phase === 'starting') { title = 'Starte …'; detail = 'Bitte Mikrofon erlauben.'; }
  if (S.phase === 'saving') { title = 'Speichere …'; detail = ''; }
  if (S.phase === 'prompting') { title = 'Nachfrage'; detail = 'Antworte einfach laut.'; }
  if (S.phase === 'listening') {
    const speaking = S.vad && S.vad.active && t >= S.suppressUntil;
    title = speaking ? 'Nimmt auf' : 'Hört zu';
    detail = speaking ? 'Du sprichst – wird gespeichert.' : 'Stille wird nicht gespeichert.';
  }
  $('#phase').textContent = title;
  $('#phaseDetail').textContent = detail;
  $('#nightPhase').textContent = title;

  const on = running();
  $('#statElapsed').textContent = on ? fmtDur(t - S.startedAt) : '–';
  $('#statSpoken').textContent = on ? fmtDur(S.spokenSec) : '–';
  $('#statPrompts').textContent = on ? `${S.promptsAsked}${settings.maxPrompts ? `/${settings.maxPrompts}` : ''}` : '–';
  let next = '–';
  if (on && settings.promptAfterMin > 0 && promptsLeft() && S.promptBuffers.length) {
    next = fmtDur(settings.promptAfterMin * 60 - (t - S.lastActivity));
  }
  $('#statNext').textContent = next;

  // Pegel: -80 … -10 dB
  const pos = (db) => Math.max(0, Math.min(100, ((db + 80) / 70) * 100));
  const fill = $('#meterFill');
  fill.style.width = on ? `${pos(S.lastDb)}%` : '0';
  fill.classList.toggle('over', on && S.vad && S.vad.active);
  $('#meterFloor').style.left = on && S.vad && S.vad.floor != null ? `${pos(S.vad.floor)}%` : '0';
  $('#meterThresh').style.left = on && S.vad && S.vad.floor != null ? `${pos(S.vad.floor + settings.sensitivityDb)}%` : '0';
}

function uiTick() {
  if (S.phase === 'listening' && settings.promptAfterMin > 0 && promptsLeft()) {
    if (now() - S.lastActivity >= settings.promptAfterMin * 60) askPrompt('Stille');
  }
  renderStatus();
}

// Sperre: schwarzer Bildschirm, schluckt alle Berührungen; Entsperren per Ziehen
function showNight(on) {
  $('#night').hidden = !on;
  resetKnob();
}
let drag = null;
function resetKnob() {
  const knob = $('#unlockKnob');
  knob.style.transform = 'translate(0, 0)';
  knob.classList.remove('dragging');
  $('#unlockTarget').classList.remove('hit');
  drag = null;
}
function inside(rect, x, y, pad = 0) {
  return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
}
function bindNight() {
  const el = $('#night');
  const knob = $('#unlockKnob');
  const target = $('#unlockTarget');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (drag) return;
    if (!inside(knob.getBoundingClientRect(), e.clientX, e.clientY, 12)) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
    knob.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  el.addEventListener('pointermove', (e) => {
    e.preventDefault();
    if (!drag || e.pointerId !== drag.id) return;
    knob.style.transform = `translate(${e.clientX - drag.x0}px, ${e.clientY - drag.y0}px)`;
    target.classList.toggle('hit', inside(target.getBoundingClientRect(), e.clientX, e.clientY));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const ok = e.type === 'pointerup' && inside(target.getBoundingClientRect(), e.clientX, e.clientY);
    resetKnob();
    if (ok) { showNight(false); log('Entsperrt'); }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'dblclick', 'contextmenu'].forEach((t) =>
    el.addEventListener(t, (e) => e.preventDefault(), { passive: false })
  );
}

// ---------------------------------------------------------------------------
// Aufnahmen-Liste
// ---------------------------------------------------------------------------
let recUrls = [];
function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}
function extFor(mime = '') {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

async function renderRecordings() {
  const box = $('#recordings');
  recUrls.forEach((u) => URL.revokeObjectURL(u));
  recUrls = [];
  let recs = [];
  try { recs = await db.listRecordings(); } catch {
    box.innerHTML = '<p class="muted">Aufnahmen konnten nicht geladen werden.</p>';
    return;
  }
  if (!recs.length) {
    box.innerHTML = '<p class="muted">Noch keine Aufnahmen.</p>';
    return;
  }
  box.innerHTML = '';
  recs.sort((a, b) => b.ts - a.ts);
  let lastDay = '';
  for (const r of recs) {
    const day = new Date(r.ts).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    if (day !== lastDay) {
      const h = document.createElement('div');
      h.className = 'rec-date';
      h.textContent = day;
      box.append(h);
      lastDay = day;
    }
    const url = URL.createObjectURL(r.blob);
    recUrls.push(url);
    const el = document.createElement('div');
    el.className = 'rec';
    const info = [];
    info.push(fmtDur(r.durationSec || 0));
    if (r.prompts != null) info.push(`${r.prompts} Nachfr.`);
    if (r.cycle != null) info.push(`Runde ${r.cycle}`);
    if (r.recovered) info.push('wiederhergestellt');
    el.innerHTML = `
      <div class="rec-head"><span>${fmtTime(r.ts)}</span><span></span></div>
      <audio controls preload="metadata"></audio>
      <div class="rec-actions"><a download>Herunterladen</a><button class="small">Löschen</button></div>`;
    $('.rec-head span:last-child', el).textContent = info.join(' · ');
    $('audio', el).src = url;
    const a = $('a', el);
    a.href = url;
    a.download = `tagebuch_${fileStamp(r.ts)}.${extFor(r.mime || r.blob.type)}`;
    $('button', el).addEventListener('click', async () => {
      if (!confirmDelete()) return;
      await db.deleteRecording(r.id);
      renderRecordings();
    });
    box.append(el);
  }
}

let pendingDelete = 0;
function confirmDelete() {
  const t = Date.now();
  if (t - pendingDelete < 2500) { pendingDelete = 0; return true; }
  pendingDelete = t;
  showWarn('Zum Löschen noch einmal auf „Löschen“ tippen.');
  setTimeout(hideWarn, 2500);
  return false;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function init() {
  bindSettings();
  bindPrompts();
  bindNight();
  renderRecordings();
  loadLog();
  recoverSessions();

  $('#btnStart').addEventListener('click', startSession);
  $('#btnStop').addEventListener('click', stopSession);
  $('#btnLock').addEventListener('click', () => { showNight(true); log('Gesperrt'); });
  $('#btnAsk').addEventListener('click', () => askPrompt('manuell'));
  $('#btnExportLog').addEventListener('click', async () => {
    const events = await db.listEvents();
    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hypna-log_${fileStamp(Date.now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });
  $('#btnClearLog').addEventListener('click', async () => {
    await db.clearEvents();
    logEl.innerHTML = '';
  });

  S.uiTimer = setInterval(uiTick, 250);
  renderStatus();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!window.isSecureContext) showWarn('Mikrofon braucht HTTPS. Auf GitHub Pages passt das automatisch.');
}

init();

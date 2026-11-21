import { Detector, DETECTOR_DEFAULTS } from './detector.js';
import * as db from './db.js';

const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'hypna.settings.v1';
const DEFAULT_SETTINGS = {
  ...DETECTOR_DEFAULTS,
  delaySec: 30,
  recordSec: 60,
  cycles: 4,
  cooldownSec: 20,
  fallbackMin: 0,
  repeatIncubation: true,
  cancelOnRegrip: true,
  recordEnabled: true,
  keepMicOpen: true,
  autoNight: true,
  chime: true,
  chimeGapSec: 3,
  fadeInSec: 2,
  repeatQuestion: false,
  volume: 0.8,
  questionText: 'Was geht dir gerade durch den Kopf?',
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
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* privater Modus o. Ä. */ }
}

let settings = loadSettings();

function bindSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    const apply = () => {
      if (el.type === 'checkbox') el.checked = !!settings[key];
      else el.value = settings[key];
      const out = $(`[data-out="${key}"]`);
      if (out) out.textContent = key === 'volume' ? `${Math.round(settings[key] * 100)} %` : settings[key];
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
      if (out) out.textContent = key === 'volume' ? `${Math.round(settings[key] * 100)} %` : settings[key];
      saveSettings();
      onSettingsChanged(key);
    });
  });
  $('#btnReset').addEventListener('click', () => {
    const keep = { questionText: settings.questionText, volume: settings.volume };
    settings = { ...DEFAULT_SETTINGS, ...keep };
    saveSettings();
    document.querySelectorAll('[data-setting]').forEach((el) => el._apply && el._apply());
    onSettingsChanged();
  });
}

function onSettingsChanged(key) {
  detector.setOptions({
    calibrationSec: settings.calibrationSec,
    minArmedSec: settings.minArmedSec,
    tiltDeg: settings.tiltDeg,
    tiltHoldSec: settings.tiltHoldSec,
  });
  if (S.gain && (key === 'volume' || key == null)) S.gain.gain.value = settings.volume;
}

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const PHASES = {
  idle: ['Bereit', 'Tippe auf Start und halte das Handy locker in der Hand.'],
  starting: ['Starte …', 'Bitte Berechtigungen erlauben.'],
  intro: ['Inkubation', 'Hör zu und halte das Handy locker.'],
  calibrating: ['Kalibriere', 'Handy ruhig in der Hand halten.'],
  armed: ['Wache', 'Lass dich einfach einschlafen.'],
  waiting: ['Einschlafen erkannt', 'Gleich kommt die Frage.'],
  prompting: ['Frage & Aufnahme', 'Antworte einfach laut.'],
  cooldown: ['Pause', 'Nimm das Handy gleich wieder in die Hand.'],
  waitHand: ['Warte auf dich', 'Nimm das Handy wieder in die Hand und halte es kurz ruhig.'],
  done: ['Fertig', 'Alle Runden sind durch. Deine Aufnahmen findest du unten.'],
};

const detector = new Detector();
const S = {
  phase: 'idle',
  token: 0,
  cycle: 0,
  ctx: null,
  gain: null,
  buffers: {},
  stream: null,
  wakeLock: null,
  recorder: null,
  currentSource: null,
  timers: new Set(),
  phaseEndsAt: null,
  cycleStartedAt: 0,
  samples: 0,
  rate: 0,
  rateWindowStart: 0,
  lastSampleAt: 0,
  sensorWarned: false,
  regripSince: null,
  sawMotion: false,
  stillSince: null,
  lastReason: '',
  sessionId: null,
  uiTimer: null,
};

const now = () => performance.now() / 1000;

function setPhase(phase, { endsInSec = null } = {}) {
  S.phase = phase;
  S.phaseEndsAt = endsInSec != null ? now() + endsInSec : null;
  renderStatus();
}

function later(ms) {
  return new Promise((resolve) => {
    const id = setTimeout(() => {
      S.timers.delete(id);
      resolve();
    }, ms);
    S.timers.add(id);
  });
}

function clearTimers() {
  S.timers.forEach((id) => clearTimeout(id));
  S.timers.clear();
}

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
  const ev = { ts: Date.now(), session: S.sessionId, msg };
  appendLogLine(ev);
  db.addEvent(ev).catch(() => {});
  console.log('[hypna]', msg);
}

async function loadLog() {
  try {
    const events = await db.listEvents();
    events.slice(-200).forEach(appendLogLine);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------
const FILE_KEYS = ['incubation', 'question'];

async function decodeFile(key) {
  const rec = await db.getFile(key);
  if (!rec || !rec.blob) return null;
  const data = await rec.blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    // Callback-Form für ältere Safari-Versionen, Promise-Form für den Rest
    const p = S.ctx.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

function playBuffer(key, { fadeInSec = 0 } = {}) {
  const buf = S.buffers[key];
  if (!buf || !S.ctx) return Promise.resolve(false);
  return new Promise((resolve) => {
    const src = S.ctx.createBufferSource();
    src.buffer = buf;
    const g = S.ctx.createGain();
    const t0 = S.ctx.currentTime;
    if (fadeInSec > 0) {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(1, t0 + fadeInSec);
    }
    src.connect(g);
    g.connect(S.gain);
    src.onended = () => {
      if (S.currentSource === src) S.currentSource = null;
      resolve(true);
    };
    S.currentSource = src;
    src.start();
  });
}

function speak(text) {
  return new Promise((resolve) => {
    if (!text || !('speechSynthesis' in window)) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'de-DE';
    u.volume = settings.volume;
    u.rate = 0.9;
    const voice = speechSynthesis.getVoices().find((v) => v.lang && v.lang.startsWith('de'));
    if (voice) u.voice = voice;
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(true); } };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(finish, 4000 + text.length * 150);
  });
}

// Sanfter Glockenton, synthetisiert: weckt behutsamer als eine plötzliche Stimme
function playChime() {
  if (!S.ctx) return Promise.resolve();
  const t0 = S.ctx.currentTime + 0.05;
  const dur = 3;
  const out = S.ctx.createGain();
  out.gain.setValueAtTime(0.0001, t0);
  out.gain.exponentialRampToValueAtTime(0.35, t0 + 0.04);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  out.connect(S.gain);
  [[523.25, 1], [1046.5, 0.35], [1568, 0.12]].forEach(([f, a]) => {
    const o = S.ctx.createOscillator();
    const og = S.ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    og.gain.value = a;
    o.connect(og);
    og.connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.1);
  });
  return later((dur + 0.1) * 1000);
}

async function playQuestion(token) {
  if (settings.chime) {
    await playChime();
    if (token !== S.token) return;
    await later(settings.chimeGapSec * 1000);
    if (token !== S.token) return;
  }
  const times = settings.repeatQuestion ? 2 : 1;
  for (let i = 0; i < times; i++) {
    if (i > 0) {
      await later(4000);
      if (token !== S.token) return;
    }
    if (S.buffers.question) await playBuffer('question', { fadeInSec: i === 0 ? settings.fadeInSec : 0 });
    else await speak(settings.questionText);
    if (token !== S.token) return;
  }
}

// Prüft beim Auswählen, ob der Browser das Format abspielen kann
async function canDecode(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return true;
  const ctx = new Ctx();
  try {
    const data = await blob.arrayBuffer();
    await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    return true;
  } catch {
    return false;
  } finally {
    ctx.close().catch(() => {});
  }
}

function unlockAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  S.ctx = new Ctx();
  S.gain = S.ctx.createGain();
  S.gain.gain.value = settings.volume;
  S.gain.connect(S.ctx.destination);
  S.ctx.resume();
  // Kurzer stiller Puffer entsperrt die Wiedergabe auf iOS
  const silent = S.ctx.createBuffer(1, 1, 22050);
  const src = S.ctx.createBufferSource();
  src.buffer = silent;
  src.connect(S.ctx.destination);
  src.start(0);
  // Sprachausgabe ebenfalls im Nutzer-Tap entsperren
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
}

// ---------------------------------------------------------------------------
// Mikrofon & Aufnahme
// ---------------------------------------------------------------------------
function getMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  });
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function extFor(mime) {
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

async function startRecorder() {
  let stream = S.stream;
  let temporary = false;
  if (!stream || !stream.active) {
    stream = await getMic();
    if (settings.keepMicOpen) S.stream = stream;
    else temporary = true;
  }
  const mime = pickMime();
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const startedAt = Date.now();
  mr.start(1000);

  const handle = {
    stop() {
      return new Promise((resolve) => {
        if (S.recorder === handle) S.recorder = null;
        const finish = () => {
          if (temporary) stream.getTracks().forEach((t) => t.stop());
          if (!chunks.length) return resolve(null);
          const type = mr.mimeType || mime || chunks[0].type || 'audio/webm';
          resolve({
            blob: new Blob(chunks, { type }),
            mime: type,
            startedAt,
            durationSec: (Date.now() - startedAt) / 1000,
          });
        };
        if (mr.state === 'inactive') return finish();
        mr.onstop = finish;
        mr.stop();
      });
    },
  };
  S.recorder = handle;
  return handle;
}

async function saveRecording(r, cycle) {
  if (!r) return;
  await db.addRecording({
    ts: r.startedAt,
    session: S.sessionId,
    cycle,
    reason: S.lastReason,
    mime: r.mime,
    durationSec: r.durationSec,
    blob: r.blob,
  });
  log(`Aufnahme gespeichert (${Math.round(r.durationSec)} s)`);
  renderRecordings();
}

// ---------------------------------------------------------------------------
// Bildschirm wach halten
// ---------------------------------------------------------------------------
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) {
    showWarn('Dieser Browser kann den Bildschirm nicht wach halten. Stell die automatische Sperre in den Einstellungen ab.');
    return;
  }
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; });
  } catch (e) {
    log(`Wake Lock fehlgeschlagen: ${e.message}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (S.phase === 'idle' || S.phase === 'done') return;
  if (document.visibilityState === 'visible') {
    log('App wieder im Vordergrund');
    if (!S.wakeLock) requestWakeLock();
    if (S.ctx && S.ctx.state !== 'running') S.ctx.resume();
  } else {
    log('Achtung: App im Hintergrund – Sensoren pausieren');
  }
});

// ---------------------------------------------------------------------------
// Bewegungssensor
// ---------------------------------------------------------------------------
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const t = now();
  S.samples++;
  S.lastSampleAt = t;
  const ev = detector.update(t, a.x, a.y, a.z);
  if (ev && ev.type === 'armed') onArmed();
  if (ev && ev.type === 'trigger') onTrigger(ev.reason, ev.angle);
  phaseChecks(t);
}

function phaseChecks(t) {
  // In der Wartezeit: Handy wieder richtig in der Hand? Dann warst du wohl doch wach.
  if (S.phase === 'waiting' && settings.cancelOnRegrip && S.lastReason !== 'Test') {
    if (detector.angle < settings.tiltDeg / 2) {
      if (S.regripSince == null) S.regripSince = t;
      if (t - S.regripSince >= 3) {
        log('Handy wieder in der Hand – Auslösung abgebrochen');
        clearTimers();
        S.token++;
        detector.rearm(t);
        S.regripSince = null;
        setPhase('armed');
      }
    } else {
      S.regripSince = null;
    }
  }

  // Nach einer Runde: warten, bis das Handy aufgenommen und ruhig gehalten wird
  if (S.phase === 'waitHand') {
    if (detector.lastLin > 1.5) {
      S.sawMotion = true;
      S.stillSince = null;
    }
    if (S.sawMotion && detector.activity < 0.35) {
      if (S.stillSince == null) S.stillSince = t;
      if (t - S.stillSince >= 2) {
        S.sawMotion = false;
        S.stillSince = null;
        startCalibration();
      }
    } else if (detector.activity >= 0.35) {
      S.stillSince = null;
    }
  }
}

function startCalibration() {
  detector.startCalibration(now());
  setPhase('calibrating', { endsInSec: settings.calibrationSec });
  log('Kalibriere Halte-Lage');
}

function onArmed() {
  setPhase('armed');
  log(`Scharf geschaltet (Runde ${S.cycle + 1}/${settings.cycles})`);
}

function onTrigger(reason, angle) {
  if (!['armed', 'waitHand', 'calibrating'].includes(S.phase)) return;
  detector.pause();
  S.lastReason = reason;
  S.regripSince = null;
  const delay = reason === 'Test' ? 3 : settings.delaySec;
  log(`Auslösung: ${reason}${angle ? ` (${Math.round(angle)}°)` : ''} – warte ${delay} s`);
  setPhase('waiting', { endsInSec: delay });
  const token = ++S.token;
  later(delay * 1000).then(() => {
    if (token === S.token) runPrompt(token);
  });
}

// ---------------------------------------------------------------------------
// Ablauf einer Runde
// ---------------------------------------------------------------------------
async function runPrompt(token) {
  const cycle = S.cycle + 1;
  setPhase('prompting');
  log(`Runde ${cycle}: Frage`);
  let rec = null;
  try {
    if (settings.recordEnabled) rec = await startRecorder();
  } catch (e) {
    log(`Aufnahme konnte nicht starten: ${e.message}`);
  }
  await playQuestion(token);
  if (token !== S.token) return;
  S.phaseEndsAt = now() + settings.recordSec;
  await later(settings.recordSec * 1000);
  if (token !== S.token) return;
  if (rec) await saveRecording(await rec.stop(), cycle);

  S.cycle = cycle;
  if (S.cycle >= settings.cycles) {
    await finishSession('Alle Runden abgeschlossen');
    setPhase('done');
    return;
  }

  setPhase('cooldown', { endsInSec: settings.cooldownSec });
  if (settings.repeatIncubation && S.buffers.incubation) {
    await playBuffer('incubation');
    if (token !== S.token) return;
  }
  await later(settings.cooldownSec * 1000);
  if (token !== S.token) return;

  S.sawMotion = false;
  S.stillSince = null;
  S.cycleStartedAt = now();
  detector.pause();
  setPhase('waitHand');
}

async function startSession() {
  $('#btnStart').disabled = true;
  hideWarn();
  setPhase('starting');

  try {
    // Alles, was eine Nutzergeste braucht, zuerst
    unlockAudio();
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      let res = 'denied';
      try { res = await DeviceMotionEvent.requestPermission(); } catch { /* manche Browser werfen statt "denied" */ }
      if (res !== 'granted') {
        const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
          (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        if (isIOS) throw new Error('Bewegungssensor wurde nicht erlaubt. In Safari: Einstellungen › Apps › Safari › Bewegung & Ausrichtung.');
        log('Bewegungssensor nicht ausdrücklich erlaubt – versuche es trotzdem');
      }
    }
    if (typeof DeviceMotionEvent === 'undefined') throw new Error('Dieses Gerät hat keinen Bewegungssensor.');

    if (settings.recordEnabled) {
      if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined')
        throw new Error('Aufnahme wird von diesem Browser nicht unterstützt.');
      const stream = await getMic();
      if (settings.keepMicOpen) S.stream = stream;
      else stream.getTracks().forEach((t) => t.stop());
    }

    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    await requestWakeLock();

    S.buffers = {};
    for (const key of FILE_KEYS) {
      try {
        const buf = await decodeFile(key);
        if (buf) S.buffers[key] = buf;
      } catch (e) {
        log(`Audiodatei „${key}“ konnte nicht gelesen werden: ${e.message}`);
      }
    }
  } catch (e) {
    showWarn(e.message || String(e));
    await finishSession(`Start fehlgeschlagen: ${e.message}`);
    setPhase('idle');
    return;
  }

  S.sessionId = new Date().toISOString();
  S.cycle = 0;
  S.token++;
  S.samples = 0;
  S.rate = 0;
  S.rateWindowStart = now();
  S.lastSampleAt = now();
  S.sensorWarned = false;
  detector.mode = 'idle';
  detector.base = null;
  detector.g = null;
  detector.lastT = null;
  onSettingsChanged();
  window.addEventListener('devicemotion', onMotion);

  log(`Session gestartet (${settings.cycles} Runden, Frage: ${S.buffers.question ? 'Datei' : 'Sprachausgabe'})`);
  toggleRunningUI(true);
  if (settings.autoNight) showNight(true);

  const token = S.token;
  S.cycleStartedAt = now();
  if (S.buffers.incubation) {
    setPhase('intro');
    await playBuffer('incubation');
    if (token !== S.token) return;
  }
  startCalibration();
}

async function finishSession(reason) {
  S.token++;
  clearTimers();
  window.removeEventListener('devicemotion', onMotion);
  if (S.currentSource) {
    try { S.currentSource.stop(); } catch { /* schon beendet */ }
    S.currentSource = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (S.recorder) {
    try { await saveRecording(await S.recorder.stop(), S.cycle + 1); } catch { /* ignore */ }
  }
  if (S.stream) {
    S.stream.getTracks().forEach((t) => t.stop());
    S.stream = null;
  }
  if (S.wakeLock) {
    try { await S.wakeLock.release(); } catch { /* ignore */ }
    S.wakeLock = null;
  }
  if (S.ctx) {
    try { await S.ctx.close(); } catch { /* ignore */ }
    S.ctx = null;
    S.gain = null;
  }
  detector.mode = 'idle';
  if (reason) log(reason);
  toggleRunningUI(false);
  showNight(false);
  $('#btnStart').disabled = false;
}

// ---------------------------------------------------------------------------
// Anzeige
// ---------------------------------------------------------------------------
function showWarn(msg) {
  const el = $('#warn');
  el.textContent = msg;
  el.hidden = false;
}
function hideWarn() {
  $('#warn').hidden = true;
}

function toggleRunningUI(running) {
  $('#btnStart').hidden = running;
  $('#btnStop').hidden = !running;
  $('#btnNight').hidden = !running;
  $('#btnTest').hidden = !running;
}

function phaseText() {
  const [title, detail] = PHASES[S.phase] || [S.phase, ''];
  let extra = '';
  const t = now();
  if (S.phaseEndsAt) {
    const left = Math.max(0, Math.ceil(S.phaseEndsAt - t));
    extra = ` · noch ${left} s`;
  } else if (S.phase === 'armed') {
    const left = Math.ceil(detector.armedRemaining(t));
    if (left > 0) extra = ` · scharf in ${left} s`;
  }
  return [title + extra, detail];
}

function renderStatus() {
  const [title, detail] = phaseText();
  $('#phase').textContent = title;
  $('#phaseDetail').textContent = detail;
  $('#nightPhase').textContent = title;

  const running = !['idle', 'done', 'starting'].includes(S.phase);
  const hasBase = running && detector.base;
  $('#statAngle').textContent = hasBase ? `${Math.round(detector.angle)}°` : '–';
  $('#statActivity').textContent = running && detector.g ? detector.activity.toFixed(2) : '–';
  $('#statCycle').textContent = running || S.phase === 'done' ? `${Math.min(S.cycle + 1, settings.cycles)}/${settings.cycles}` : '–';
  $('#statRate').textContent = running ? `${Math.round(S.rate)} Hz` : '–';

  const max = 90;
  const pct = hasBase ? Math.min(100, (detector.angle / max) * 100) : 0;
  const fill = $('#meterFill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('over', hasBase && detector.angle > settings.tiltDeg);
  $('#meterMark').style.left = `${(settings.tiltDeg / max) * 100}%`;
}

function uiTick() {
  const t = now();
  const running = !['idle', 'done', 'starting'].includes(S.phase);
  if (running) {
    if (t - S.rateWindowStart >= 1) {
      S.rate = S.samples / (t - S.rateWindowStart);
      S.samples = 0;
      S.rateWindowStart = t;
    }
    if (t - S.lastSampleAt > 5 && !S.sensorWarned && document.visibilityState === 'visible') {
      S.sensorWarned = true;
      log('Keine Sensordaten seit 5 s – unterstützt das Gerät den Bewegungssensor?');
      showWarn('Keine Sensordaten. Auf dem Desktop gibt es keinen Bewegungssensor; der Sicherheits-Timer funktioniert trotzdem.');
    }
    // Sicherheits-Timer
    if (settings.fallbackMin > 0 && ['armed', 'waitHand'].includes(S.phase)) {
      if (t - S.cycleStartedAt >= settings.fallbackMin * 60) onTrigger('Timer');
    }
  }
  renderStatus();
}

// Sperre / Nachtmodus: schwarzer Bildschirm, der alle Berührungen schluckt.
// Ruhende Finger (z. B. das Handy zwischen Zeige- und Mittelfinger) lösen nichts aus.
// Entsperren nur, wenn ein Finger IM Startpunkt aufsetzt und bis in den Zielkreis zieht.
function showNight(on) {
  $('#night').hidden = !on;
  resetKnob();
}

let drag = null; // { id, x0, y0 }

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
  const swallow = (e) => e.preventDefault();

  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (drag) return; // es zieht schon ein Finger
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
    if (ok) {
      showNight(false);
      log('Entsperrt');
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  // Alles andere schlucken: kein Scrollen, Zoomen, Kontextmenü, Doppeltipp
  ['touchstart', 'touchmove', 'touchend', 'gesturestart', 'dblclick', 'contextmenu'].forEach((t) =>
    el.addEventListener(t, swallow, { passive: false })
  );
}

// ---------------------------------------------------------------------------
// Dateiauswahl
// ---------------------------------------------------------------------------
let previewAudio = null;

async function refreshFileRow(row) {
  const key = row.dataset.key;
  const rec = await db.getFile(key).catch(() => null);
  $('[data-name]', row).textContent = rec ? rec.name : 'keine Datei';
  $('[data-preview]', row).disabled = !rec;
  $('[data-remove]', row).disabled = !rec;
}

function bindFiles() {
  document.querySelectorAll('.file-row').forEach((row) => {
    const key = row.dataset.key;
    $('[data-input]', row).addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!(await canDecode(file))) {
        e.target.value = '';
        showWarn(`„${file.name}“ kann dieser Browser nicht abspielen. Bitte als MP3, M4A oder WAV exportieren.`);
        return;
      }
      hideWarn();
      await db.putFile(key, { name: file.name, type: file.type, blob: file });
      e.target.value = '';
      refreshFileRow(row);
    });
    $('[data-preview]', row).addEventListener('click', async () => {
      if (previewAudio) {
        previewAudio.pause();
        URL.revokeObjectURL(previewAudio.src);
        previewAudio = null;
        return;
      }
      const rec = await db.getFile(key);
      if (!rec) return;
      previewAudio = new Audio(URL.createObjectURL(rec.blob));
      previewAudio.volume = settings.volume;
      previewAudio.onended = () => { URL.revokeObjectURL(previewAudio.src); previewAudio = null; };
      previewAudio.play().catch((err) => showWarn(`Abspielen fehlgeschlagen: ${err.message}`));
    });
    $('[data-remove]', row).addEventListener('click', async () => {
      await db.deleteFile(key);
      refreshFileRow(row);
    });
    refreshFileRow(row);
  });
}

// ---------------------------------------------------------------------------
// Aufnahmen
// ---------------------------------------------------------------------------
let recUrls = [];

function fileStamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function renderRecordings() {
  const box = $('#recordings');
  recUrls.forEach((u) => URL.revokeObjectURL(u));
  recUrls = [];
  let recs = [];
  try {
    recs = await db.listRecordings();
  } catch {
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
    el.innerHTML = `
      <div class="rec-head"><span>${fmtTime(r.ts)} · Runde ${r.cycle ?? '?'}</span><span>${Math.round(r.durationSec || 0)} s · ${r.reason || ''}</span></div>
      <audio controls preload="metadata"></audio>
      <div class="rec-actions"><a download>Herunterladen</a><button class="small">Löschen</button></div>`;
    $('audio', el).src = url;
    const a = $('a', el);
    a.href = url;
    a.download = `traum_${fileStamp(r.ts)}_r${r.cycle ?? 0}.${extFor(r.mime || '')}`;
    $('button', el).addEventListener('click', async () => {
      if (!confirmDelete()) return;
      await db.deleteRecording(r.id);
      renderRecordings();
    });
    box.append(el);
  }
}

// Bewusst ohne window.confirm, um Browser-Dialoge zu vermeiden: zweimal tippen
let pendingDelete = 0;
function confirmDelete() {
  const t = Date.now();
  if (t - pendingDelete < 2500) {
    pendingDelete = 0;
    return true;
  }
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
  bindFiles();
  bindNight();
  onSettingsChanged();
  renderRecordings();
  loadLog();

  $('#btnStart').addEventListener('click', startSession);
  $('#btnStop').addEventListener('click', async () => {
    await finishSession('Session gestoppt');
    setPhase('idle');
  });
  $('#btnNight').addEventListener('click', () => {
    showNight(true);
    log('Gesperrt');
  });
  $('#btnTest').addEventListener('click', () => {
    if (['armed', 'waitHand', 'calibrating'].includes(S.phase)) onTrigger('Test');
    else showWarn('Test geht nur, während die App wacht.');
  });
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  if (!window.isSecureContext) {
    showWarn('Sensoren und Mikrofon brauchen HTTPS. Auf GitHub Pages passt das automatisch.');
  }
}

init();

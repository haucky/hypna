// Reine Audio-Logik ohne DOM: Resampling, Sprach-Erkennung (VAD), Stille-Entfernung, WAV.
// Läuft im Browser und in Node (für Tests).

export const RATE = 16000;          // Aufnahme-Abtastrate (Sprache)
export const FRAME = 320;           // 20 ms bei 16 kHz

// Einfacher Mittelwert-Dezimierer: gut genug für Sprache, ohne Abhängigkeiten.
export class Resampler {
  constructor(from, to = RATE) {
    this.ratio = from / to;
    this.t = 0;
    this.sum = 0;
    this.count = 0;
  }
  process(input) {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.t += 1;
      if (this.t >= this.ratio) {
        out[n++] = this.sum / this.count;
        this.t -= this.ratio;
        this.sum = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

// Zerlegt einen fortlaufenden Strom in 20-ms-Frames.
export class Framer {
  constructor(size = FRAME) {
    this.size = size;
    this.buf = new Float32Array(size);
    this.n = 0;
  }
  push(samples, onFrame) {
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.n++] = samples[i];
      if (this.n === this.size) {
        onFrame(this.buf);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
  }
}

export function frameDb(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  const rms = Math.sqrt(s / frame.length);
  return 20 * Math.log10(rms + 1e-9);
}

// Sprach-Erkennung über einen mitlaufenden Grundrausch-Pegel.
// Sprache = Pegel deutlich über dem Grundrauschen. Der Grundpegel fällt schnell
// (Pausen zwischen Wörtern) und steigt langsam (lautere Umgebung).
export class Vad {
  constructor({ sensitivityDb = 12, minDb = -70, onsetFrames = 3, hangFrames = 15 } = {}) {
    this.sensitivityDb = sensitivityDb;
    this.minDb = minDb;
    this.onsetFrames = onsetFrames;
    this.hangFrames = hangFrames;
    this.floor = null;
    this.above = 0;
    this.below = 0;
    this.active = false;
    this.db = -100;
  }
  process(frame) {
    const db = frameDb(frame);
    this.db = db;
    if (this.floor == null) this.floor = db;
    if (db < this.floor) this.floor += (db - this.floor) * 0.3;
    else this.floor += Math.min(0.02, (db - this.floor) * 0.01); // max. ~1 dB/s
    const loud = db > this.floor + this.sensitivityDb && db > this.minDb;
    if (loud) {
      this.above++;
      this.below = 0;
      if (this.above >= this.onsetFrames) this.active = true;
    } else {
      this.below++;
      this.above = 0;
      if (this.below >= this.hangFrames) this.active = false;
    }
    return this.active;
  }
}

// Schneidet Stille heraus, die länger als maxSilenceSec dauert.
// Kürzere Pausen bleiben erhalten (natürlicher Sprechfluss).
export class Segmenter {
  constructor({ rate = RATE, frame = FRAME, maxSilenceSec = 5, preRollSec = 0.5, tailSec = 0.6, maxSegmentSec = 60 } = {}) {
    const f = rate / frame;
    this.maxSilence = Math.round(maxSilenceSec * f);
    this.preRollN = Math.round(preRollSec * f);
    this.tailN = Math.round(tailSec * f);
    this.maxSegN = Math.round(maxSegmentSec * f);
    this.preroll = [];
    this.cur = null;
    this.silent = 0;
    this.contiguous = false;
  }

  setMaxSilence(sec, rate = RATE, frame = FRAME) {
    this.maxSilence = Math.round(sec * (rate / frame));
  }

  get inSegment() {
    return this.cur !== null;
  }

  // frame: Float32Array (wird kopiert), speech: boolean. Gibt fertige Abschnitte zurück.
  push(frame, speech) {
    const out = [];
    const f = frame.slice();
    if (speech) {
      if (!this.cur) {
        this.cur = this.preroll;
        this.preroll = [];
        this.contiguous = false;
      }
      this.cur.push(f);
      this.silent = 0;
    } else if (this.cur) {
      this.cur.push(f);
      this.silent++;
      if (this.silent > this.maxSilence) {
        const keep = Math.max(0, this.cur.length - this.silent + this.tailN);
        this.cur.length = keep;
        if (keep) out.push(this.emit());
        this.cur = null;
        this.silent = 0;
      }
    } else {
      this.preroll.push(f);
      if (this.preroll.length > this.preRollN) this.preroll.shift();
    }
    // Sehr lange Abschnitte zwischendurch speichern (Absturzsicherheit, Speicher)
    if (this.cur && this.cur.length >= this.maxSegN && this.silent === 0) {
      out.push(this.emit());
      this.cur = [];
      this.contiguous = true;
    }
    return out;
  }

  // Aktuellen Abschnitt sofort abschließen (z. B. vor einer Nachfrage oder am Ende).
  flush() {
    if (!this.cur || !this.cur.length) {
      this.cur = null;
      return [];
    }
    const trailing = Math.max(0, this.silent - this.tailN);
    this.cur.length = this.cur.length - trailing;
    const seg = this.cur.length ? [this.emit()] : [];
    this.cur = null;
    this.silent = 0;
    this.preroll = [];
    return seg;
  }

  emit() {
    const n = this.cur.reduce((a, b) => a + b.length, 0);
    const pcm = new Float32Array(n);
    let o = 0;
    for (const fr of this.cur) {
      pcm.set(fr, o);
      o += fr.length;
    }
    const seg = { pcm, contiguous: this.contiguous };
    this.contiguous = false;
    return seg;
  }
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function wavHeader(dataBytes, rate, channels = 1) {
  const h = new DataView(new ArrayBuffer(44));
  const str = (o, s) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  h.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, channels, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * channels * 2, true);
  h.setUint16(32, channels * 2, true);
  h.setUint16(34, 16, true);
  str(36, 'data');
  h.setUint32(40, dataBytes, true);
  return h.buffer;
}

// Setzt gespeicherte Abschnitte zu einer WAV-Datei zusammen.
// chunks: [{ pcm: Int16Array|ArrayBuffer, contiguous }]
// Zwischen nicht zusammenhängenden Abschnitten kommt eine kurze Pause.
export function assembleWavParts(chunks, rate = RATE, gapSec = 0.6) {
  const gap = new Int16Array(Math.round(gapSec * rate));
  const parts = [];
  let bytes = 0;
  chunks.forEach((c, i) => {
    const pcm = c.pcm instanceof Int16Array ? c.pcm : new Int16Array(c.pcm);
    if (i > 0 && !c.contiguous) {
      parts.push(gap);
      bytes += gap.byteLength;
    }
    parts.push(pcm);
    bytes += pcm.byteLength;
  });
  return { parts: [wavHeader(bytes, rate), ...parts], seconds: bytes / 2 / rate };
}

// Zum Abspielen/Normalisieren erzeugter Sprache
export function normalize(f32, peak = 0.85) {
  let m = 0;
  for (let i = 0; i < f32.length; i++) m = Math.max(m, Math.abs(f32[i]));
  if (!m) return f32;
  const g = peak / m;
  const out = new Float32Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = f32[i] * g;
  return out;
}

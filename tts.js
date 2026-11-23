// Kyutai Pocket TTS im Browser (über pocket-tts-onnx, gebündelt in vendor/).
// Das Modell (~180 MB) lädt das Handy einmal von Hugging Face; die Bibliothek
// legt es danach im Cache des Browsers ab.
import { normalize, floatToInt16, wavHeader } from './audio-core.js';

let enginePromise = null;

export function loadEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = import('./vendor/pocket-tts.js')
      .then(({ Engine }) =>
        Engine.load({
          language: 'german',
          ortWasmUrl: new URL('./vendor/ort/', location.href).href,
          worker: () => new Worker(new URL('./vendor/pocket-tts-worker.js', location.href), { type: 'module' }),
          onProgress,
        })
      )
      .catch((e) => {
        enginePromise = null;
        throw e;
      });
  }
  return enginePromise;
}

export async function disposeEngine() {
  if (!enginePromise) return;
  try {
    (await enginePromise).dispose();
  } catch { /* war nie geladen */ }
  enginePromise = null;
}

// Bringt Audio auf eine andere Abtastrate (über OfflineAudioContext, hohe Qualität).
export async function resampleTo(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const len = Math.ceil((pcm.length * toRate) / fromRate);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(1, len, toRate);
  const buf = ctx.createBuffer(1, pcm.length, fromRate);
  buf.copyToChannel(pcm, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return out.getChannelData(0).slice();
}

// Klont eine Stimme aus einer Aufnahme. Der Worker behält die Stimme, bis er beendet wird.
// Rückgabe: ein Float32Array, das als `voice` an synthesize übergeben wird.
export async function cloneVoice(engine, pcm, rate, onProgress) {
  const samples = await resampleTo(pcm, rate, engine.sampleRate);
  await engine.clone(samples.subarray(0, engine.sampleRate * 20), onProgress);
  return samples; // Platzhalter: der Worker setzt dafür die geklonte Stimme ein
}

// Erzeugt einen Satz als WAV-Blob (mit kurzer Stille vorn und hinten).
// voice: Name einer eingebauten Stimme oder das Ergebnis von cloneVoice.
export async function synthesize(engine, text, voice, { temperature } = {}) {
  const frames = [];
  const opts = {};
  if (temperature != null) opts.temperature = temperature;
  for await (const f of engine.speak(text, voice || engine.defaultVoice, opts)) frames.push(f);
  const n = frames.reduce((a, f) => a + f.length, 0);
  const rate = engine.sampleRate;
  const lead = Math.round(0.4 * rate);
  const tail = Math.round(0.4 * rate);
  const audio = new Float32Array(lead + n + tail);
  let o = lead;
  for (const f of frames) {
    audio.set(f, o);
    o += f.length;
  }
  const pcm = floatToInt16(normalize(audio, 0.8));
  return new Blob([wavHeader(pcm.byteLength, rate), pcm], { type: 'audio/wav' });
}

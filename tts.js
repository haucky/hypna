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

// Erzeugt einen Satz als WAV-Blob (mit kurzer Stille vorn und hinten).
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

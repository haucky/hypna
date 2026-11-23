// Tests für Sprach-Erkennung und Stille-Entfernung mit synthetischem Audio.
// Ausführen: node --experimental-default-type=module test/audio-core.test.mjs
import assert from 'node:assert/strict';
import { Resampler, Framer, Vad, Segmenter, assembleWavParts, floatToInt16, RATE, FRAME } from '../audio-core.js';

const SR = 48000;
function noise(sec, amp) {
  const a = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 2 - 1) * amp;
  return a;
}
function voice(sec, amp = 0.2) {
  // "Sprache": Ton mit Silben-Modulation (4 Hz) plus Rauschen
  const a = new Float32Array(Math.round(sec * SR));
  for (let i = 0; i < a.length; i++) {
    const t = i / SR;
    const env = Math.max(0, Math.sin(2 * Math.PI * 3 * t)); // Silben mit kurzen Lücken
    a[i] = amp * env * Math.sin(2 * Math.PI * 180 * t) + (Math.random() * 2 - 1) * 0.003;
  }
  return a;
}

// Spielt ein Skript aus [typ, sekunden] durch die ganze Kette und liefert die Abschnitte
function run(script, opts = {}) {
  const rs = new Resampler(SR, RATE);
  const fr = new Framer(FRAME);
  const vad = new Vad();
  const seg = new Segmenter({ maxSilenceSec: 5, ...opts });
  const out = [];
  let speechFrames = 0;
  for (const [kind, sec] of script) {
    const src = kind === 'voice' ? voice(sec) : noise(sec, 0.003);
    for (let i = 0; i < src.length; i += 2048) {
      fr.push(rs.process(src.subarray(i, i + 2048)), (f) => {
        const s = vad.process(f);
        if (s) speechFrames++;
        out.push(...seg.push(f, s));
      });
    }
  }
  out.push(...seg.flush());
  return { out, speechFrames };
}
const dur = (segs) => segs.reduce((a, s) => a + s.pcm.length, 0) / RATE;

// 1) Reine Stille: nichts wird aufgenommen
{
  const { out } = run([['silence', 60]]);
  assert.equal(out.length, 0, 'Stille darf nichts aufnehmen');
  console.log('ok – 60 s Stille: keine Aufnahme');
}

// 2) Sprechen, 3 s Pause, Sprechen: ein Abschnitt, Pause bleibt erhalten
{
  const { out } = run([['silence', 3], ['voice', 4], ['silence', 3], ['voice', 4], ['silence', 2]]);
  assert.equal(out.length, 1, `erwartet 1 Abschnitt, bekam ${out.length}`);
  const d = dur(out);
  assert.ok(d > 10.5 && d < 12.5, `Dauer ${d}`);
  console.log(`ok – kurze Pause bleibt drin (${d.toFixed(1)} s)`);
}

// 3) Sprechen, 60 s Stille, Sprechen: zwei Abschnitte, Stille fast ganz entfernt
{
  const { out } = run([['silence', 2], ['voice', 5], ['silence', 60], ['voice', 5], ['silence', 1]]);
  assert.equal(out.length, 2, `erwartet 2 Abschnitte, bekam ${out.length}`);
  const d = dur(out);
  assert.ok(d < 13, `lange Stille muss raus, Dauer ${d}`);
  const wav = assembleWavParts(out.map((s) => ({ pcm: floatToInt16(s.pcm), contiguous: s.contiguous })));
  assert.ok(wav.seconds < 14, `WAV ${wav.seconds}`);
  console.log(`ok – 60 s Stille entfernt: ${d.toFixed(1)} s statt 72 s`);
}

// 4) Grenzfall: 4,5 s Pause bleibt, 6 s Pause wird geschnitten
{
  const a = run([['silence', 1], ['voice', 3], ['silence', 4.5], ['voice', 3]]);
  assert.equal(a.out.length, 1, '4,5 s Pause darf nicht schneiden');
  const b = run([['silence', 1], ['voice', 3], ['silence', 6], ['voice', 3]]);
  assert.equal(b.out.length, 2, '6 s Pause muss schneiden');
  console.log('ok – Grenze bei 5 s');
}

// 5) Langes Sprechen wird in zusammenhängende Stücke geteilt (Absturzsicherheit)
{
  const { out } = run([['silence', 1], ['voice', 130]], { maxSegmentSec: 60 });
  assert.ok(out.length >= 2, 'muss gestückelt werden');
  assert.ok(out.slice(1).every((s) => s.contiguous), 'Folgestücke sind zusammenhängend');
  const d = dur(out);
  assert.ok(d > 125 && d < 132, `Dauer ${d}`);
  console.log(`ok – 130 s am Stück → ${out.length} zusammenhängende Teile`);
}

// 6) Lauteres Grundrauschen (Ventilator) wird nicht als Sprache erkannt
{
  const rs = new Resampler(SR, RATE);
  const fr = new Framer(FRAME);
  const vad = new Vad();
  let active = 0;
  const src = noise(60, 0.03);
  for (let i = 0; i < src.length; i += 2048) fr.push(rs.process(src.subarray(i, i + 2048)), (f) => { if (vad.process(f)) active++; });
  assert.ok(active < 20, `Rauschen als Sprache erkannt: ${active} Frames`);
  console.log('ok – gleichmäßiges Rauschen ist keine Sprache');
}

console.log('Alle Tests bestanden.');

// Test der Erkennung mit synthetischen Sensordaten: node test/detector.test.mjs
import { Detector } from '../detector.js';
import assert from 'node:assert/strict';

const G = 9.81;
const HZ = 60;

function rnd(a) { return (Math.random() * 2 - 1) * a; }

// Handy steht senkrecht in der Hand (Schwerkraft auf y), Winkel phi kippt Richtung z
function sample(phiDeg, noise = 0.3) {
  const p = (phiDeg * Math.PI) / 180;
  return [rnd(noise), G * Math.cos(p) + rnd(noise), G * Math.sin(p) + rnd(noise)];
}

function run(det, t0, seconds, phiFn, noise) {
  const events = [];
  for (let i = 0; i < seconds * HZ; i++) {
    const t = t0 + i / HZ;
    const ev = det.update(t, ...sample(phiFn(t - t0), noise));
    if (ev) events.push({ ...ev, t });
  }
  return { events, t: t0 + seconds };
}

// 1) Ruhig halten mit kleinem Zittern: kein Auslösen
{
  const d = new Detector({ minArmedSec: 10 });
  d.startCalibration(0);
  const r = run(d, 0, 120, (t) => 8 * Math.sin(t / 3), 0.4);
  assert.equal(r.events[0].type, 'armed');
  assert.ok(!r.events.some((e) => e.type === 'trigger'), 'ruhig halten darf nicht auslösen');
  console.log('ok – ruhig halten löst nicht aus, max. Winkel', Math.round(d.angle));
}

// 2) Hand erschlafft: Handy kippt auf 70° und bleibt dort
{
  const d = new Detector({ minArmedSec: 10, tiltDeg: 40, tiltHoldSec: 1.5 });
  d.startCalibration(0);
  let r = run(d, 0, 40, () => 0, 0.3);
  r = run(d, r.t, 10, (t) => Math.min(70, t * 140), 0.3); // ~0,5 s Kippen
  const trig = r.events.find((e) => e.type === 'trigger');
  assert.ok(trig, 'Kippen muss auslösen');
  const latency = trig.t - 40;
  assert.ok(latency > 1.5 && latency < 3, `Latenz ${latency}`);
  console.log(`ok – Kippen löst nach ${latency.toFixed(2)} s aus`);
}

// 3) Kurzes Wackeln (0,8 s über Schwelle) löst nicht aus
{
  const d = new Detector({ minArmedSec: 5, tiltHoldSec: 1.5 });
  d.startCalibration(0);
  let r = run(d, 0, 20, () => 0, 0.3);
  r = run(d, r.t, 5, (t) => (t > 1 && t < 1.8 ? 60 : 0), 0.3);
  assert.ok(!r.events.some((e) => e.type === 'trigger'), 'kurzes Wackeln darf nicht auslösen');
  console.log('ok – kurzes Wackeln löst nicht aus');
}

// 4) In der Sperrzeit nach dem Scharfschalten wird nicht ausgelöst
{
  const d = new Detector({ minArmedSec: 30 });
  d.startCalibration(0);
  let r = run(d, 0, 10, () => 0, 0.3);
  r = run(d, r.t, 15, () => 80, 0.3);
  assert.ok(!r.events.some((e) => e.type === 'trigger'));
  r = run(d, r.t, 15, () => 80, 0.3);
  assert.ok(r.events.some((e) => e.type === 'trigger'));
  console.log('ok – Sperrzeit wird eingehalten');
}

// 5) Abtastrate egal: 200 Hz verhält sich wie 60 Hz
{
  const d = new Detector({ minArmedSec: 5 });
  d.startCalibration(0);
  let t = 0;
  let trig = null;
  for (; t < 30; t += 1 / 200) {
    const ev = d.update(t, ...sample(t > 15 ? 70 : 0, 0.3));
    if (ev && ev.type === 'trigger') { trig = t; break; }
  }
  assert.ok(trig && trig - 15 > 1.5 && trig - 15 < 2.5, `200 Hz Latenz ${trig - 15}`);
  console.log(`ok – 200 Hz: Auslösung nach ${(trig - 15).toFixed(2)} s`);
}

console.log('Alle Tests bestanden.');

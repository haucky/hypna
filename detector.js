// Einschlaf-Erkennung über den Beschleunigungssensor.
// Idee (wie Edisons Stahlkugel / MIT Dormio): Du hältst das Handy locker in der Hand.
// Beim Einschlafen erschlafft die Hand, das Handy kippt oder rutscht weg.
// Wir messen die Richtung der Schwerkraft relativ zum Gerät und vergleichen sie
// mit der Lage während der Kalibrierung. Kippt das Handy dauerhaft um mehr als
// tiltDeg Grad, gilt das als Einschlafen.

export const DETECTOR_DEFAULTS = {
  calibrationSec: 5,   // so lange wird die "Halte-Lage" gemessen
  minArmedSec: 20,     // nach dem Scharfschalten so lange nicht auslösen
  tiltDeg: 40,         // Kippwinkel, ab dem ausgelöst wird
  tiltHoldSec: 1.5,    // so lange muss der Winkel überschritten bleiben
};

export function angleBetween(a, b) {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const na = Math.hypot(a[0], a[1], a[2]);
  const nb = Math.hypot(b[0], b[1], b[2]);
  if (!na || !nb) return 0;
  const c = Math.min(1, Math.max(-1, dot / (na * nb)));
  return (Math.acos(c) * 180) / Math.PI;
}

export class Detector {
  constructor(opts = {}) {
    this.o = { ...DETECTOR_DEFAULTS, ...opts };
    this.g = null;          // tiefpassgefilterte Schwerkraft
    this.base = null;       // Referenzlage aus der Kalibrierung
    this.lastT = null;
    this.lastLin = 0;       // momentane Bewegung (ohne Schwerkraft), m/s²
    this.activity = 0;      // geglättete Bewegung, m/s²
    this.angle = 0;         // aktueller Kippwinkel zur Referenz, Grad
    this.mode = 'idle';     // idle | calibrating | armed | triggered | paused
    this.tiltSince = null;
    this.armedAt = null;
  }

  setOptions(opts) {
    this.o = { ...this.o, ...opts };
  }

  startCalibration(t) {
    this.mode = 'calibrating';
    this.calStart = t;
    this.calSum = [0, 0, 0];
    this.calN = 0;
    this.tiltSince = null;
  }

  rearm(t) {
    this.mode = 'armed';
    this.armedAt = t;
    this.tiltSince = null;
  }

  pause() {
    this.mode = 'paused';
    this.tiltSince = null;
  }

  armedRemaining(t) {
    if (this.mode !== 'armed') return 0;
    return Math.max(0, this.o.minArmedSec - (t - this.armedAt));
  }

  // t in Sekunden, a* in m/s² (accelerationIncludingGravity)
  update(t, ax, ay, az) {
    const s = [ax, ay, az];
    const dt = this.lastT == null ? 0.016 : Math.min(0.5, Math.max(0.001, t - this.lastT));
    this.lastT = t;

    if (!this.g) {
      this.g = s.slice();
    } else {
      const k = 1 - Math.exp(-dt / 0.15); // Zeitkonstante 150 ms, unabhängig von der Abtastrate
      for (let i = 0; i < 3; i++) this.g[i] += k * (s[i] - this.g[i]);
    }

    this.lastLin = Math.hypot(ax - this.g[0], ay - this.g[1], az - this.g[2]);
    const ka = 1 - Math.exp(-dt / 1.0);
    this.activity += ka * (this.lastLin - this.activity);

    if (this.base) this.angle = angleBetween(this.g, this.base);

    if (this.mode === 'calibrating') {
      for (let i = 0; i < 3; i++) this.calSum[i] += this.g[i];
      this.calN++;
      if (t - this.calStart >= this.o.calibrationSec && this.calN >= 5) {
        this.base = this.calSum.map((v) => v / this.calN);
        this.angle = 0;
        this.rearm(t);
        return { type: 'armed' };
      }
      return null;
    }

    if (this.mode === 'armed') {
      if (t - this.armedAt < this.o.minArmedSec) {
        this.tiltSince = null;
        return null;
      }
      if (this.angle > this.o.tiltDeg) {
        if (this.tiltSince == null) this.tiltSince = t;
        if (t - this.tiltSince >= this.o.tiltHoldSec) {
          this.mode = 'triggered';
          return { type: 'trigger', reason: 'Kippen', angle: this.angle };
        }
      } else {
        this.tiltSince = null;
      }
    }
    return null;
  }
}

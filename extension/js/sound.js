// Sound effects, synthesised in the browser with Web Audio (a port of sound.py).
// No audio files: each effect is built once as an AudioBuffer the first time sound is used.

import { Rng } from './cards.js';

const RATE = 22050;

// ---------- tiny synthesiser ----------
const silence = (seconds) => new Array(Math.floor(RATE * seconds)).fill(0);

function mixInto(base, add, at = 0, gain = 1) {
  const start = Math.floor(RATE * at);
  while (base.length < start + add.length) base.push(0);
  for (let i = 0; i < add.length; i++) base[start + i] += add[i] * gain;
  return base;
}

/** A soft bell-like note: a few harmonics, a quick attack and an exponential decay. */
function tone(freq, seconds, volume = 0.4, decay = 6, attack = 0.005, harmonics = [1, 0.35, 0.12], glide = 0) {
  const n = Math.floor(RATE * seconds), out = new Array(n), phase = harmonics.map(() => 0);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const f = freq * 2 ** ((glide * (i / n)) / 12);
    const env = Math.min(1, t / attack) * Math.exp(-decay * t);
    let v = 0;
    harmonics.forEach((amp, h) => { phase[h] += (2 * Math.PI * f * (h + 1)) / RATE; v += amp * Math.sin(phase[h]); });
    out[i] = v * env * volume;
  }
  return out;
}

/** A filtered noise burst: the snap of a card. Lower `smooth` = duller. */
function noise(seconds, volume = 0.5, decay = 40, smooth = 0.35, rng = new Rng(1)) {
  const out = [];
  let y = 0;
  for (let i = 0; i < Math.floor(RATE * seconds); i++) {
    y += smooth * (rng.random() * 2 - 1 - y);
    out.push(y * Math.exp((-decay * i) / RATE) * volume);
  }
  return out;
}

function cardSnap(volume = 0.7, seed = 1) {
  const snap = noise(0.14, volume, 34, 0.32, new Rng(seed));
  return mixInto(snap, tone(120, 0.16, volume * 0.35, 24, 0.005, [1]));
}

function swish(volume = 0.45) {
  const rng = new Rng(7), n = Math.floor(RATE * 0.32), out = [];
  let y = 0;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    y += (0.05 + 0.22 * p) * (rng.random() * 2 - 1 - y);
    out.push(y * Math.sin(Math.PI * p) * volume);
  }
  return out;
}

/** Three riffle shuffles: bursts of card ticks that speed up a little, a pause between. */
function riffle(seconds = 1.8, riffles = 3) {
  const rng = new Rng(3), out = silence(seconds), span = seconds / riffles;
  for (let r = 0; r < riffles; r++) {
    const start = r * span + 0.05;
    let t = start, gap = 0.045;
    while (t < start + span * 0.62) {
      mixInto(out, noise(0.03, 0.25 + rng.random() * 0.15, 90, 0.35, new Rng(Math.floor(rng.random() * 1e9))), t);
      t += gap * (0.8 + rng.random() * 0.35);
      gap *= 0.985;
    }
    mixInto(out, cardSnap(0.5, r + 10), start + span * 0.66);
  }
  return out;
}

function chord(freqs, seconds, volume = 0.25, decay = 3, spread = 0) {
  const out = [];
  freqs.forEach((f, k) => mixInto(out, tone(f, seconds - k * spread, volume, decay), k * spread));
  return out;
}

function buzz(seconds = 0.8, volume = 0.3) {
  const rough = tone(196, seconds, volume, 2.5, 0.02, [1, 0.6, 0.45, 0.3, 0.2], -3);
  return mixInto(rough, tone(185, seconds, volume * 0.6, 2.5, 0.02, [1, 0.5], -3));
}

const C4 = 261.63, G4 = 392.0, C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880.0, C6 = 1046.5;
const EB4 = 311.13, AB3 = 207.65, F3 = 174.61;

// how loud each sound is at its peak (0-1): kept low so the effects sit in the background
const LEVELS = {
  shuffle: 0.16, deal: 0.1, throw: 0.17, pick: 0.13, turn: 0.15, click: 0.08,
  nope: 0.12, call: 0.2, caught: 0.2, win: 0.22, lose: 0.2, out: 0.2,
};

const BUILDERS = {
  shuffle: () => riffle(),
  deal: () => cardSnap(0.35, 5),
  throw: () => cardSnap(0.7, 2),
  pick: () => swish(),
  turn: () => mixInto(tone(E5, 0.6, 0.22, 4.5, 0.02), tone(A5, 0.8, 0.22, 4, 0.02), 0.22),
  click: () => noise(0.05, 0.35, 90, 0.4),
  nope: () => tone(220, 0.35, 0.25, 8, 0.015, [1, 0.3]),
  call: () => chord([C4, G4, C5], 1.6, 0.2, 2.0, 0.12),
  caught: () => buzz(0.8),
  win: () => chord([C5, E5, G5, C6], 2.2, 0.2, 1.6, 0.24),
  lose: () => chord([G4, EB4, C4], 1.9, 0.2, 1.8, 0.32),
  out: () => mixInto(tone(AB3, 0.9, 0.28, 2.6, 0.02, [1, 0.35, 0.12], -2), tone(F3, 1.2, 0.24, 2.2, 0.02), 0.4),
};

export class Sounds {
  constructor(enabled = true) {
    this.enabled = enabled;
    this.ctx = null;
    this.buffers = {};
    this.available = typeof AudioContext !== 'undefined';
  }

  /** Browsers only start audio after a click or key press; call this from one. */
  unlock() {
    if (!this.available || !this.enabled) return;
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  buffer(name) {
    if (!this.buffers[name]) {
      const samples = BUILDERS[name]();
      const peak = Math.max(1e-9, ...samples.map(Math.abs));
      const scale = LEVELS[name] / peak;
      const buf = this.ctx.createBuffer(1, samples.length, RATE);
      const data = buf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) data[i] = samples[i] * scale;
      this.buffers[name] = buf;
    }
    return this.buffers[name];
  }

  play(name) {
    if (!this.enabled || !this.available || !BUILDERS[name]) return;
    this.unlock();
    if (!this.ctx || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(name);
    src.connect(this.ctx.destination);
    src.start();
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.enabled) this.unlock();
    return this.enabled;
  }
}

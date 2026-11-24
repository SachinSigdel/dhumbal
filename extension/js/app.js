// The Dumbal table in the browser: a port of gui.py onto an HTML canvas.
// Everything (table, cards, buttons, result panel) is drawn on one canvas each frame from the
// game state; clicks are matched against the regions drawn last frame.

import {
  autoGroup, cardText, cardValue, isJoker, isRed, jokerGroup, jokerStandsFor, orderThrow, Rng,
} from './cards.js';
import {
  CALL_LIMITS, CAUGHT_PENALTY, DEFAULT_CALL_LIMIT, HUMAN, MAX_PLAYERS, MIN_PLAYERS, Match, OPENING,
  OPENING_CALL_LIMIT, PICK, QUICK, RACE, RACE_LIMIT, THROW,
} from './game.js';
import { Sounds } from './sound.js';

// ---------- layout (same numbers as the Python window) ----------
const W = 1040, H = 770;
const CX = W / 2, CY = 318, RX = 430, RY = 220;
const HAND_Y = 634, TOAST_Y = CY - 74, BAR_Y = 744;

const BG_TOP = '#0d2418', BG_BOTTOM = '#050f09';
const FELT_EDGE = '#145a2f', FELT_CENTER = '#2e8a4f', FELT_LINE = '#3c9a5c';
const RIM_DARK = '#2e1a0c', RIM = '#5e3a1d', RIM_LIGHT = '#8a5a30', INLAY = '#c9a24a';
const CARD_BG = '#fffdf6', CARD_EDGE = '#9a968a';
const BACK = '#8c1f30', BACK_DARK = '#5e1220';
const GOLD = '#ffd34d', WINNER = '#f2c14e';
const RED = '#c62828', BLACK = '#1b1b1b', JOKER = '#6a1b9a';
const TEXT = '#f4f1e6', MUTED = '#9fc2ab', PANEL = '#0c1f14', OUT_RED = '#c86b6b';
const AVATAR_COLORS = ['#e57373', '#64b5f6', '#81c784', '#ba68c8'];

const BIG = [72, 104], MID = [52, 76], SMALL = [30, 44];

const SHUFFLE_MS = 1800, DEAL_MS = 420, DEAL_GAP_MS = 120, MOVE_MS = 560, MOVE_GAP_MS = 110;
const BOT_THINK_MS = 800, TOAST_MS = 2000, TOAST_FADE_MS = 350;

const FONT = '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
const CARD_FONT = 'Helvetica, Arial, sans-serif';
const font = (size, bold = false, family = FONT) => `${bold ? 'bold ' : ''}${size}px ${family}`;

// ---------- small helpers ----------
function mix(c1, c2, t) {
  const a = [1, 3, 5].map((i) => parseInt(c1.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(c2.slice(i, i + 2), 16));
  return '#' + a.map((x, i) => Math.round(x + (b[i] - x) * t).toString(16).padStart(2, '0')).join('');
}
const ease = (t) => t * t * (3 - 2 * t);
const who = (names) => names.map((n) => (n === HUMAN ? 'You' : n)).join(' and ');
const wins = (names) => who(names) + (names.length === 1 && names[0] !== HUMAN ? ' wins' : ' win');
function describe(cards) {
  const stands = jokerStandsFor(cards);
  return cards.map((c) => cardText(c) + (stands[c] ? ` (as ${stands[c]})` : '')).join('  ');
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`dumbal.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(`dumbal.${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
};

// ---------- the app ----------
class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.animations = true;
    this.botDelayMs = BOT_THINK_MS;
    this.sounds = new Sounds(store.get('sound', true));
    this.settings = { players: 5, jokers: 1, mode: QUICK, callLimit: DEFAULT_CALL_LIMIT, ...store.get('settings', {}) };
    this.match = null;
    this.game = null;
    this.hidden = new Set();
    this.animating = false;
    this.shuffling = false;
    this.dealing = false;        // cards are still being dealt: nobody is playing yet
    this.token = 0;
    this.pendingBot = null;
    this.flight = null;          // cards in the air
    this.shuffleAnim = null;
    this.toastMsg = '';
    this.toastAt = 0;
    this.autoFinished = null;    // [round you went out, rounds the bots then played]
    this.mouse = { x: -1, y: -1 };
    this.regions = [];
    this.frameQueued = false;
    this.background = this.paintBackground();

    this.fit();
    window.addEventListener('resize', () => this.fit());
    canvas.addEventListener('mousemove', (e) => { this.mouse = this.point(e); this.requestRender(); });
    canvas.addEventListener('mouseleave', () => { this.mouse = { x: -1, y: -1 }; this.requestRender(); });
    canvas.addEventListener('click', (e) => this.onPointer(e, e.shiftKey ? 'shift' : 'click'));
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onPointer(e, 'alt'); });
    window.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'm' && !document.querySelector('#setup:not([hidden])')) this.toggleSound();
    });
    this.setup = new SetupDialog(this);
    this.requestRender();
    this.setup.open();
  }

  // ---------- canvas sizing and input ----------
  fit() {
    const dpr = window.devicePixelRatio || 1;
    this.scale = Math.min(window.innerWidth / W, window.innerHeight / H);
    this.canvas.style.width = `${W * this.scale}px`;
    this.canvas.style.height = `${H * this.scale}px`;
    this.canvas.width = Math.round(W * this.scale * dpr);
    this.canvas.height = Math.round(H * this.scale * dpr);
    this.ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, 0, 0);
    this.requestRender();
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.scale, y: (e.clientY - r.top) / this.scale };
  }

  regionAt(p) {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i];
      if (p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2) return r;
    }
    return null;
  }

  onPointer(e, kind) {
    this.sounds.unlock();
    const r = this.regionAt(this.point(e));
    if (!r) return;
    const handler = r[kind] ?? (kind === 'shift' ? r.click : null);
    if (handler) handler();
  }

  region(x1, y1, x2, y2, handlers) { this.regions.push({ x1, y1, x2, y2, ...handlers }); }

  // ---------- sound ----------
  sfx(name) { this.sounds.play(name); }
  later(ms, fn) { return setTimeout(fn, this.animations ? ms : 0); }

  toggleSound() {
    this.sounds.toggle();
    store.set('sound', this.sounds.enabled);
    this.sfx('click');
    this.requestRender();
  }

  // ---------- game setup ----------
  startGame({ players, jokers, mode, callLimit }) {
    this.settings = { players, jokers, mode, callLimit };
    store.set('settings', this.settings);
    this.match = new Match({ numPlayers: players, jokers, mode, rng: new Rng(), callLimit });
    this.autoFinished = null;
    this.startRound();
  }

  startRound() {
    const match = this.match;
    if (!match || match.over || (match.game && !match.game.over)) return;
    clearTimeout(this.pendingBot);
    this.pendingBot = null;
    this.token += 1;
    this.animating = this.shuffling = false;
    this.flight = this.shuffleAnim = null;
    this.game = match.newRound();
    this.hidden = new Set(Object.values(this.game.hands).flat());
    this.dealing = true;
    this.toast('Shuffling the deck…');
    this.shuffle(() => { this.toast('Dealing…'); this.deal(() => this.afterDeal()); });
  }

  afterDeal() {
    this.hidden = new Set();
    this.dealing = false;
    const game = this.game;
    const first = who([game.players[game.first]]);
    if (game.phase === OPENING && game.currentPlayer === HUMAN) {
      this.toast(`Your hand is ${game.total(HUMAN)}: you may call before anyone throws`);
    } else {
      this.toast(`${first} ${first === 'You' ? 'start' : 'starts'}`);
    }
    this.scheduleBots();
  }

  endRound() {
    let summary = this.match.finishRound();
    const match = this.match;
    if (match.mode === RACE && summary.knockedOut.includes(HUMAN) && !match.over) {
      // you're out: the bots play the rest of the race instantly, then the winner is shown
      const wentOut = summary.number;
      while (!match.over) {
        const g = match.newRound();
        while (!g.over) g.botTurn();
        summary = match.finishRound();
      }
      this.game = match.game;
      this.autoFinished = [wentOut, summary.number - wentOut];
    }
    this.toast('');
    this.requestRender();
    this.sfx('call');
    if (summary.caught) this.later(380, () => this.sfx('caught'));
    let outcome = null;
    if (match.over) outcome = match.winners.includes(HUMAN) ? 'win' : 'lose';
    else if (summary.knockedOut.includes(HUMAN)) outcome = 'out';
    else if (summary.winners.includes(HUMAN)) outcome = 'win';
    else if (summary.knockedOut.length) outcome = 'out';
    if (outcome) this.later(summary.caught ? 900 : 650, () => this.sfx(outcome));
  }

  // ---------- layout ----------
  seatPoint(index, scale = 1) {
    const angle = ((90 + (index * 360) / this.match.seats.length) * Math.PI) / 180;
    return [CX + RX * scale * Math.cos(angle), CY + RY * scale * Math.sin(angle)];
  }
  botSeat(index) {
    let [x, y] = this.seatPoint(index);
    x += (x - CX) * 0.03;
    y += (y - CY) * 0.12;
    return [Math.min(Math.max(x, 105), W - 105), y];
  }
  botCardPos(index, k, n, revealed = false) {
    const [x, y] = this.botSeat(index);
    const step = revealed ? 26 : 16;
    return [x - (step * (n - 1)) / 2 + k * step, y];
  }
  discardSpot(index) {
    const [, seatY] = this.seatPoint(index);
    return this.seatPoint(index, seatY < CY - 1 ? 0.72 : 0.55);
  }
  discardPos(index, k, n) {
    const [x, y] = this.discardSpot(index);
    return [x - (24 * (n - 1)) / 2 + k * 24, y];
  }
  handPos(k, n) {
    const step = BIG[0] + 12;
    return [CX - (step * (n - 1)) / 2 + k * step, HAND_Y];
  }
  deckPos() { return [CX - 50, CY]; }
  cardPos(name, k, n) { return name === HUMAN ? this.handPos(k, n) : this.botCardPos(this.seatOf(name), k, n); }
  seatOf(name) { return this.match.seats.indexOf(name); }
  shownThrow(name) { return this.game.lastThrow[name].filter((c) => this.game.floor.includes(c)); }

  // ---------- animation ----------
  animate(moves, onDone) {
    if (!this.animations) {
      moves.forEach((m) => m.onArrive?.());
      onDone();
      return;
    }
    this.animating = true;
    for (const m of moves) {
      m.delay ??= 0; m.dur ??= MOVE_MS; m.size ??= MID; m.arrived = false;
    }
    const total = Math.max(...moves.map((m) => m.delay + m.dur));
    this.flight = { moves, start: performance.now(), total, token: this.token, onDone };
    this.requestRender();
  }

  shuffle(onDone) {
    if (!this.animations) { onDone(); return; }
    this.animating = this.shuffling = true;
    this.sfx('shuffle');
    this.shuffleAnim = { start: performance.now(), token: this.token, onDone };
    this.requestRender();
  }

  deal(onDone) {
    const game = this.game, n = game.numPlayers, moves = [];
    const rounds = game.hands[game.players[0]].length;
    for (let r = 0; r < rounds; r++) {
      game.players.forEach((name, s) => {
        const hand = game.hands[name], card = hand[r];
        moves.push({
          card: null, from: this.deckPos(), to: this.cardPos(name, r, hand.length),
          delay: (r * n + s) * DEAL_GAP_MS, dur: DEAL_MS, size: name === HUMAN ? BIG : SMALL,
          onArrive: () => { this.hidden.delete(card); if (s === 0) this.sfx('deal'); },
        });
      });
    }
    this.animate(moves, onDone);
  }

  /** Advance animations; called every frame before drawing. */
  tick(now) {
    const f = this.flight;
    if (f && f.token === this.token) {
      const t = now - f.start;
      for (const m of f.moves) {
        if (!m.arrived && t >= m.delay + m.dur) { m.arrived = true; m.onArrive?.(); }
      }
      if (t >= f.total) { this.flight = null; this.animating = false; f.onDone(); }
    } else if (f) this.flight = null;
    const s = this.shuffleAnim;
    if (s && s.token === this.token && now - s.start >= SHUFFLE_MS) {
      this.shuffleAnim = null;
      this.animating = this.shuffling = false;
      s.onDone();
    } else if (s && s.token !== this.token) this.shuffleAnim = null;
  }

  // ---------- messages ----------
  toast(message) {
    this.toastMsg = message;
    this.toastAt = performance.now();
    this.requestRender();
  }
  toastAlpha(now) {
    if (!this.toastMsg) return 0;
    const age = now - this.toastAt;
    if (age < TOAST_MS) return 1;
    return Math.max(0, 1 - (age - TOAST_MS) / TOAST_FADE_MS);
  }

  // ---------- turn flow ----------
  myTurn(phase = null) {
    const g = this.game;
    return !!g && !g.over && !this.animating && g.currentPlayer === HUMAN && (phase === null || g.phase === phase);
  }

  jokerClick(card) {
    if (!this.myTurn(THROW) || !this.game.hands[HUMAN].includes(card)) return;
    const joker = this.game.hands[HUMAN].find((c) => isJoker(c) && c !== card) ?? null;
    if (!joker) {
      this.toast('Shift-click plays a card with your joker, but you have no joker for it');
      this.sfx('nope');
      return;
    }
    this.throwCard(card, { joker });
  }

  throwCard(card, { alone = false, joker = null } = {}) {
    if (!this.myTurn(THROW) || !this.game.hands[HUMAN].includes(card)) return;
    if (alone) joker = null;
    const hand = this.game.hands[HUMAN];
    const before = Object.fromEntries(hand.map((c, k) => [c, this.handPos(k, hand.length)]));
    const thrown = this.game.throw(HUMAN, card, { alone, joker });
    this.flyThrow(HUMAN, thrown, before, () => this.requestRender());
  }

  flyThrow(name, thrown, origins, onDone) {
    const index = this.seatOf(name);
    thrown.forEach((c) => this.hidden.add(c));
    const moves = thrown.map((card, j) => ({
      card, from: origins[card], to: this.discardPos(index, j, thrown.length),
      delay: j * MOVE_GAP_MS, onArrive: () => this.sfx('throw'),
    }));
    this.animate(moves, () => { thrown.forEach((c) => this.hidden.delete(c)); this.requestRender(); onDone(); });
  }

  flyPick(name, result, origin, faceUp, onDone) {
    const hand = this.game.hands[name];
    this.hidden.add(result.card);
    const fly = () => {
      this.sfx('pick');
      const to = this.cardPos(name, hand.length - 1, hand.length);
      const card = faceUp || name === HUMAN ? result.card : null;
      this.animate([{ card, from: origin, to, size: name === HUMAN ? BIG : MID }], () => {
        this.hidden.delete(result.card);
        this.requestRender();
        onDone();
      });
    };
    if (result.deckRecreated) {
      this.toast('Deck ran out: shuffling the floor into a new deck…');
      this.shuffle(fly);
    } else fly();
  }

  onPick(fromFloor, card = null) {
    const game = this.game;
    if (!this.myTurn(PICK) || (fromFloor && !game.pickables.length)) return;
    card = card ?? (fromFloor ? game.pickable : null);
    if (fromFloor && !game.pickables.includes(card)) return;
    let origin = this.deckPos();
    if (fromFloor) {
      const prev = game.previousPlayer(HUMAN), shown = this.shownThrow(prev);
      origin = this.discardPos(this.seatOf(prev), shown.indexOf(card), shown.length);
    }
    const result = game.pick(HUMAN, fromFloor, card);
    const after = result.roundOver ? () => this.endRound() : () => this.scheduleBots();
    if (result.card === null) after();
    else this.flyPick(HUMAN, result, origin, true, after);
  }

  onCall() {
    if (this.game && !this.animating && this.game.canCall(HUMAN)) {
      this.game.call(HUMAN);
      this.endRound();
    }
  }

  onPlayOn() {
    if (this.myTurn(OPENING)) {
      this.game.passOpening(HUMAN);
      this.scheduleBots();
    }
  }

  scheduleBots() {
    const g = this.game;
    this.requestRender();
    if (g && !g.over && g.currentPlayer !== HUMAN) {
      this.pendingBot = this.later(this.botDelayMs, () => this.botStep());
    } else if (g && !g.over) {
      this.sfx('turn');
    }
  }

  botStep() {
    this.pendingBot = null;
    const game = this.game, name = game.currentPlayer, index = this.seatOf(name);
    const hand = game.hands[name];
    const before = Object.fromEntries(hand.map((c, k) => [c, this.botCardPos(index, k, hand.length)]));
    const prev = game.previousPlayer(name), prevShown = this.shownThrow(prev);

    const turn = game.botTurn();
    if (turn.passed) { this.scheduleBots(); return; }
    if (turn.showdown && !turn.thrown) { this.endRound(); return; }
    const pick = turn.pick;
    if (pick.card === null) { this.flyThrow(name, turn.thrown, before, () => this.endRound()); return; }
    const origin = pick.fromFloor
      ? this.discardPos(this.seatOf(prev), prevShown.indexOf(pick.card), prevShown.length)
      : this.deckPos();
    const took = pick.fromFloor ? `took ${cardText(pick.card)} from the floor` : 'drew from the deck';
    const message = `${name} threw ${describe(turn.thrown)} and ${took}`;
    this.hidden.add(pick.card);
    this.flyThrow(name, turn.thrown, before, () => this.flyPick(name, pick, origin, pick.fromFloor, () => {
      this.toast(message);
      if (pick.roundOver) this.endRound(); else this.scheduleBots();
    }));
  }

  // ---------- rendering loop ----------
  requestRender() {
    if (this.frameQueued) return;
    this.frameQueued = true;
    requestAnimationFrame((now) => {
      this.frameQueued = false;
      this.tick(now);
      this.render(now);
      const fading = this.toastMsg && now - this.toastAt < TOAST_MS + TOAST_FADE_MS;
      if (this.flight || this.shuffleAnim || fading) this.requestRender();
    });
  }

  paintBackground() {
    // the static background and table, painted once
    const off = document.createElement('canvas');
    off.width = W * 2; off.height = H * 2;
    const c = off.getContext('2d');
    c.scale(2, 2);
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, BG_TOP); bg.addColorStop(1, BG_BOTTOM);
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    const oval = (x1, y1, x2, y2) => { c.beginPath(); c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, 0, 0, Math.PI * 2); };
    oval(CX - RX - 40, CY - RY - 28, CX + RX + 46, CY + RY + 52); c.fillStyle = '#030a06'; c.fill();
    oval(CX - RX - 38, CY - RY - 38, CX + RX + 38, CY + RY + 38); c.fillStyle = RIM_DARK; c.fill();
    oval(CX - RX - 34, CY - RY - 34, CX + RX + 34, CY + RY + 34); c.fillStyle = RIM; c.fill();
    c.strokeStyle = RIM_LIGHT; c.lineWidth = 2; c.stroke();
    oval(CX - RX - 20, CY - RY - 20, CX + RX + 20, CY + RY + 20); c.strokeStyle = INLAY; c.lineWidth = 1; c.stroke();
    oval(CX - RX - 8, CY - RY - 8, CX + RX + 8, CY + RY + 8); c.fillStyle = RIM_DARK; c.fill();
    // felt: shaded from the edge to the centre
    c.save();
    c.translate(CX, CY); c.scale(1, (RY + 2) / (RX + 2));
    const felt = c.createRadialGradient(0, 0, 0, 0, 0, RX + 2);
    felt.addColorStop(0, FELT_CENTER); felt.addColorStop(0.38, FELT_CENTER); felt.addColorStop(1, FELT_EDGE);
    c.beginPath(); c.arc(0, 0, RX + 2, 0, Math.PI * 2); c.fillStyle = felt; c.fill();
    c.restore();
    c.setLineDash([6, 6]);
    oval(CX - RX * 0.74, CY - RY * 0.74, CX + RX * 0.74, CY + RY * 0.74); c.strokeStyle = FELT_LINE; c.lineWidth = 1; c.stroke();
    c.setLineDash([]);
    c.font = font(15, true); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = mix(FELT_CENTER, '#ffffff', 0.12);
    c.fillText('D U M B A L', CX, CY - 56);
    return off;
  }

  // ---------- drawing helpers ----------
  rrect(x1, y1, x2, y2, r) { const c = this.ctx; c.beginPath(); c.roundRect(x1, y1, x2 - x1, y2 - y1, r); }
  text(s, x, y, { size = 12, bold = false, color = TEXT, align = 'center', baseline = 'middle', family = FONT } = {}) {
    const c = this.ctx;
    c.font = font(size, bold, family); c.fillStyle = color; c.textAlign = align; c.textBaseline = baseline;
    c.fillText(s, x, y);
  }
  wrap(s, maxWidth, f) {
    const c = this.ctx;
    c.font = f;
    const words = s.split(' '), lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (c.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  drawCard(x, y, card, size, { fill = CARD_BG, outline = CARD_EDGE, width = 1 } = {}) {
    const c = this.ctx;
    const [w, h] = size;
    const x1 = x - w / 2, y1 = y - h / 2, x2 = x + w / 2, y2 = y + h / 2;
    const r = w > 40 ? 7 : 5;
    this.rrect(x1 + 2, y1 + 4, x2 + 3, y2 + 4, r); c.fillStyle = '#06110a'; c.fill();
    if (card === null) {
      this.rrect(x1, y1, x2, y2, r); c.fillStyle = BACK; c.fill(); c.strokeStyle = BACK_DARK; c.lineWidth = 1; c.stroke();
      const inset = w < 40 ? 3 : 5;
      this.rrect(x1 + inset, y1 + inset, x2 - inset, y2 - inset, Math.max(r - 2, 3));
      c.fillStyle = BACK_DARK; c.fill(); c.strokeStyle = INLAY; c.stroke();
      if (w >= 40) {
        const dw = w * 0.26, dh = h * 0.22;
        const diamond = (sx, sy) => { c.beginPath(); c.moveTo(x, y - sy); c.lineTo(x + sx, y); c.lineTo(x, y + sy); c.lineTo(x - sx, y); c.closePath(); };
        diamond(dw, dh); c.fillStyle = BACK; c.fill(); c.strokeStyle = INLAY; c.stroke();
        diamond(dw / 2.4, dh / 2.4); c.fillStyle = INLAY; c.fill();
      }
      return;
    }
    this.rrect(x1, y1, x2, y2, r); c.fillStyle = fill; c.fill(); c.strokeStyle = outline; c.lineWidth = width; c.stroke();
    if (isJoker(card)) {
      this.text('★', x, y - h * 0.08, { size: Math.round(h * 0.36), bold: true, color: JOKER, family: CARD_FONT });
      this.text('JOKER', x, y + h * 0.3, { size: Math.max(Math.round(h * 0.12), 7), bold: true, color: JOKER, family: CARD_FONT });
      return;
    }
    const color = isRed(card) ? RED : BLACK, cx = x1 + Math.max(w * 0.22, 9);
    this.text(card.slice(0, -1), cx, y1 + h * 0.17, { size: Math.round(h * 0.2), bold: true, color, family: CARD_FONT });
    this.text(card.slice(-1), cx, y1 + h * 0.37, { size: Math.round(h * 0.17), color, family: CARD_FONT });
    this.text(card.slice(-1), x + w * 0.1, y + h * 0.2, { size: Math.round(h * 0.4), color, family: CARD_FONT });
  }

  drawAvatar(x, y, initials, color, active, winner, r = 20) {
    const c = this.ctx;
    if (active || winner) {
      const glow = winner ? WINNER : GOLD;
      for (const [k, t] of [[10, 0.8], [6, 0.6], [3, 0.3]]) {
        c.beginPath(); c.arc(x, y, r + k, 0, Math.PI * 2); c.strokeStyle = mix(glow, BG_BOTTOM, t); c.lineWidth = 3; c.stroke();
      }
    }
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    c.strokeStyle = active || winner ? GOLD : '#0b1a10'; c.lineWidth = active || winner ? 3 : 2; c.stroke();
    this.text(initials, x, y, { size: 12, bold: true, color: '#10261a' });
  }

  /** A pill button; returns its width. anchor: 'left' | 'right' | 'center'. */
  drawButton(label, x, y, { primary = false, enabled = true, anchor = 'left', onClick }) {
    const c = this.ctx;
    c.font = font(13, true);
    const w = c.measureText(label).width + 32, h = 34;
    const x1 = anchor === 'left' ? x : anchor === 'right' ? x - w : x - w / 2;
    const hover = enabled && this.mouse.x >= x1 && this.mouse.x <= x1 + w && Math.abs(this.mouse.y - y) <= h / 2;
    let bg = primary ? GOLD : '#1d3a29';
    if (!enabled) bg = '#14281c'; else if (hover) bg = mix(bg, '#ffffff', 0.18);
    this.rrect(x1, y - h / 2, x1 + w, y + h / 2, 17); c.fillStyle = bg; c.fill();
    this.text(label, x1 + w / 2, y + 1, { size: 13, bold: true, color: !enabled ? '#6d8a77' : primary ? BLACK : TEXT });
    if (enabled) this.region(x1, y - h / 2, x1 + w, y + h / 2, { click: onClick, cursor: 'pointer' });
    return w;
  }

  // ---------- drawing ----------
  render(now = performance.now()) {
    const c = this.ctx;
    this.regions = [];
    c.drawImage(this.background, 0, 0, W, H);
    const game = this.game;
    this.hint = '';
    if (game) this.drawGame(now);
    this.drawToast(now);
    this.drawBar();
    const r = this.regionAt(this.mouse);
    this.canvas.style.cursor = r?.cursor ?? 'default';
  }

  drawGame(now) {
    const c = this.ctx, game = this.game, result = game.result;
    const canPick = this.myTurn(PICK);
    const offers = canPick ? game.pickables : this.myTurn(THROW) ? game.availablePicks() : [];

    const mode = this.match.mode === QUICK ? 'Quick game' : `Race to ${RACE_LIMIT}`;
    this.text(`${mode}  ·  ${this.match.seats.length} players  ·  ${game.jokers} joker${game.jokers > 1 ? 's' : ''} (0 pts)  ·  call at ${game.callLimit} or less (opening call ${OPENING_CALL_LIMIT})`,
      22, 22, { size: 12, color: MUTED, align: 'left' });

    // centre: deck and floor
    const [dx, dy] = this.deckPos(), fx = CX + 50;
    if (!this.shuffling && game.deck.length) {
      for (let k = Math.min(4, Math.max(Math.floor(game.deck.length / 10), 1)); k > 0; k--) this.drawCard(dx + k * 1.2, dy - k * 1.6, null, MID);
      this.drawCard(dx, dy, null, MID);
    }
    if (canPick) {
      this.rrect(dx - 31, dy - 43, dx + 31, dy + 43, 9); c.strokeStyle = GOLD; c.lineWidth = 3; c.stroke();
      this.region(dx - 31, dy - 43, dx + 31, dy + 43, { click: () => this.onPick(false), cursor: 'pointer' });
    }
    this.text(`Deck ${game.deck.length}`, dx, dy + 54, { size: 11, color: MUTED });
    const visibleFloor = game.floor.filter((card) => !this.hidden.has(card));
    if (visibleFloor.length) this.drawCard(fx, CY, visibleFloor[visibleFloor.length - 1], MID);
    else { this.rrect(fx - 26, CY - 38, fx + 26, CY + 38, 7); c.strokeStyle = FELT_LINE; c.lineWidth = 2; c.stroke(); }
    this.text(`Floor ${game.floor.length}`, fx, CY + 54, { size: 11, color: MUTED });

    // each player's last throw, between their seat and the centre
    for (const name of result ? [] : game.players) {
      const i = this.seatOf(name), thrown = this.shownThrow(name), stands = jokerStandsFor(game.lastThrow[name]);
      thrown.forEach((card, k) => {
        if (this.hidden.has(card)) return;
        const [x, y] = this.discardPos(i, k, thrown.length);
        if (stands[card]) this.text(`as ${stands[card]}`, x, y + 48, { size: 10, bold: true, color: GOLD });
        const isOffer = offers.includes(card);
        this.drawCard(x, y, card, MID, {
          fill: isOffer && canPick ? GOLD : CARD_BG, outline: isOffer ? GOLD : CARD_EDGE, width: isOffer ? 3 : 1,
        });
        if (isOffer && canPick) {
          // later cards are drawn (and hit-tested) on top, so each card gets its whole rectangle
          this.region(x - MID[0] / 2, y - MID[1] / 2, x + MID[0] / 2, y + MID[1] / 2, { click: () => this.onPick(true, card), cursor: 'pointer' });
        }
      });
      if (thrown.some((card) => offers.includes(card))) {
        const [tx, ty] = this.discardSpot(i);
        const label = canPick ? (offers.length > 1 ? 'pick any one of these' : 'you can pick this')
          : game.floorUnlocked.has(HUMAN) ? 'available to pick' : 'pickable once you throw|a double or sequence';
        label.split('|').forEach((ln, j, all) => this.text(ln, tx, ty - 52 - (all.length - 1 - j) * 14, { size: 11, bold: true, color: GOLD }));
      }
    }

    for (const name of this.match.seats) {
      if (name === HUMAN) continue;
      if (game.players.includes(name)) this.drawBot(this.seatOf(name), name);
      else this.drawOutSeat(this.seatOf(name), name);
    }
    this.drawHuman();
    this.drawFlights(now);
    if (result) this.drawResult();
  }

  drawFlights(now) {
    const f = this.flight;
    if (f) {
      const t = now - f.start;
      for (const m of f.moves) {
        const p = (t - m.delay) / m.dur;
        if (p > 0 && p < 1) {
          const e = ease(p), [x0, y0] = m.from, [x1, y1] = m.to;
          this.drawCard(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e - Math.sin(Math.PI * p) * 26, m.card, m.size);
        }
      }
    }
    const s = this.shuffleAnim;
    if (s) {
      const [dx, dy] = this.deckPos();
      const t = Math.min((now - s.start) / SHUFFLE_MS, 0.999), riffle = t * 3;
      const phase = riffle % 1, k = Math.floor(riffle), spread = Math.sin(Math.PI * phase);
      for (let i = 0; i < 14; i++) {
        const side = (i + k) % 2 ? 1 : -1;
        this.drawCard(dx + side * spread * 52, dy - i * 1.3 - spread * 10 * (1 - Math.abs(i - 7) / 7), null, MID);
      }
    }
  }

  drawBot(index, name) {
    const game = this.game, result = game.result;
    const [x, y] = this.botSeat(index);
    const hand = game.hands[name];
    const isTurn = !result && !this.dealing && game.currentPlayer === name;
    const isWinner = !!(result && result.winners.includes(name));
    const size = result ? MID : SMALL;
    hand.forEach((card, k) => {
      if (this.hidden.has(card)) return;
      const [px, py] = this.botCardPos(index, k, hand.length, !!result);
      this.drawCard(px, py, result ? card : null, size);
    });
    const color = AVATAR_COLORS[(index - 1) % AVATAR_COLORS.length];
    if (y < 140) {
      const half = ((result ? 26 : 16) * (hand.length - 1)) / 2 + size[0] / 2;
      this.drawAvatar(x - half - 30, y, 'B' + name.slice(-1), color, isTurn, isWinner);
    } else {
      this.drawAvatar(x, y - (result ? 62 : 46), 'B' + name.slice(-1), color, isTurn, isWinner);
    }
    const below = y + (result ? 46 : 32);
    this.text(name + (result && result.caller === name ? '  · called' : ''), x, below, { size: 13, bold: true, color: isTurn || isWinner ? GOLD : TEXT });
    if (result) this.text(this.resultNote(name), x, below + 18, { size: 12 });
    else if (isTurn) this.text('thinking…', x, below + 17, { size: 11, color: MUTED });
  }

  resultNote(name) {
    const result = this.game.result, total = result.totals[name];
    let note = name === result.caller && result.caught ? `total ${total} + ${CAUGHT_PENALTY}` : `total ${total}`;
    if (this.match.mode === RACE) {
      const points = result.points[name];
      note += points === 0 ? '  ·  scores 0' : `  ·  +${points}`;
    }
    return note;
  }

  drawOutSeat(index, name) {
    const [x, y] = this.botSeat(index);
    this.drawAvatar(x, y - 46, 'B' + name.slice(-1), '#4a5a50', false, false);
    this.text('OUT', x, y - 6, { size: 14, bold: true, color: OUT_RED });
    this.text(`${name}  ·  ${this.match.scores[name]}`, x, y + 32, { size: 12, bold: true, color: MUTED });
  }

  drawHuman() {
    const game = this.game, result = game.result;
    if (!game.players.includes(HUMAN)) {
      const lx = CX - 290;
      this.drawAvatar(lx, HAND_Y - 26, 'You', '#4a5a50', false, false, 24);
      this.text(`OUT  ·  ${this.match.scores[HUMAN]}`, lx, HAND_Y + 14, { size: 13, bold: true, color: OUT_RED });
      this.text(this.match.over ? 'You were knocked out of the race.' : "You're out of the race. Watching the bots…",
        CX + 40, HAND_Y, { size: 15, bold: true, color: MUTED });
      return;
    }
    const hand = game.hands[HUMAN], selectable = this.myTurn(THROW);
    // which card is the mouse over? (cards don't overlap, so this is exact)
    let hovered = null;
    if (selectable) {
      hand.forEach((card, k) => {
        const [x, y] = this.handPos(k, hand.length);
        if (Math.abs(this.mouse.x - x) <= BIG[0] / 2 && Math.abs(this.mouse.y - y) <= BIG[1] / 2) hovered = card;
      });
    }
    const group = hovered ? autoGroup(hand, hovered) : [];
    hand.forEach((card, k) => {
      if (this.hidden.has(card)) return;
      const [x, y] = this.handPos(k, hand.length);
      const lit = group.includes(card);
      this.drawCard(x, y, card, BIG, { outline: lit ? GOLD : CARD_EDGE, width: lit ? 3 : 1 });
      if (selectable) {
        this.region(x - BIG[0] / 2, y - BIG[1] / 2, x + BIG[0] / 2, y + BIG[1] / 2, {
          click: () => this.throwCard(card),
          shift: () => this.jokerClick(card),
          alt: () => this.throwCard(card, { alone: true }),
          cursor: 'pointer',
        });
      }
    });
    if (hovered) {
      const joker = hand.find((c2) => isJoker(c2) && c2 !== hovered) ?? null;
      const parts = [];
      if (group.length > 1) parts.push(`click: ${describe(group)}`);
      if (joker && !isJoker(hovered)) parts.push(`shift-click: ${describe(orderThrow(jokerGroup(hand, hovered, joker)))}`);
      if (group.length > 1) parts.push(`right-click: ${cardText(hovered)} alone`);
      else if (parts.length) parts.unshift(`click: ${cardText(hovered)}`);
      if (parts.length) this.text(parts.join('   ·   '), CX, HAND_Y - BIG[1] / 2 - 36, { size: 12, bold: true, color: GOLD });
    }

    const isTurn = !result && !this.dealing && game.currentPlayer === HUMAN;
    const isWinner = !!(result && result.winners.includes(HUMAN));
    const [firstX] = this.handPos(0, Math.max(hand.length, 1));
    const lx = Math.min(firstX - BIG[0] / 2 - 80, CX - 290);
    this.drawAvatar(lx, HAND_Y - 38, 'You', isTurn ? GOLD : '#d9cfa8', isTurn, isWinner, 24);
    const total = hand.filter((card) => !this.hidden.has(card)).reduce((s, card) => s + cardValue(card), 0);
    this.text(result ? this.resultNote(HUMAN) : `total ${total}`, lx, HAND_Y + 2,
      { size: 13, bold: true, color: total <= game.limitNow() ? GOLD : TEXT });
    const lines = [];
    if (this.match.mode === RACE) lines.push([`score ${this.match.scores[HUMAN]} / ${RACE_LIMIT}`, MUTED]);
    if (!result) {
      const unlocked = game.floorUnlocked.has(HUMAN);
      lines.push([unlocked ? 'floor pick unlocked' : 'floor pick locked', unlocked ? GOLD : MUTED]);
    }
    lines.forEach(([s, color], k) => this.text(s, lx, HAND_Y + 20 + 17 * k, { size: 11, color }));
  }

  drawResult() {
    const c = this.ctx, match = this.match, result = this.game.result;
    const summary = match.rounds[match.rounds.length - 1], caller = result.caller;
    let called, detail;
    if (result.deckOut) {
      called = 'The deck ran out a second time: everyone shows their hand';
      detail = 'Nobody wins this round; everyone scores their hand';
    } else {
      const ct = result.totals[caller];
      if (result.caught) {
        called = `${who([caller])} called with ${ct} and got caught: ${ct} + ${CAUGHT_PENALTY} = ${ct + CAUGHT_PENALTY}`;
        detail = `${who(result.winners)} had the lowest hand (${result.totals[result.winners[0]]})`;
        if (result.tiebreak) detail += `, winning the tie on ${result.tiebreak}`;
      } else {
        called = `${who([caller])} called with ${ct}`;
        detail = 'Nobody had an equal or lower hand';
      }
    }
    if (this.autoFinished && match.over) {
      const [wentOut, extra] = this.autoFinished;
      called = `You were knocked out in round ${wentOut}. The bots played ${extra} more round${extra !== 1 ? 's' : ''} to finish the race`;
      detail = 'Final scores below';
    }
    const knocked = this.autoFinished && match.over ? [] : summary.knockedOut;
    if (knocked.length) {
      detail += `. ${who(knocked)} reached ${RACE_LIMIT} and ${knocked.length > 1 || knocked[0] === HUMAN ? 'are' : 'is'} out`;
    }
    let headline;
    if (match.mode === QUICK) headline = result.winners.length ? `${wins(result.winners)}!` : 'No winner';
    else if (match.over) headline = `${wins(match.winners)} the race!`;
    else if (result.deckOut) headline = `Round ${summary.number}: no winner`;
    else headline = `Round ${summary.number}: ${wins(result.winners)}`;

    // lay the panel out first (relative y), then draw it centred
    const x1 = CX - 215, x2 = CX + 215, inner = x2 - x1 - 48, ops = [];
    let y = 0;
    const line = (s, size, bold, color, gap) => {
      const f = font(size, bold), lh = Math.round(size * 1.35);
      for (const ln of this.wrap(s, inner, f)) { ops.push(['text', ln, CX, y, { size, bold, color, baseline: 'top' }]); y += lh; }
      y += gap;
    };
    if (match.mode === QUICK || match.over) line('♛', 18, false, WINNER, 0);
    line(headline, 20, true, WINNER, 6);
    line(called, 13, false, TEXT, 3);
    line(detail, 12, false, knocked.length ? '#e69a9a' : MUTED, 12);
    if (match.mode === RACE) {
      const cols = { name: x1 + 28, hand: x1 + 196, round: x1 + 286, score: x1 + 352, note: x1 + 366 };
      const cell = (key, s, color, size = 12) => ops.push(['text', s, cols[key], y,
        { size, bold: true, color, baseline: 'top', align: key === 'name' || key === 'note' ? 'left' : 'right' }]);
      for (const [key, s] of [['name', 'Player'], ['hand', 'Hand'], ['round', 'This round'], ['score', 'Score']]) cell(key, s, MUTED, 11);
      y += 22;
      ops.push(['line', x1 + 24, y, x2 - 24]);
      y += 6;
      for (const name of match.seats) {
        const played = name in result.totals, outNow = knocked.includes(name);
        const outBefore = match.out.includes(name) && !outNow;
        const color = outNow || outBefore ? OUT_RED : result.winners.includes(name) ? WINNER : TEXT;
        cell('name', who([name]), color);
        if (played) {
          cell('hand', String(result.totals[name]) + (name === caller && result.caught ? `+${CAUGHT_PENALTY}` : ''), color);
          const pts = summary.added[name];
          cell('round', pts === 0 ? '0' : `+${pts}`, color);
        }
        cell('score', String(match.scores[name]), color);
        const note = outNow || outBefore ? 'out' : match.winners.includes(name) || result.winners.includes(name) ? '★' : '';
        cell('note', note, color, 11);
        y += 24;
      }
      y += 4;
    }
    if (match.mode === RACE && !match.over) { ops.push(['next', y + 2]); y += 44; }
    else line('Press New game to play again', 11, false, MUTED, 4);

    const height = y + 28;
    const top = Math.min(Math.max(CY + 24 - height / 2, 96), H - 210 - height);
    const oy = top + 18;
    this.rrect(x1 + 3, top + 5, x2 + 3, top + height + 5, 18); c.fillStyle = '#030a06'; c.fill();
    this.rrect(x1, top, x2, top + height, 18); c.fillStyle = PANEL; c.fill(); c.strokeStyle = WINNER; c.lineWidth = 2; c.stroke();
    for (const op of ops) {
      if (op[0] === 'text') this.text(op[1], op[2], op[3] + oy, op[4]);
      else if (op[0] === 'line') { c.beginPath(); c.moveTo(op[1], op[2] + oy); c.lineTo(op[3], op[2] + oy); c.strokeStyle = '#2d5a3d'; c.lineWidth = 1; c.stroke(); }
      else if (op[0] === 'next') this.drawButton('Continue to next round', CX, op[1] + oy + 17, { primary: true, anchor: 'center', onClick: () => { this.sfx('click'); this.startRound(); } });
    }
  }

  drawToast(now) {
    const alpha = this.toastAlpha(now);
    if (!alpha) return;
    const c = this.ctx, fade = 1 - alpha, under = FELT_CENTER, f = font(13, true);
    const lines = this.wrap(this.toastMsg, 560, f), lh = 18;
    c.font = f;
    const width = Math.max(...lines.map((l) => c.measureText(l).width));
    const bottom = TOAST_Y - 6, topY = bottom - lines.length * lh;
    this.rrect(CX - width / 2 - 18, topY - 5, CX + width / 2 + 18, bottom + 5, 14);
    c.fillStyle = mix('#0c2a19', under, fade); c.fill();
    c.strokeStyle = mix(GOLD, under, fade); c.lineWidth = 1; c.stroke();
    lines.forEach((ln, i) => this.text(ln, CX, topY + i * lh + lh / 2, { size: 13, bold: true, color: mix(TEXT, under, fade) }));
  }

  drawBar() {
    const game = this.game;
    let left = 20;
    left += this.drawButton('New game', left, BAR_Y, { onClick: () => { this.sfx('click'); this.setup.open(); } }) + 8;
    const soundLabel = !this.sounds.available ? '♪ No sound' : this.sounds.enabled ? '♪ Sound on' : '♪ Sound off';
    left += this.drawButton(soundLabel, left, BAR_Y, { enabled: this.sounds.available, onClick: () => this.toggleSound() }) + 14;
    const callLabel = this.match?.mode === RACE ? 'Call showdown · end round' : 'Call showdown · end game';
    const canCall = !!game && game.canCall(HUMAN) && !this.animating;
    let right = W - 20 - this.drawButton(callLabel, W - 20, BAR_Y, { primary: true, enabled: canCall, anchor: 'right', onClick: () => this.onCall() }) - 14;
    if (this.myTurn(OPENING)) {
      right -= this.drawButton('Play on', right + 6, BAR_Y, { anchor: 'right', onClick: () => { this.sfx('click'); this.onPlayOn(); } }) + 8;
    }
    const status = this.statusText();
    if (status) {
      const lines = this.wrap(status, right - left, font(13, true));
      const lh = 17, y0 = BAR_Y - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, i) => this.text(ln, (left + right) / 2, y0 + i * lh, { size: 13, bold: true, color: GOLD }));
    }
  }

  statusText() {
    const game = this.game;
    if (!game) return 'Press New game to start.';
    const match = this.match;
    if (game.over) {
      if (match.over) return match.winners.length ? `Game over: ${wins(match.winners)}! Press New game to play again.` : 'Game over: no winner. Press New game to play again.';
      return "Round over. Press Continue to next round when you're ready.";
    }
    if (this.shuffling) return 'Shuffling…';
    if (this.dealing) return 'Dealing…';
    if (!game.players.includes(HUMAN)) return `You're out. ${game.currentPlayer} is playing…`;
    if (game.currentPlayer !== HUMAN) return `${game.currentPlayer} is playing…`;
    if (this.animating) return '';
    if (game.phase === OPENING) return `Opening call: your hand is ${game.total(HUMAN)} (${OPENING_CALL_LIMIT} or less). Call showdown now, or Play on.`;
    if (game.phase === PICK) {
      if (game.pickables.length > 1) return 'Pick up: click the deck, or any one of the gold cards.';
      if (game.pickable) return `Pick up: click the deck, or the gold ${cardText(game.pickable)}.`;
      if (game.availablePick()) return "You haven't thrown a double or sequence yet, so you can't take from the floor. Click the deck.";
      return 'Pick up: click the deck.';
    }
    if (game.canCall(HUMAN)) {
      return `Your total is ${game.total(HUMAN)}: press Call showdown to end ${match.mode === QUICK ? 'the game' : 'the round'}, or keep playing by throwing a card.`;
    }
    let s = 'Your turn: click a card to throw it (its pair or sequence goes too). Right-click throws it alone.';
    if (game.hands[HUMAN].some(isJoker)) s += ' Shift-click a card to play it with your joker.';
    return s;
  }
}

// ---------- the New game dialog (HTML) ----------
const MODE_INFO = {
  [QUICK]: 'One round. The round winner wins.',
  [RACE]: `Rounds until one player is left. The round winner scores 0, everyone else adds their hand total. Reach ${RACE_LIMIT} and you're out; the last one standing wins.`,
};

class SetupDialog {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('setup');
    this.values = {};
    const rows = [
      ['mode', [[QUICK, 'Quick game'], [RACE, `Race to ${RACE_LIMIT}`]]],
      ['players', Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => [MIN_PLAYERS + i, String(MIN_PLAYERS + i)])],
      ['jokers', [[1, '1'], [2, '2']]],
      ['callLimit', CALL_LIMITS.map((v) => [v, `${v} or less`])],
    ];
    for (const [key, options] of rows) {
      const box = this.el.querySelector(`[data-choice="${key}"]`);
      for (const [value, label] of options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => { this.values[key] = value; this.paint(); });
        b.dataset.value = String(value);
        box.appendChild(b);
      }
    }
    this.el.querySelector('#opening-note').textContent = `Before the first throw of a round, anyone with ${OPENING_CALL_LIMIT} or less may call.`;
    this.el.querySelector('#deal').addEventListener('click', () => this.start());
    this.el.querySelector('#cancel').addEventListener('click', () => this.close());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.start(); }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
  }

  paint() {
    for (const box of this.el.querySelectorAll('[data-choice]')) {
      const key = box.dataset.choice;
      for (const b of box.children) b.classList.toggle('on', b.dataset.value === String(this.values[key]));
    }
    this.el.querySelector('#mode-info').textContent = MODE_INFO[this.values.mode];
  }

  open() {
    const s = this.app.settings;
    this.values = { mode: s.mode, players: s.players, jokers: s.jokers, callLimit: s.callLimit };
    this.paint();
    this.el.hidden = false;
    this.el.querySelector('#deal').focus();
  }

  close() { this.el.hidden = true; this.app.requestRender(); }

  start() {
    this.app.sounds.unlock();
    this.close();
    this.app.startGame({ ...this.values });
  }
}

window.dumbal = new App(document.getElementById('table'));

// The Dhumbal table in the browser: a port of gui.py onto an HTML canvas.
// Everything (table, cards, buttons, result panel) is drawn on one canvas each frame from the
// game state; clicks are matched against the regions drawn last frame.

import {
  autoGroup, cardText, cardValue, isJoker, isRed, jokerGroup, jokerStandsFor, orderThrow, Rng,
} from './cards.js';
import {
  CALL_LIMITS, CAUGHT_PENALTY, DEFAULT_CALL_LIMIT, HUMAN, MAX_PLAYERS, MIN_PLAYERS, Match, OPENING,
  OPENING_CALL_LIMIT, PICK, QUICK, RACE, RACE_LIMIT, SALAMI_BONUS, THROW, loadMatch, saveMatch,
} from './game.js';
import { OnlineClient } from './online.js';
import { Sounds } from './sound.js';

// ---------- layout (same numbers as the Python window) ----------
// Two layouts: a wide table (tab and toolbar popup) and a tall one for Chrome's narrow side panel.
let W, H, CX, CY, RX, RY, HAND_Y, TOAST_Y, BAR_Y, DECK_Y, PORTRAIT = false;
// how big cards, text and buttons are drawn (1 = the original size); the narrow side-panel
// table has no room to spare, so it stays a little smaller
let U, BIG, MID, SMALL;
function applyLayout(portrait) {
  PORTRAIT = portrait;
  U = portrait ? 1.15 : 1.25;
  BIG = [72 * U, 104 * U]; MID = [52 * U, 76 * U]; SMALL = [30 * U, 44 * U];
  if (portrait) {
    W = 480; H = 970; CX = 240; CY = 380; RX = 196; RY = 290; HAND_Y = 812; BAR_Y = 940;
  } else {
    W = 1040; H = 770; CX = 520; CY = 318; RX = 430; RY = 220; HAND_Y = 634; BAR_Y = 744;
  }
  // the narrow table is crowded in the middle: deck row a little higher, message just above it
  DECK_Y = portrait ? CY - 40 : CY;
  TOAST_Y = portrait ? DECK_Y - 54 : CY - 74;
}
applyLayout(false);
const MODE = new URLSearchParams(location.search).has('panel') ? 'panel'
  : new URLSearchParams(location.search).has('popup') ? 'popup' : 'tab';

// Palette: royal navy felt, burgundy (mahogany) rim and card backs, antique gold, ivory.
// Navy + gold is the classic court-card pairing; burgundy and ivory warm it up.
const BG_TOP = '#0e1a2b', BG_BOTTOM = '#060b14';
const FELT_EDGE = '#0f2a47', FELT_CENTER = '#1f4f7a', FELT_LINE = '#3a6a96';
const RIM_DARK = '#2a0f14', RIM = '#5a1a26', RIM_LIGHT = '#8a3242', INLAY = '#d4af37';
const CARD_BG = '#fffdf6', CARD_EDGE = '#9aa3ad';
const BACK = '#7a1f2e', BACK_DARK = '#4d0f1a';
const GOLD = '#e9c46a', WINNER = '#f4d35e';
const RED = '#c0392b', BLACK = '#1b1b1b', JOKER = '#6a1b9a';
const TEXT = '#f5efe0', MUTED = '#a9b8cc', PANEL = '#0b1626', OUT_RED = '#e07a7a';
const PILL = '#1c3350', AVATAR_INK = '#0e1a2b';
const AVATAR_COLORS = ['#e07a5f', '#81b29a', '#f2cc8f', '#9d8df1'];

const u = (n) => n * U;

const SHUFFLE_MS = 1800, DEAL_MS = 420, DEAL_GAP_MS = 120, MOVE_MS = 560, MOVE_GAP_MS = 110;
const BOT_THINK_MS = 800, TOAST_MS = 2000, TOAST_FADE_MS = 650, FADE_IN_MS = 180;
const STATUS_MS = 4500;          // the instruction line fades away after this long unchanged

const FONT = '"Avenir Next", Avenir, "Helvetica Neue", Helvetica, Arial, sans-serif';
const CARD_FONT = 'Helvetica, Arial, sans-serif';
const font = (size, bold = false, family = FONT) => `${bold ? 'bold ' : ''}${u(size)}px ${family}`;

// ---------- small helpers ----------
function mix(c1, c2, t) {
  const a = [1, 3, 5].map((i) => parseInt(c1.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(c2.slice(i, i + 2), 16));
  return '#' + a.map((x, i) => Math.round(x + (b[i] - x) * t).toString(16).padStart(2, '0')).join('');
}
const ease = (t) => t * t * (3 - 2 * t);
/** Avatar letters: B1 for Bot1, otherwise the first letters of the name. */
function initials(name) {
  if (/^Bot\d$/.test(name)) return 'B' + name.slice(-1);
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}
const who = (names) => names.map((n) => (n === HUMAN ? 'You' : n)).join(' and ');
const wins = (names) => who(names) + (names.length === 1 && names[0] !== HUMAN ? ' wins' : ' win');
function describe(cards) {
  const stands = jokerStandsFor(cards);
  return cards.map((c) => cardText(c) + (stands[c] ? ` (as ${stands[c]})` : '')).join('  ');
}

// card artwork: Byron Knoll's public-domain Vector Playing Cards (see cards/CREDITS.txt)
const SUIT_CODE = { '♦': 'D', '♥': 'H', '♣': 'C', '♠': 'S' };
const cardFile = (card) => (isJoker(card) ? (card === 'JK1' ? 'Joker1' : 'Joker2') : card.slice(0, -1) + SUIT_CODE[card.slice(-1)]);

function loadCardImages(onLoad) {
  const images = {};
  for (const s of Object.keys(SUIT_CODE)) {
    for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']) images[r + s] = null;
  }
  images.JK1 = images.JK2 = null;
  for (const card of Object.keys(images)) {
    const img = new Image();
    img.onload = onLoad;
    img.src = `cards/${cardFile(card)}.png`;
    images[card] = img;
  }
  return images;
}

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`dhumbal.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(`dhumbal.${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
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
    this.background = null;          // painted by fit() for the current layout
    this.cardImages = loadCardImages(() => this.requestRender());
    this.lastStatus = '';
    this.statusAt = 0;
    // playing with friends online (see online.js): the server sends events, we animate them in order
    this.online = null;
    this.room = null;            // the table as the server last described it
    this.netQueue = [];
    this.netBusy = false;        // animating an event from the server
    this.netWaiting = false;     // sent a move, waiting for the server to confirm it

    this.fit();
    window.addEventListener('resize', () => this.fit());
    canvas.addEventListener('mousemove', (e) => { this.mouse = this.point(e); this.requestRender(); });
    canvas.addEventListener('mouseleave', () => { this.mouse = { x: -1, y: -1 }; this.requestRender(); });
    canvas.addEventListener('click', (e) => this.onPointer(e, e.shiftKey ? 'shift' : 'click'));
    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onPointer(e, 'alt'); });
    window.addEventListener('keydown', (e) => {
      if (e.target?.tagName === 'INPUT') return;
      if (e.key.toLowerCase() === 'm' && !document.querySelector('.backdrop:not([hidden])')) this.toggleSound();
    });
    this.setup = new SetupDialog(this);
    this.lobby = new LobbyDialog(this);
    window.addEventListener('pagehide', () => this.save());
    // the popup and the side panel share one saved game: when the other view saves, follow it
    window.addEventListener('storage', (e) => {
      if (e.key === 'dhumbal.game' && e.newValue && !this.online && !this.animating && !this.flight) {
        clearTimeout(this.pendingBot); this.pendingBot = null;
        this.token += 1;
        if (this.resume(true)) this.requestRender();
      }
    });
    this.windowId = null;
    globalThis.chrome?.windows?.getCurrent?.().then((w) => { this.windowId = w.id; }).catch(() => {});
    // Brave doesn't show Chrome's extension side panel, so there we open a slim window instead
    this.isBrave = false;
    globalThis.navigator?.brave?.isBrave?.().then((yes) => { this.isBrave = !!yes; this.requestRender(); }).catch(() => {});
    if (store.get('online', null)?.code) this.resumeOnline();
    else if (!this.resume()) this.setup.open();
    this.requestRender();
  }

  // ---------- save and resume: the toolbar popup is destroyed whenever it closes ----------
  save() {
    if (!this.match || this.online) return;     // an online game lives on the server
    store.set('game', { match: saveMatch(this.match), autoFinished: this.autoFinished });
  }

  resume(quiet = false) {
    const saved = store.get('game', null);
    const match = saved && loadMatch(saved.match);
    if (!match || !match.game) return false;
    // an online game's copy (masked cards like "?p1.0") can't be played against bots: drop it
    const cards = [...match.game.deck, ...match.game.floor, ...Object.values(match.game.hands).flat()];
    if (cards.some((c) => typeof c !== 'string' || c.startsWith('?'))) { store.set('game', null); return false; }
    this.match = match;
    this.game = match.game;
    this.autoFinished = saved.autoFinished ?? null;
    if (this.game.over) {
      if (this.match.scoredGame !== this.game) this.match.finishRound();
    } else {
      if (!quiet) this.toast('Welcome back: your game is where you left it');
      this.scheduleBots();
    }
    return true;
  }

  // ---------- canvas sizing and input ----------
  fit() {
    const dpr = window.devicePixelRatio || 1;
    const portrait = window.innerWidth / window.innerHeight < 0.8;   // a tall, narrow window (side panel)
    if (portrait !== PORTRAIT || !this.background) {
      applyLayout(portrait);
      this.background = this.paintBackground();
    }
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

  /** From the popup: move the game into Chrome's side panel, which stays open while you browse. */
  /** From the popup: keep the game open while you browse. Chrome: its side panel.
   *  Brave (no extension side panel) or anywhere the side panel fails: a slim Dhumbal window. */
  openSidePanel() {
    const sidePanel = globalThis.chrome?.sidePanel;
    this.save();
    if (this.isBrave || !sidePanel?.open || this.windowId === null) {
      this.openGameWindow();
      return;
    }
    sidePanel.open({ windowId: this.windowId })      // must run inside the click
      .then(() => window.close())
      .catch(() => this.openGameWindow());
  }

  /** A separate, narrow window with the tall table; reuses the one already open. */
  async openGameWindow() {
    const windows = globalThis.chrome?.windows;
    if (!windows?.create) {
      this.toast("This browser can't open the game in its own window");
      this.sfx('nope');
      return;
    }
    const known = store.get('windowId', null);
    if (known !== null) {
      try {
        await windows.update(known, { focused: true });   // already open: bring it to the front
        window.close();
        return;
      } catch { /* it was closed */ }
    }
    const height = Math.min(960, (screen.availHeight || 900) - 40);
    const width = Math.round(height * 0.5);
    try {
      const w = await windows.create({
        url: globalThis.chrome.runtime.getURL('game.html?panel'), type: 'popup', width, height,
        left: Math.max(0, (screen.availWidth || 1440) - width - 16), top: 24, focused: true,
      });
      store.set('windowId', w.id);
      window.close();
    } catch {
      this.toast("Couldn't open the game window");
    }
  }

  // ---------- playing with friends online ----------
  /** Set up the connection; the server's messages go to onNet. */
  connectOnline() {
    this.leaveLocal();
    this.online = new OnlineClient(store, {
      onMessage: (msg) => this.onNet(msg),
      onFatal: (message) => this.onlineEnded(message),
      onStatus: (status) => {
        if (status === 'reconnecting') this.toast('Connection lost: reconnecting… (a bot plays for you meanwhile)');
        this.requestRender();
      },
    });
    return this.online;
  }

  /** Stop showing the game against bots (it stays saved for later). */
  leaveLocal() {
    this.save();
    clearTimeout(this.pendingBot);
    this.pendingBot = null;
    this.token += 1;
    this.animating = this.shuffling = this.dealing = false;
    this.flight = this.shuffleAnim = null;
    this.match = this.game = null;
    this.hidden = new Set();
    this.netQueue = [];
    this.netBusy = this.netWaiting = false;
  }

  resumeOnline() {
    this.connectOnline().resume();
    this.toast('Reconnecting to your table…');
  }

  async createTable(settings, name) {
    const online = this.connectOnline();
    try {
      await online.create(settings, name);
    } catch (e) {
      online.forget();
      this.online = null;
      throw e;
    }
  }

  joinTable(code, name) { this.connectOnline().join(code, name); }

  /** Leave the table you're at (a bot finishes the game for you) and go back to the start. */
  leaveTable() {
    this.online?.leave();
    this.onlineEnded(null);
  }

  /** The table is gone (left, expired, or refused): back to the New game dialog. */
  onlineEnded(message) {
    this.online?.forget();
    this.online = null;
    this.room = null;
    this.match = this.game = null;     // the online game must never be saved as a game against bots
    this.leaveLocal();
    this.lobby.close();
    this.setup.open(message);          // back to the home screen
    this.requestRender();
  }

  onNet(msg) {
    if (msg.type === 'room') {
      this.room = msg.room;
      if (msg.room.status === 'lobby' && !this.match) this.lobby.open();
      else this.lobby.close();
      this.lobby.paint();
      this.requestRender();
    } else if (msg.type === 'event') {
      this.netQueue.push(msg);
      this.pumpNet();
    } else if (msg.type === 'sync') {
      this.syncNet(msg.view);
    } else if (msg.type === 'error') {
      this.netWaiting = false;
      this.toast(msg.message);
      this.sfx('nope');
      this.lobby.paint(msg.message, true);
    }
  }

  /** Jump straight to the server's state (reconnecting, or back to the lobby). */
  syncNet(view) {
    this.token += 1;
    this.netQueue = [];
    this.netBusy = this.netWaiting = false;
    this.animating = this.shuffling = this.dealing = false;
    this.flight = this.shuffleAnim = null;
    this.hidden = new Set();
    this.match = view ? loadMatch(view) : null;
    this.game = this.match?.game ?? null;
    if (!this.match && this.room?.status === 'lobby') this.lobby.open();
    else this.lobby.close();
    if (this.myTurn()) this.sfx('turn');
    this.requestRender();
  }

  pumpNet() {
    if (this.netBusy) return;
    const msg = this.netQueue.shift();
    if (!msg) { this.requestRender(); return; }
    this.netBusy = true;
    const token = this.token;
    this.applyNet(msg.event, loadMatch(msg.view), () => {
      if (token !== this.token) return;
      this.netBusy = false;
      this.pumpNet();
    });
  }

  /** Animate one thing that happened at the table, then adopt the server's new state. */
  applyNet(ev, fresh, done) {
    const before = this.game;
    if (ev.kind === 'deal' || !before) {
      this.match = fresh; this.game = fresh.game;
      this.lobby.close();
      this.netWaiting = false;
      if (ev.kind !== 'deal') { this.hidden = new Set(); done(); return; }
      this.hidden = new Set(Object.values(this.game.hands).flat());
      this.dealing = true;
      this.toast('Shuffling the deck…');
      this.shuffle(() => { this.toast('Dealing…'); this.deal(() => { this.afterDeal(); done(); }); });
      return;
    }
    const name = ev.actor, mine = name === HUMAN;
    if (mine) this.netWaiting = false;
    // where things are before the move: the mover's cards, and the throw they may pick from
    const hand = before.hands[name] ?? [];
    const spots = hand.map((c, k) => this.cardPos(name, k, hand.length));
    const prev = before.previousPlayer(name), prevShown = this.shownThrow(prev);
    this.match = fresh; this.game = fresh.game;

    const throwThen = (next) => {
      const origins = {};
      ev.thrown.forEach((c, j) => { origins[c] = spots[mine ? hand.indexOf(c) : j] ?? spots[0] ?? this.deckPos(); });
      this.flyThrow(name, ev.thrown, origins, next);
    };
    const pickThen = (next) => {
      const pick = ev.pick;
      if (pick.card === null && !pick.hidden) { next(); return; }      // the deck ran out a second time
      const origin = pick.fromFloor
        ? this.discardPos(this.seatOf(prev), Math.max(0, prevShown.indexOf(pick.card)), prevShown.length)
        : this.deckPos();
      const newHand = this.game.hands[name];
      const inHand = newHand[newHand.length - 1];
      this.flyPick(name, { ...pick, card: inHand }, origin, pick.fromFloor, next,
        pick.fromFloor || mine ? pick.card : null);
    };
    const finish = (message = '') => {
      if (message) this.toast(message);
      if (this.game.over) this.endRound(); else this.scheduleBots();
      done();
    };
    const took = (pick) => (pick.fromFloor ? `took ${cardText(pick.card)} from the floor` : 'drew from the deck');

    switch (ev.kind) {
      case 'pass':
        if (!mine) this.toast(`${name} didn't call Salami`);
        finish();
        break;
      case 'call':
        finish();
        break;
      case 'throw':
        throwThen(() => { this.scheduleBots(); done(); });
        break;
      case 'pick':
        pickThen(() => finish(mine ? '' : `${name} ${took(ev.pick)}`));
        break;
      case 'turn':          // a stand-in bot's whole turn, for someone who is away
        if (ev.passed || (ev.showdown && !ev.thrown)) { finish(); break; }
        throwThen(() => pickThen(() => finish(
          ev.pick.card === null && !ev.pick.hidden ? '' : `${name} threw ${describe(ev.thrown)} and ${took(ev.pick)}`)));
        break;
      default:
        done();
    }
  }

  /** Is this player away right now (a stand-in bot plays for them)? */
  isAway(name) {
    return !!this.room?.members.find((m) => m.name === name && !m.connected);
  }
  get hostName() { return this.room?.members.find((m) => m.host)?.name ?? 'the host'; }

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
    this.save();
    const game = this.game;
    const first = who([game.players[game.first]]);
    if (game.phase === OPENING && game.currentPlayer === HUMAN) {
      this.toast(`Your hand is ${game.total(HUMAN)}: you may call Salami before anyone throws`);
    } else {
      this.toast(`${first} ${first === 'You' ? 'start' : 'starts'}`);
    }
    this.scheduleBots();
  }

  endRound() {
    let summary = this.match.finishRound();
    const match = this.match;
    if (!this.online && match.mode === RACE && summary.knockedOut.includes(HUMAN) && !match.over) {
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
    this.save();
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
    const edge = PORTRAIT ? 80 : 105;
    return [Math.min(Math.max(x, edge), W - edge), y];
  }
  botCardPos(index, k, n, revealed = false) {
    const [x, y] = this.botSeat(index);
    const step = u(revealed ? 26 : 16);
    return [x - (step * (n - 1)) / 2 + k * step, y];
  }
  discardSpot(index) {
    const [seatX, seatY] = this.seatPoint(index);
    if (PORTRAIT && index !== 0 && Math.abs(seatX - CX) > RX * 0.7) {
      // narrow table: a side seat's thrown cards sit right beside its hand, clear of the deck and floor
      const [bx, by] = this.botSeat(index);
      return [bx + (bx < CX ? 1 : -1) * u(84), by];
    }
    if (PORTRAIT && index === 0) return this.seatPoint(0, 0.75);     // your throws sit lower on the tall table
    return this.seatPoint(index, seatY < CY - 1 ? 0.72 : 0.55);
  }
  discardPos(index, k, n) {
    const [x, y] = this.discardSpot(index);
    return [x - (u(24) * (n - 1)) / 2 + k * u(24), y];
  }
  handPos(k, n) {
    const step = BIG[0] + 12;
    return [CX - (step * (n - 1)) / 2 + k * step, HAND_Y];
  }
  deckPos() { return [CX - u(44), DECK_Y]; }
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
  /** Opacity and upward drift of a message shown at `since`: fades in, holds, then floats up and fades. */
  fadeState(now, since, hold) {
    const age = now - since;
    if (age < FADE_IN_MS) return { alpha: ease(age / FADE_IN_MS), lift: 0 };
    if (age < hold) return { alpha: 1, lift: 0 };
    const p = Math.min(1, (age - hold) / TOAST_FADE_MS);
    return { alpha: 1 - ease(p), lift: u(10) * ease(p) };
  }

  // ---------- turn flow ----------
  myTurn(phase = null) {
    const g = this.game;
    return !!g && !g.over && !this.animating && !this.netBusy && !this.netWaiting
      && g.currentPlayer === HUMAN && (phase === null || g.phase === phase);
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
    if (this.online) { this.sendMove({ type: 'throw', card, alone, joker }); return; }
    const hand = this.game.hands[HUMAN];
    const before = Object.fromEntries(hand.map((c, k) => [c, this.handPos(k, hand.length)]));
    const thrown = this.game.throw(HUMAN, card, { alone, joker });
    this.save();
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

  /** `shown`: the face to show in flight, when it differs from the card in the hand (online,
   *  another player's hand holds placeholders). */
  flyPick(name, result, origin, faceUp, onDone, shown = undefined) {
    const hand = this.game.hands[name];
    this.hidden.add(result.card);
    const fly = () => {
      this.sfx('pick');
      const to = this.cardPos(name, hand.length - 1, hand.length);
      const card = shown !== undefined ? shown : faceUp || name === HUMAN ? result.card : null;
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
    if (this.online) { this.sendMove({ type: 'pick', fromFloor, card }); return; }
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
      if (this.online) { if (this.myTurn()) this.sendMove({ type: 'call' }); return; }
      this.game.call(HUMAN);
      this.endRound();
    }
  }

  onPlayOn() {
    if (this.myTurn(OPENING)) {
      if (this.online) { this.sendMove({ type: 'pass' }); return; }
      this.game.passOpening(HUMAN);
      this.scheduleBots();
    }
  }

  /** Online: send a move and wait for the server to confirm it (it comes back as an event). */
  sendMove(msg) {
    if (!this.online.send(msg)) { this.toast('Not connected to the table yet, try again in a moment'); this.sfx('nope'); return; }
    this.netWaiting = true;
    this.requestRender();
  }

  scheduleBots() {
    const g = this.game;
    this.save();
    this.requestRender();
    if (this.online) {                  // the server plays for anyone who is away
      if (g && !g.over && g.currentPlayer === HUMAN) this.sfx('turn');
      return;
    }
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
      const fading = (this.toastMsg && now - this.toastAt < TOAST_MS + TOAST_FADE_MS)
        || (this.lastStatus && now - this.statusAt < STATUS_MS + TOAST_FADE_MS);
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
    oval(CX - RX - 40, CY - RY - 28, CX + RX + 46, CY + RY + 52); c.fillStyle = '#03070d'; c.fill();
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
    if (!PORTRAIT) c.fillText('D H U M B A L', CX, CY - 56);   // no room on the narrow table
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
    this.rrect(x1 + 2, y1 + 4, x2 + 3, y2 + 4, r); c.fillStyle = 'rgba(2, 6, 12, 0.55)'; c.fill();
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
    const img = this.cardImages[card];
    if (img && img.complete && img.naturalWidth) {
      // the real card face, clipped to our rounded corners
      c.save(); this.rrect(x1, y1, x2, y2, r); c.clip();
      c.fillStyle = CARD_BG; c.fillRect(x1, y1, w, h);
      c.drawImage(img, x1, y1, w, h);
      if (fill !== CARD_BG) { c.fillStyle = 'rgba(233, 196, 106, 0.32)'; c.fillRect(x1, y1, w, h); }
      c.restore();
      this.rrect(x1, y1, x2, y2, r); c.strokeStyle = outline; c.lineWidth = width; c.stroke();
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
    r = u(r);
    const c = this.ctx;
    if (active || winner) {
      const glow = winner ? WINNER : GOLD;
      for (const [k, t] of [[10, 0.8], [6, 0.6], [3, 0.3]]) {
        c.beginPath(); c.arc(x, y, r + k, 0, Math.PI * 2); c.strokeStyle = mix(glow, BG_BOTTOM, t); c.lineWidth = 3; c.stroke();
      }
    }
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    c.strokeStyle = active || winner ? GOLD : '#08111d'; c.lineWidth = active || winner ? 3 : 2; c.stroke();
    this.text(initials, x, y, { size: 12, bold: true, color: AVATAR_INK });
  }

  /** A pill button; returns its width. anchor: 'left' | 'right' | 'center'. */
  drawButton(label, x, y, { primary = false, enabled = true, anchor = 'left', onClick }) {
    const c = this.ctx;
    c.font = font(13, true);
    const w = c.measureText(label).width + u(28), h = u(32);
    const x1 = anchor === 'left' ? x : anchor === 'right' ? x - w : x - w / 2;
    const hover = enabled && this.mouse.x >= x1 && this.mouse.x <= x1 + w && Math.abs(this.mouse.y - y) <= h / 2;
    let bg = primary ? GOLD : PILL;
    if (!enabled) bg = '#13233a'; else if (hover) bg = mix(bg, '#ffffff', 0.18);
    this.rrect(x1, y - h / 2, x1 + w, y + h / 2, h / 2); c.fillStyle = bg; c.fill();
    this.text(label, x1 + w / 2, y + 1, { size: 13, bold: true, color: !enabled ? '#5d718a' : primary ? BLACK : TEXT });
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
    if (MODE === 'popup') {
      this.drawButton(this.isBrave ? '⇥ Open in a window' : '⇥ Open in side panel', W - 16, u(22), { anchor: 'right', onClick: () => { this.sfx('click'); this.openSidePanel(); } });
    }
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
    // top left: the table code (online) and the few rules worth a glance
    let infoX = 18;
    const infoY = u(20);
    if (this.online && this.room) {
      c.font = font(11, true);
      const tw = c.measureText(this.room.code).width + u(16), th = u(20);
      this.rrect(infoX, infoY - th / 2, infoX + tw, infoY + th / 2, th / 2); c.fillStyle = PILL; c.fill();
      this.text(this.room.code, infoX + tw / 2, infoY + 1, { size: 11, bold: true, color: GOLD });
      infoX += tw + u(8);
    }
    const info = `${mode}  ·  call at ${game.callLimit} or less  ·  ${game.jokers} joker${game.jokers > 1 ? 's' : ''}`;
    this.text(info, infoX, infoY, { size: 12, color: MUTED, align: 'left' });

    // centre: deck and floor
    const [dx, dy] = this.deckPos(), fx = CX + u(44), hw = MID[0] / 2, hh = MID[1] / 2;
    if (!this.shuffling && game.deck.length) {
      for (let k = Math.min(4, Math.max(Math.floor(game.deck.length / 10), 1)); k > 0; k--) this.drawCard(dx + k * 1.2, dy - k * 1.6, null, MID);
      this.drawCard(dx, dy, null, MID);
    }
    if (canPick) {
      this.rrect(dx - hw - 5, dy - hh - 5, dx + hw + 5, dy + hh + 5, 9); c.strokeStyle = GOLD; c.lineWidth = 3; c.stroke();
      this.region(dx - hw - 5, dy - hh - 5, dx + hw + 5, dy + hh + 5, { click: () => this.onPick(false), cursor: 'pointer' });
    }
    this.text(`Deck ${game.deck.length}`, dx, dy + hh + u(14), { size: 11, color: MUTED });
    const visibleFloor = game.floor.filter((card) => !this.hidden.has(card));
    if (visibleFloor.length) this.drawCard(fx, dy, visibleFloor[visibleFloor.length - 1], MID);
    else { this.rrect(fx - hw, dy - hh, fx + hw, dy + hh, 7); c.strokeStyle = FELT_LINE; c.lineWidth = 2; c.stroke(); }
    this.text(`Floor ${game.floor.length}`, fx, dy + hh + u(14), { size: 11, color: MUTED });

    // each player's last throw, between their seat and the centre
    for (const name of result ? [] : game.players) {
      const i = this.seatOf(name), thrown = this.shownThrow(name), stands = jokerStandsFor(game.lastThrow[name]);
      thrown.forEach((card, k) => {
        if (this.hidden.has(card)) return;
        const [x, y] = this.discardPos(i, k, thrown.length);
        if (stands[card]) this.text(`as ${stands[card]}`, x, y + MID[1] / 2 + u(10), { size: 10, bold: true, color: GOLD });
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
        const label = PORTRAIT ? (canPick ? 'pick one' : game.floorUnlocked.has(HUMAN) ? 'available' : 'locked')
          : canPick ? (offers.length > 1 ? 'pick any one of these' : 'you can pick this')
          : game.floorUnlocked.has(HUMAN) ? 'available to pick' : 'pickable once you throw|a double or sequence';
        const lines = label.split('|'), style = { size: 11, bold: true, color: GOLD };
        if (ty < CY - 1 && Math.abs(tx - CX) < RX * 0.3) {
          // the seat at the top of the table: above the cards would cover the player's name and
          // hand, and below them the messages in the middle, so the label sits beside the cards
          const half = (u(24) * (thrown.length - 1)) / 2 + MID[0] / 2 + u(10);
          const right = tx <= CX + 1;
          lines.forEach((ln, j) => this.text(ln, right ? tx + half : tx - half,
            ty + (j - (lines.length - 1) / 2) * u(14), { ...style, align: right ? 'left' : 'right' }));
        } else {
          // upper side seats: line the label up with the cards' outer edge, clear of the player's hand
          const side = ty < CY - 1 ? Math.sign(tx - CX) : 0;
          const edge = (u(24) * (thrown.length - 1)) / 2 + MID[0] / 2;
          lines.forEach((ln, j) => this.text(ln, tx + side * edge, ty - MID[1] / 2 - u(14) - (lines.length - 1 - j) * u(14),
            { ...style, align: side > 0 ? 'right' : side < 0 ? 'left' : 'center' }));
        }
      }
    }

    for (const name of this.match.seats) {
      if (name === HUMAN) continue;
      if (game.players.includes(name)) this.drawBot(this.seatOf(name), name);
      else this.drawOutSeat(this.seatOf(name), name);
    }
    this.drawHuman();
    this.drawFlights(now);
    if (result && game === this.match.scoredGame) this.drawResult();   // only once the round is scored
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
      this.drawAvatar(x - half - u(30), y, initials(name), color, isTurn, isWinner);
    } else {
      this.drawAvatar(x, y - u(result ? 62 : 46), initials(name), color, isTurn, isWinner);
    }
    const below = y + u(result ? 46 : 32);
    this.text(name + (result && result.caller === name ? '  · called' : ''), x, below, { size: 13, bold: true, color: isTurn || isWinner ? GOLD : TEXT });
    const away = this.online && this.isAway(name);
    if (result) this.text(this.resultNote(name), x, below + u(18), { size: 12 });
    else if (away) this.text(isTurn ? 'away · a bot is playing…' : 'away · a bot plays for them', x, below + u(17), { size: 11, color: OUT_RED });
    else if (isTurn) this.text('thinking…', x, below + u(17), { size: 11, color: MUTED });
  }

  resultNote(name) {
    const result = this.game.result, total = result.totals[name];
    const salamiBonus = result.salami && !result.caught && name !== result.caller;
    let note = name === result.caller && result.caught ? `total ${total} + ${CAUGHT_PENALTY}`
      : salamiBonus ? `total ${total} + ${SALAMI_BONUS}` : `total ${total}`;
    if (this.match.mode === RACE) {
      const points = result.points[name];
      note += points === 0 ? '  ·  scores 0' : `  ·  +${points}`;
    }
    return note;
  }

  drawOutSeat(index, name) {
    const [x, y] = this.botSeat(index);
    this.drawAvatar(x, y - u(46), initials(name), '#4a5668', false, false);
    this.text('OUT', x, y - u(6), { size: 14, bold: true, color: OUT_RED });
    this.text(`${name}  ·  ${this.match.scores[name]}`, x, y + u(32), { size: 12, bold: true, color: MUTED });
  }

  drawHuman() {
    const game = this.game, result = game.result;
    if (PORTRAIT && !game.players.includes(HUMAN)) {
      this.drawAvatar(36, HAND_Y - 92, 'You', '#4a5668', false, false, 18);
      this.text(`OUT  ·  ${this.match.scores[HUMAN]}`, 66, HAND_Y - 92, { size: 13, bold: true, color: OUT_RED, align: 'left' });
      this.text(this.match.over ? 'You were knocked out of the race.' : `You're out. Watching the ${this.online ? 'others' : 'bots'}…`,
        CX, HAND_Y, { size: 14, bold: true, color: MUTED });
      return;
    }
    if (!game.players.includes(HUMAN)) {
      const lx = CX - 290;
      this.drawAvatar(lx, HAND_Y - u(26), 'You', '#4a5668', false, false, 24);
      this.text(`OUT  ·  ${this.match.scores[HUMAN]}`, lx, HAND_Y + u(14), { size: 13, bold: true, color: OUT_RED });
      this.text(this.match.over ? 'You were knocked out of the race.' : `You're out of the race. Watching the ${this.online ? 'others' : 'bots'}…`,
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
      if (parts.length) this.text(parts.join('   ·   '), CX, HAND_Y - BIG[1] / 2 - (PORTRAIT ? u(12) : u(30)), { size: 12, bold: true, color: GOLD });
    }

    const isTurn = !result && !this.dealing && game.currentPlayer === HUMAN;
    const isWinner = !!(result && result.winners.includes(HUMAN));
    if (PORTRAIT) {
      const y = HAND_Y - 92;
      this.drawAvatar(36, y, 'You', isTurn ? GOLD : '#d8cfb8', isTurn, isWinner, 18);
      const total = hand.filter((card) => !this.hidden.has(card)).reduce((s2, card) => s2 + cardValue(card), 0);
      this.text(result ? this.resultNote(HUMAN) : `total ${total}`, 66, y, { size: 13, bold: true, color: total <= game.limitNow() ? GOLD : TEXT, align: 'left' });
      const bits = [];
      if (this.match.mode === RACE) bits.push(`score ${this.match.scores[HUMAN]}/${RACE_LIMIT}`);
      if (!result) bits.push(game.floorUnlocked.has(HUMAN) ? 'floor pick unlocked' : 'floor pick locked');
      if (bits.length) this.text(bits.join('  ·  '), W - 16, y, { size: 11, color: game.floorUnlocked.has(HUMAN) && !result ? GOLD : MUTED, align: 'right' });
      return;
    }
    const [firstX] = this.handPos(0, Math.max(hand.length, 1));
    const lx = Math.min(firstX - BIG[0] / 2 - u(70), CX - 300);
    this.drawAvatar(lx, HAND_Y - u(38), 'You', isTurn ? GOLD : '#d8cfb8', isTurn, isWinner, 24);
    const total = hand.filter((card) => !this.hidden.has(card)).reduce((s, card) => s + cardValue(card), 0);
    this.text(result ? this.resultNote(HUMAN) : `total ${total}`, lx, HAND_Y + u(2),
      { size: 13, bold: true, color: total <= game.limitNow() ? GOLD : TEXT });
    const lines = [];
    if (this.match.mode === RACE) lines.push([`score ${this.match.scores[HUMAN]} / ${RACE_LIMIT}`, MUTED]);
    if (!result) {
      const unlocked = game.floorUnlocked.has(HUMAN);
      lines.push([unlocked ? 'floor pick unlocked' : 'floor pick locked', unlocked ? GOLD : MUTED]);
    }
    lines.forEach(([s, color], k) => this.text(s, lx, HAND_Y + u(20) + u(16) * k, { size: 11, color }));
  }

  drawResult() {
    const c = this.ctx, match = this.match, result = this.game.result;
    const summary = match.rounds[match.rounds.length - 1], caller = result.caller;
    let called, detail;
    if (result.deckOut) {
      called = 'The deck ran out a second time: everyone shows their hand';
      detail = 'Nobody wins this round; everyone scores their hand';
    } else {
      const ct = result.totals[caller], how = result.salami ? 'called Salami' : 'called';
      if (result.caught) {
        called = `${who([caller])} ${how} with ${ct} and got caught: ${ct} + ${CAUGHT_PENALTY} = ${ct + CAUGHT_PENALTY}`;
        detail = `${who(result.winners)} had the lowest hand (${result.totals[result.winners[0]]})`;
        if (result.tiebreak) detail += `, winning the tie on ${result.tiebreak}`;
      } else {
        called = `${who([caller])} ${how} with ${ct}`;
        detail = result.salami ? `Nobody had an equal or lower hand, so everyone else adds +${SALAMI_BONUS}`
          : 'Nobody had an equal or lower hand';
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
    const half = Math.min(u(225), W / 2 - 12), x1 = CX - half, x2 = CX + half, inner = x2 - x1 - u(40), ops = [];
    let y = 0;
    const line = (s, size, bold, color, gap) => {
      const f = font(size, bold), lh = Math.round(u(size) * 1.35);
      for (const ln of this.wrap(s, inner, f)) { ops.push(['text', ln, CX, y, { size, bold, color, baseline: 'top' }]); y += lh; }
      y += gap;
    };
    if (match.mode === QUICK || match.over) line('♛', 18, false, WINNER, 0);
    line(headline, 20, true, WINNER, 6);
    line(called, 13, false, TEXT, 3);
    line(detail, 12, false, knocked.length ? '#e69a9a' : MUTED, 12);
    if (match.mode === RACE) {
      const span = x2 - x1, col = (f) => x1 + span * f;
      const cols = { name: col(0.06), hand: col(0.44), round: col(0.65), score: col(0.82), note: col(0.85) };
      const cell = (key, s, color, size = 12) => ops.push(['text', s, cols[key], y,
        { size, bold: true, color, baseline: 'top', align: key === 'name' || key === 'note' ? 'left' : 'right' }]);
      for (const [key, s] of [['name', 'Player'], ['hand', 'Hand'], ['round', 'This round'], ['score', 'Score']]) cell(key, s, MUTED, 11);
      y += u(22);
      ops.push(['line', x1 + 24, y, x2 - 24]);
      y += 6;
      for (const name of match.seats) {
        const played = name in result.totals, outNow = knocked.includes(name);
        const outBefore = match.out.includes(name) && !outNow;
        const color = outNow || outBefore ? OUT_RED : result.winners.includes(name) ? WINNER : TEXT;
        cell('name', who([name]), color);
        if (played) {
          const extra = name === caller && result.caught ? `+${CAUGHT_PENALTY}`
            : result.salami && !result.caught && name !== caller ? `+${SALAMI_BONUS}` : '';
          cell('hand', String(result.totals[name]) + extra, color);
          const pts = summary.added[name];
          cell('round', pts === 0 ? '0' : `+${pts}`, color);
        }
        cell('score', String(match.scores[name]), color);
        const note = outNow || outBefore ? 'out' : match.winners.includes(name) || result.winners.includes(name) ? '★' : '';
        cell('note', note, color, 11);
        y += u(24);
      }
      y += 4;
    }
    const host = !this.online || this.room?.isHost;
    if (this.online && !host) {
      line(match.over ? `${this.hostName} can set up another game at this table`
        : `Waiting for ${this.hostName} to deal the next round…`, 12, true, GOLD, 4);
    } else if (match.mode === RACE && !match.over) { ops.push(['next', y + u(2)]); y += u(44); }
    else if (this.online) { ops.push(['again', y + u(2)]); y += u(44); }
    else line('Press New game to play again', 11, false, MUTED, 4);

    const height = y + 28;
    // a little below the middle (the thrown cards are cleared at round end), clear of the top seats
    const top = Math.min(Math.max(CY + (PORTRAIT ? 24 : 52) - height / 2, 96), HAND_Y - BIG[1] / 2 - 14 - height);
    const oy = top + 18;
    this.rrect(x1 + 3, top + 5, x2 + 3, top + height + 5, 18); c.fillStyle = '#03070d'; c.fill();
    this.rrect(x1, top, x2, top + height, 18); c.fillStyle = PANEL; c.fill(); c.strokeStyle = WINNER; c.lineWidth = 2; c.stroke();
    for (const op of ops) {
      if (op[0] === 'text') this.text(op[1], op[2], op[3] + oy, op[4]);
      else if (op[0] === 'line') { c.beginPath(); c.moveTo(op[1], op[2] + oy); c.lineTo(op[3], op[2] + oy); c.strokeStyle = '#2a4466'; c.lineWidth = 1; c.stroke(); }
      else if (op[0] === 'next') this.drawButton('Continue to next round', CX, op[1] + oy + u(16), { primary: true, anchor: 'center', onClick: () => { this.sfx('click'); if (this.online) this.online.send({ type: 'next' }); else this.startRound(); } });
      else if (op[0] === 'again') this.drawButton('Play again at this table', CX, op[1] + oy + u(16), { primary: true, anchor: 'center', onClick: () => { this.sfx('click'); this.online.send({ type: 'again' }); } });
    }
  }

  drawToast(now) {
    if (!this.toastMsg) return;
    const { alpha, lift } = this.fadeState(now, this.toastAt, TOAST_MS);
    if (alpha <= 0) return;
    const c = this.ctx, lines = this.wrap(this.toastMsg, Math.min(560, W - 40), font(11.5, true)), lh = u(15);
    const bottom = TOAST_Y - 2 - lift;
    c.save();
    c.globalAlpha = alpha;
    c.shadowColor = 'rgba(0, 0, 0, 0.75)'; c.shadowBlur = 6; c.shadowOffsetY = 1;   // readable without a box
    lines.forEach((ln, i) => this.text(ln, CX, bottom - (lines.length - i) * lh + lh / 2, { size: 11.5, bold: true, color: TEXT }));
    c.restore();
  }

  drawBar() {
    const game = this.game;
    let left = 20;
    if (this.online) left += this.drawButton(PORTRAIT ? 'Leave' : 'Leave table', left, BAR_Y, { onClick: () => { this.sfx('click'); this.leaveTable(); } }) + 8;
    else left += this.drawButton(PORTRAIT ? 'New' : 'New game', left, BAR_Y, { onClick: () => { this.sfx('click'); this.setup.open(); } }) + 8;
    const soundLabel = !this.sounds.available ? '♪ No sound' : PORTRAIT ? (this.sounds.enabled ? '♪' : '♪ off')
      : this.sounds.enabled ? '♪ Sound on' : '♪ Sound off';
    left += this.drawButton(soundLabel, left, BAR_Y, { enabled: this.sounds.available, onClick: () => this.toggleSound() }) + 14;
    const callLabel = this.myTurn(OPENING) ? 'Call Salami' : PORTRAIT ? 'Call showdown'
      : this.match?.mode === RACE ? 'Call showdown · end round' : 'Call showdown · end game';
    const canCall = !!game && game.canCall(HUMAN) && !this.animating && !this.netBusy && !this.netWaiting;
    let right = W - 20 - this.drawButton(callLabel, W - 20, BAR_Y, { primary: true, enabled: canCall, anchor: 'right', onClick: () => this.onCall() }) - 14;
    if (this.myTurn(OPENING)) {
      right -= this.drawButton('Play on', right + 6, BAR_Y, { anchor: 'right', onClick: () => { this.sfx('click'); this.onPlayOn(); } }) + 8;
    }
    const status = this.statusText(), now = performance.now();
    if (status !== this.lastStatus) { this.lastStatus = status; this.statusAt = now; }
    if (status) {
      const { alpha, lift } = this.fadeState(now, this.statusAt, STATUS_MS);
      if (alpha > 0) {
        // narrow layout: the status sits above the buttons, full width
        const [x0, x1, yc] = PORTRAIT ? [16, W - 16, BAR_Y - u(42)] : [left, right, BAR_Y];   // narrow: above the buttons
        const lines = this.wrap(status, x1 - x0, font(11.5, true));
        const lh = u(15), y0 = yc - ((lines.length - 1) * lh) / 2 - lift;
        this.ctx.save(); this.ctx.globalAlpha = alpha;
        lines.forEach((ln, i) => this.text(ln, (x0 + x1) / 2, y0 + i * lh, { size: 11.5, bold: true, color: GOLD }));
        this.ctx.restore();
      }
    }
  }

  statusText() {
    const game = this.game;
    if (!game) return this.online ? (this.online.connected ? 'Waiting for the game to start…' : 'Connecting to the table…') : 'Press New game to start.';
    const match = this.match;
    if (game.over && this.online) {
      if (!this.room?.isHost) return match.over ? `Game over. ${this.hostName} can start another game at this table.` : `Round over. Waiting for ${this.hostName} to deal the next round.`;
      return match.over ? 'Game over. Press Play again to start another game at this table.' : "Round over. Press Continue to next round when everyone's ready.";
    }
    if (game.over) {
      if (match.over) return match.winners.length ? `Game over: ${wins(match.winners)}! Press New game to play again.` : 'Game over: no winner. Press New game to play again.';
      return "Round over. Press Continue to next round when you're ready.";
    }
    if (this.shuffling) return 'Shuffling…';
    if (this.dealing) return 'Dealing…';
    if (!game.players.includes(HUMAN)) return `You're out. ${game.currentPlayer} is playing…`;
    if (game.currentPlayer !== HUMAN) {
      return this.online && this.isAway(game.currentPlayer) ? `${game.currentPlayer} is away: a bot is playing for them…` : `${game.currentPlayer} is playing…`;
    }
    if (this.animating || this.netBusy) return '';
    if (this.netWaiting) return 'Sending…';
    if (game.phase === OPENING) return `Salami: your hand is ${game.total(HUMAN)} (${OPENING_CALL_LIMIT} or less). Call Salami before anyone throws (if you're not caught, everyone else gets +${SALAMI_BONUS}), or Play on.`;
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

const BOTS = 'bots', FRIENDS = 'friends', JOIN = 'join', CREATE = 'create';

class SetupDialog {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('setup');
    this.values = {};
    this.busy = false;
    const rows = [
      ['opponents', [[BOTS, 'Bots'], [FRIENDS, 'Friends online']]],
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
    this.el.querySelector('#opening-note').textContent = `Before the first throw of a round, anyone with ${OPENING_CALL_LIMIT} or less may call Salami: if they're not caught, everyone else gets +${SALAMI_BONUS}.`;
    this.nameInput = this.el.querySelector('#player-name');
    this.codeInput = this.el.querySelector('#join-code');
    this.errorEl = this.el.querySelector('#online-error');
    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = this.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    this.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.join(); } });
    this.el.querySelector('#join').addEventListener('click', () => this.join());
    this.tab = store.get('onlineTab', JOIN) === CREATE ? CREATE : JOIN;
    const tabs = [...this.el.querySelectorAll('[role="tab"]')];
    for (const b of tabs) {
      b.addEventListener('click', () => this.showTab(b.dataset.tab));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const next = tabs[(tabs.indexOf(b) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          this.showTab(next.dataset.tab);
          next.focus();
        }
      });
    }
    this.el.querySelector('#deal').addEventListener('click', () => this.start());
    this.el.querySelector('#cancel').addEventListener('click', () => this.close());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target !== this.codeInput && !e.target.closest?.('[role="tab"]')) {
        e.preventDefault();
        if (this.online && this.tab === JOIN) this.join(); else this.start();
      }
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
  }

  get online() { return this.values.opponents === FRIENDS; }

  /** Online: show the Join a game or the Create a game tab. */
  showTab(tab) {
    this.tab = tab;
    store.set('onlineTab', tab);
    this.showError(null);
    this.paint();
    (tab === JOIN ? this.codeInput : this.el.querySelector('#deal')).focus();
  }

  paint() {
    for (const box of this.el.querySelectorAll('[data-choice]')) {
      const key = box.dataset.choice;
      for (const b of box.children) b.classList.toggle('on', b.dataset.value === String(this.values[key]));
    }
    this.el.querySelector('#mode-info').textContent = MODE_INFO[this.values.mode];
    this.el.querySelector('#online-fields').hidden = !this.online;
    this.el.querySelector('#players-label').textContent = this.online ? 'Players at the table (you + friends)' : 'Players (you + bots)';
    this.el.querySelector('#rules-note').textContent = this.online
      ? "Choose the rules for everyone at your table. You'll get a code to send your friends."
      : 'These rules apply to every player for the whole game.';
    for (const b of this.el.querySelectorAll('[role="tab"]')) {
      const on = b.dataset.tab === this.tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    this.el.querySelector('#join-panel').hidden = !this.online || this.tab !== JOIN;
    this.el.querySelector('#rules-box').hidden = this.online && this.tab === JOIN;
    const deal = this.el.querySelector('#deal');
    deal.textContent = this.online ? (this.busy ? 'Creating…' : 'Create table') : 'Deal';
    deal.disabled = this.busy;
    this.el.querySelector('#cancel').hidden = !this.app.game;
  }

  showError(message) {
    this.errorEl.textContent = message || '';
    this.errorEl.hidden = !message;
  }

  open(message = null) {
    const s = this.app.settings;
    this.values = {
      opponents: s.opponents ?? BOTS, mode: s.mode, players: s.players, jokers: s.jokers, callLimit: s.callLimit,
    };
    if (message) { this.values.opponents = FRIENDS; this.tab = JOIN; }
    this.nameInput.value = store.get('name', '');
    this.showError(message);
    this.paint();
    this.el.hidden = false;
    (this.online && this.tab === JOIN ? this.codeInput : this.el.querySelector('#deal')).focus();
  }

  close() { this.el.hidden = true; this.app.requestRender(); }

  rules() {
    const { mode, players, jokers, callLimit } = this.values;
    return { mode, players, jokers, callLimit };
  }

  /** Your name for online play, or null (with a message) if it's missing. */
  playerName() {
    const name = this.nameInput.value.trim();
    if (!name) { this.showError('Enter your name first, so your friends know who you are.'); this.nameInput.focus(); return null; }
    store.set('name', name);
    return name;
  }

  remember() {
    this.app.settings = { ...this.rules(), opponents: this.values.opponents };
    store.set('settings', this.app.settings);
  }

  async start() {
    if (this.busy) return;
    this.app.sounds.unlock();
    this.remember();
    if (!this.online) {
      this.close();
      this.app.startGame({ ...this.rules() });
      return;
    }
    const name = this.playerName();
    if (!name) return;
    this.busy = true;
    this.showError(null);
    this.paint();
    try {
      await this.app.createTable(this.rules(), name);
      this.close();
    } catch (e) {
      this.showError(e.message);
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  join() {
    this.app.sounds.unlock();
    this.remember();
    const name = this.playerName();
    if (!name) return;
    const code = this.codeInput.value.trim().toUpperCase();
    if (code.length !== 4) { this.showError('A table code has 4 letters and numbers, like K7QX.'); this.codeInput.focus(); return; }
    this.showError(null);
    this.close();
    this.app.joinTable(code, name);
  }
}

// ---------- the lobby: waiting for friends to join an online table ----------
class LobbyDialog {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('lobby');
    this.message = '';
    this.el.querySelector('#lobby-leave').addEventListener('click', () => { this.app.sfx('click'); this.app.leaveTable(); });
    this.el.querySelector('#lobby-start').addEventListener('click', () => {
      this.app.sounds.unlock();
      const room = this.app.room;
      const missing = room ? room.settings.players - room.members.length : 0;
      if (missing > 0) {
        this.app.sfx('nope');
        this.paint(`Not enough players: waiting for ${missing} more to join.`, true);
        return;
      }
      this.app.sfx('click');
      this.app.online?.send({ type: 'start' });
    });
    this.el.querySelector('#copy-code').addEventListener('click', async () => {
      const code = this.app.room?.code;
      if (!code) return;
      try { await navigator.clipboard.writeText(code); this.paint('Code copied: paste it to your friends.'); } catch { this.paint(`Your table code is ${code}.`); }
    });
  }

  open() { if (this.el.hidden) { this.message = ''; this.el.hidden = false; } this.paint(); }
  close() { this.el.hidden = true; }

  /** `message` replaces the status line until the next change; `warn` shows it as a warning. */
  paint(message = null, warn = false) {
    if (message !== null) { this.message = message; this.warn = warn; }
    const room = this.app.room;
    if (!room || this.el.hidden) return;
    const s = room.settings;
    this.el.querySelector('#lobby-code').textContent = room.code;
    this.el.querySelector('#lobby-rules').textContent = `${s.mode === QUICK ? 'Quick game' : `Race to ${RACE_LIMIT}`}  ·  `
      + `${s.players} players  ·  ${s.jokers} joker${s.jokers > 1 ? 's' : ''}  ·  call at ${s.callLimit} or less`;
    const list = this.el.querySelector('#lobby-members');
    list.replaceChildren();
    for (let k = 0; k < s.players; k++) {
      const m = room.members[k], li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      li.appendChild(dot);
      const label = document.createElement('span');
      if (m) {
        label.textContent = m.you ? `${this.app.online ? store.get('name', 'You') : 'You'} (you)` : m.name;
        if (!m.connected) li.classList.add('away');
      } else {
        label.textContent = 'Waiting for a friend…';
        li.classList.add('open');
      }
      li.appendChild(label);
      if (m?.host) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'host'; li.appendChild(tag); }
      list.appendChild(li);
    }
    const missing = s.players - room.members.length;
    const start = this.el.querySelector('#lobby-start');
    start.hidden = !room.isHost;
    start.classList.toggle('waiting', missing > 0);   // still clickable: it explains why it can't start
    const host = room.members.find((m) => m.host)?.name ?? 'the host';
    const status = missing > 0 ? `Waiting for ${missing} more player${missing > 1 ? 's' : ''}…`
      : room.isHost ? 'Everyone is here. Press Start to deal!' : `Everyone is here. Waiting for ${host} to start…`;
    const line = this.el.querySelector('#lobby-status');
    line.textContent = this.message || status;
    line.classList.toggle('warn', !!this.message && this.warn);
    this.message = '';
    this.warn = false;
  }
}

document.documentElement.classList.add(MODE);   // 'popup' fixes the page at Chrome's 800x600 popup size
window.dhumbal = new App(document.getElementById('table'));

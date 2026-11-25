// One online Dhumbal table: the members, the lobby, and the match itself.
// Pure logic with no Cloudflare APIs, so it can be tested in Node. The Durable Object in
// index.js feeds it messages and delivers what it puts in `outbox`.
//
// The match runs on the same rules engine as the extension (extension/js/game.js). Inside the
// engine the players are called by seat ids (p0, p1, …); every member gets their own copy of
// the state in which they are "You", the others go by their names, and the cards they must
// not see (other hands, the deck) are replaced by placeholders.

import {
  CALL_LIMITS, GameError, MAX_PLAYERS, MIN_PLAYERS, Match, OPENING, PICK, QUICK, RACE, loadMatch, saveMatch,
} from '../../extension/js/game.js';

export const ROOM_VERSION = 1;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O or 1/I
export const CODE_LENGTH = 4;
const YOU = 'You';
const MAX_NAME = 16;

// how long a stand-in bot waits before playing (the clients animate in between)
export const BOT_DELAY_MS = 1500;
export const BOT_DELAY_AFTER_DEAL_MS = 6000;

/** Shuffles with the platform's cryptographic randomness, so the deck can't be predicted
 *  from a seed. Same interface as the engine's Rng. */
export class CryptoRng {
  constructor() { this.state = 0; }
  random() {
    const [a, b] = crypto.getRandomValues(new Uint32Array(2));
    return (a * 2 ** 21 + (b >>> 11)) / 2 ** 53;
  }
  randrange(n) { return Math.floor(this.random() * n); }
  choice(items) { return items[this.randrange(items.length)]; }
  shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randrange(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

export const isValidCode = (code) => typeof code === 'string' && code.length === CODE_LENGTH
  && [...code].every((ch) => CODE_ALPHABET.includes(ch));
export const isValidId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function validSettings(s) {
  if (!s || typeof s !== 'object') return null;
  const players = Number(s.players), jokers = Number(s.jokers), callLimit = Number(s.callLimit);
  if (!(players >= MIN_PLAYERS && players <= MAX_PLAYERS && Number.isInteger(players))) return null;
  if (jokers !== 1 && jokers !== 2) return null;
  if (!CALL_LIMITS.includes(callLimit)) return null;
  if (s.mode !== QUICK && s.mode !== RACE) return null;
  return { players, jokers, mode: s.mode, callLimit };
}

/** A display name: trimmed, at most 16 characters, never "You" or a bot's name, unique here. */
function cleanName(raw, taken) {
  let name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  if (!name || name.toLowerCase() === YOU.toLowerCase() || /^bot\d$/i.test(name)) name = 'Player';
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let k = 2; ; k++) {
    const candidate = `${name.slice(0, MAX_NAME - String(k).length - 1)} ${k}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** Replace every string (values and object keys) found in `map`. */
function renameDeep(value, map) {
  if (typeof value === 'string') return map[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => renameDeep(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [map[k] ?? k, renameDeep(v, map)]));
  }
  return value;
}

export class Room {
  /** `data` is the plain JSON kept in storage (see toJSON). */
  constructor(data) {
    this.data = data;
    this.match = data.match ? loadMatch(data.match) : null;
    if (this.match) {
      const rng = new CryptoRng();
      this.match.rng = rng;
      if (this.match.game) this.match.game.rng = rng;
    }
    this.outbox = [];      // [{ to: memberId, msg }]
  }

  static create(code, settings, host, now = Date.now()) {
    const room = new Room({
      v: ROOM_VERSION, code, settings, hostId: host.id, status: 'lobby', members: [],
      match: null, botAt: null, createdAt: now, touchedAt: now,
    });
    room.join(host.id, host.name);
    return room;
  }

  toJSON() {
    return { ...this.data, match: this.match ? saveMatch(this.match) : null };
  }

  get members() { return this.data.members; }
  member(id) { return this.members.find((m) => m.id === id) ?? null; }
  memberBySeat(seat) { return this.members.find((m) => m.seat === seat) ?? null; }
  get connected() { return this.members.filter((m) => m.connected); }

  send(to, msg) { this.outbox.push({ to, msg }); }
  error(to, message) { this.send(to, { type: 'error', message }); }

  // ---------- members ----------
  /** Add someone, or welcome back a member. Returns an error message, or null. */
  join(id, name) {
    const existing = this.member(id);
    if (existing) return null;
    if (this.data.status !== 'lobby') return 'This game has already started.';
    if (this.members.length >= this.data.settings.players) return 'This table is full.';
    this.members.push({
      id, name: cleanName(name, this.members.map((m) => m.name)), seat: null, connected: false, left: false,
    });
    return null;
  }

  connect(id, now = Date.now()) {
    const m = this.member(id);
    if (!m) return;
    m.connected = true;
    m.left = false;
    this.data.touchedAt = now;
    if (!this.member(this.data.hostId)?.connected) this.data.hostId = id;
    this.broadcastRoom();
    if (this.match) this.send(id, { type: 'sync', view: this.viewFor(id) });
    this.scheduleBot(now, BOT_DELAY_MS);
  }

  disconnect(id, now = Date.now()) {
    const m = this.member(id);
    if (!m) return;
    m.connected = false;
    this.data.touchedAt = now;
    if (this.data.status === 'lobby' && !this.match) {
      // nobody has been dealt in yet: free the seat
      this.data.members = this.members.filter((x) => x.id !== id);
    }
    this.passHost();
    this.broadcastRoom();
    this.scheduleBot(now, BOT_DELAY_MS);
  }

  /** Leaving on purpose: in the lobby the seat is freed; in a game a bot plays for you. */
  leave(id, now = Date.now()) {
    const m = this.member(id);
    if (!m) return;
    m.left = true;
    this.disconnect(id, now);
  }

  passHost() {
    const host = this.member(this.data.hostId);
    if (host?.connected) return;
    const next = this.connected[0];
    if (next) this.data.hostId = next.id;
  }

  roomInfo(viewerId) {
    const { code, settings, status, hostId } = this.data;
    return {
      code, settings, status,
      members: this.members.map((m) => ({
        name: m.id === viewerId ? YOU : m.name, connected: m.connected, left: m.left,
        host: m.id === hostId, you: m.id === viewerId,
      })),
      isHost: viewerId === hostId,
    };
  }

  broadcastRoom() {
    for (const m of this.members) this.send(m.id, { type: 'room', room: this.roomInfo(m.id) });
  }

  // ---------- what one member is allowed to see ----------
  nameMap(viewerId) {
    const map = {};
    for (const m of this.members) if (m.seat) map[m.seat] = m.id === viewerId ? YOU : m.name;
    return map;
  }

  viewFor(viewerId) {
    if (!this.match) return null;
    const me = this.member(viewerId)?.seat ?? null;
    const data = JSON.parse(JSON.stringify(saveMatch(this.match)));   // a copy: saveMatch shares the live arrays
    data.rng = 0;                                  // never hand out the random state
    const g = data.game;
    if (g && !g.result) {
      g.deck = g.deck.map((_, k) => `?d${k}`);
      for (const p of g.players) if (p !== me) g.hands[p] = g.hands[p].map((_, k) => `?${p}.${k}`);
    }
    const view = renameDeep(data, this.nameMap(viewerId));
    const i = view.seats.indexOf(YOU);              // the table is drawn with you at the bottom
    if (i > 0) view.seats = [...view.seats.slice(i), ...view.seats.slice(0, i)];
    return view;
  }

  /** Tell everyone what just happened, each with their own copy of the new state. */
  emit(event) {
    for (const m of this.members) {
      const mine = m.seat === event.actor;
      let ev = event;
      if (event.pick && !event.pick.fromFloor && !mine && event.pick.card !== null) {
        ev = { ...event, pick: { ...event.pick, card: null, hidden: true } };   // a card drawn from the deck is secret
      }
      this.send(m.id, { type: 'event', event: renameDeep(ev, this.nameMap(m.id)), view: this.viewFor(m.id) });
    }
  }

  // ---------- messages from a member ----------
  handle(id, msg, now = Date.now()) {
    const m = this.member(id);
    if (!m || !msg || typeof msg !== 'object') return;
    this.data.touchedAt = now;
    try {
      switch (msg.type) {
        case 'start': return this.start(id, now);
        case 'next': return this.next(id, now);
        case 'again': return this.again(id);
        case 'leave': return this.leave(id, now);
        case 'throw': case 'pick': case 'call': case 'pass': return this.play(m, msg, now);
        case 'ping': return this.send(id, { type: 'pong' });
        default: return this.error(id, 'Unknown message.');
      }
    } catch (e) {
      if (e instanceof GameError) return this.error(id, e.message);
      throw e;
    }
  }

  start(id, now) {
    if (id !== this.data.hostId) return this.error(id, 'Only the host can start the game.');
    if (this.data.status !== 'lobby') return this.error(id, 'The game has already started.');
    const { players, jokers, mode, callLimit } = this.data.settings;
    if (this.members.length !== players) {
      return this.error(id, `Waiting for ${players - this.members.length} more player${players - this.members.length > 1 ? 's' : ''}.`);
    }
    this.members.forEach((member, k) => { member.seat = `p${k}`; });
    this.match = new Match({ names: this.members.map((x) => x.seat), jokers, mode, callLimit, rng: new CryptoRng() });
    this.data.status = 'playing';
    this.broadcastRoom();
    this.deal(now);
  }

  deal(now) {
    this.match.newRound();
    this.emit({ kind: 'deal' });
    this.scheduleBot(now, BOT_DELAY_AFTER_DEAL_MS);
  }

  /** Race: the host deals the next round once everyone has seen the result. */
  next(id, now) {
    const match = this.match;
    if (!match || !match.game?.over || match.over) return this.error(id, 'There is no next round to deal.');
    if (id !== this.data.hostId) return this.error(id, 'The host deals the next round.');
    this.deal(now);
  }

  /** After a finished game: back to the lobby with the same people (those who left make room). */
  again(id) {
    if (id !== this.data.hostId) return this.error(id, 'Only the host can set up a new game.');
    if (!this.match?.over) return this.error(id, 'The game is still being played.');
    this.match = null;
    this.data.status = 'lobby';
    this.data.botAt = null;
    this.data.members = this.members.filter((x) => !x.left);
    this.members.forEach((x) => { x.seat = null; });
    this.broadcastRoom();
    for (const x of this.members) this.send(x.id, { type: 'sync', view: null });
  }

  play(member, msg, now) {
    const game = this.match?.game;
    if (!game || game.over) return this.error(member.id, 'There is no round being played.');
    const seat = member.seat;
    if (game.currentPlayer !== seat) return this.error(member.id, "It isn't your turn.");
    if (msg.type === 'throw') {
      if (typeof msg.card !== 'string') return this.error(member.id, 'Which card?');
      const joker = typeof msg.joker === 'string' ? msg.joker : null;
      const thrown = game.throw(seat, msg.card, { alone: !!msg.alone, joker });
      this.emit({ kind: 'throw', actor: seat, thrown });
    } else if (msg.type === 'pick') {
      const pick = game.pick(seat, !!msg.fromFloor, typeof msg.card === 'string' ? msg.card : null);
      if (pick.roundOver) this.match.finishRound();
      this.emit({ kind: 'pick', actor: seat, pick });
    } else if (msg.type === 'call') {
      game.call(seat);
      this.match.finishRound();
      this.emit({ kind: 'call', actor: seat });
    } else if (msg.type === 'pass') {
      game.passOpening(seat);
      this.emit({ kind: 'pass', actor: seat });
    }
    this.scheduleBot(now, BOT_DELAY_MS);
  }

  // ---------- stand-in bots for people who are away ----------
  /** Whose turn needs a bot right now (null if nobody's). */
  botSeat() {
    const game = this.match?.game;
    if (!game || game.over || !this.connected.length) return null;   // nobody watching: wait
    const member = this.memberBySeat(game.currentPlayer);
    return member && !member.connected ? member.seat : null;
  }

  scheduleBot(now, delay) {
    this.data.botAt = this.botSeat() ? now + delay : null;
  }

  /** Called when the timer fires. */
  botStep(now = Date.now()) {
    this.data.botAt = null;
    const seat = this.botSeat();
    if (!seat) return;
    const game = this.match.game;
    if (game.phase === PICK) {             // they threw, then dropped out: finish their turn
      const pick = game.botPick(seat);
      if (pick.roundOver) this.match.finishRound();
      this.emit({ kind: 'pick', actor: seat, pick });
      this.scheduleBot(now, BOT_DELAY_MS);
      return;
    }
    const turn = game.botTurn();
    if (game.over) this.match.finishRound();
    this.emit({
      kind: 'turn', actor: seat, passed: turn.passed, thrown: turn.thrown,
      pick: turn.pick, showdown: !!turn.showdown,
    });
    this.scheduleBot(now, BOT_DELAY_MS);
  }

  /** When the Durable Object should wake up next (a bot's move, or tidying up an idle room). */
  nextWake(idleMs) {
    if (this.data.botAt) return this.data.botAt;
    if (!this.connected.length) return this.data.touchedAt + idleMs;
    return null;
  }
}

export { OPENING };

// Tests for the online room: lobby rules, full games played only from each player's own view,
// stand-in bots for people who drop out, and that nobody is ever sent a card they shouldn't see.
// Run: node server/test/room.test.mjs

import assert from 'node:assert/strict';
import { HUMAN, OPENING, PICK, THROW, loadMatch } from '../../extension/js/game.js';
import { Rng } from '../../extension/js/cards.js';
import { GRACE_MS, Room, validSettings, isValidCode, newCode } from '../src/room.js';

// a fake clock, so grace periods and bot timers can be fast-forwarded
let clock = 1_000_000;
const withClock = (room) => { room.now = () => clock; return room; };
const later = (room, ms) => { clock += ms; room.tick(clock); };

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

const ids = ['alice-0001', 'bobby-0002', 'carol-0003', 'davey-0004', 'erin0-0005'];
const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];

function drain(room) { const out = room.outbox; room.outbox = []; return out; }

/** Every view and event a member receives must hide the other hands, the deck and the RNG. */
function checkPrivacy(out) {
  for (const { msg } of out) {
    if (msg.type === 'event' || msg.type === 'sync') {
      const v = msg.view;
      if (!v) continue;
      assert.equal(v.rng, 0, 'random state leaked');
      assert.equal(v.seats[0], HUMAN, 'the viewer sits at the bottom');
      const g = v.game;
      if (g && !g.result) {
        assert.ok(g.deck.every((c) => c.startsWith('?')), 'deck leaked');
        for (const p of g.players) {
          if (p !== HUMAN) assert.ok(g.hands[p].every((c) => c.startsWith('?')), `hand of ${p} leaked`);
          else assert.ok(g.hands[p].every((c) => !c.startsWith('?')), 'own hand hidden');
        }
      }
    }
    if (msg.type === 'event' && msg.event.pick && !msg.event.pick.fromFloor && msg.event.actor !== HUMAN) {
      assert.equal(msg.event.pick.card, null, 'a card drawn from the deck leaked');
    }
  }
}

function lobby(settings, n = settings.players) {
  const room = withClock(Room.create('ABCD', settings, { id: ids[0], name: names[0] }, clock));
  room.connect(ids[0]);
  for (let k = 1; k < n; k++) { assert.equal(room.join(ids[k], names[k]), null); room.connect(ids[k]); }
  drain(room);
  return room;
}

/** The latest view each member was sent. */
function latestViews(out, views) {
  for (const { to, msg } of out) if ((msg.type === 'event' || msg.type === 'sync') && msg.view) views[to] = msg.view;
  return views;
}

/** A simple player who decides only from their own view. */
function decide(view, rng) {
  const m = loadMatch(view), g = m.game;
  if (!g || g.over || g.currentPlayer !== HUMAN) return null;
  if (g.phase === OPENING) return g.total(HUMAN) <= 6 ? { type: 'call' } : { type: 'pass' };
  if (g.phase === THROW) {
    if (g.canCall(HUMAN) && rng.random() < 0.6) return { type: 'call' };
    const hand = g.hands[HUMAN];
    return { type: 'throw', card: rng.choice(hand), alone: rng.random() < 0.3 };
  }
  if (g.phase === PICK) {
    if (g.pickables.length && rng.random() < 0.5) return { type: 'pick', fromFloor: true, card: rng.choice(g.pickables) };
    return { type: 'pick', fromFloor: false };
  }
  return null;
}

test('settings, codes and names', () => {
  assert.deepEqual(validSettings({ players: 3, jokers: 2, mode: 'race', callLimit: 10 }), { players: 3, jokers: 2, mode: 'race', callLimit: 10 });
  assert.equal(validSettings({ players: 6, jokers: 1, mode: 'quick', callLimit: 5 }), null);
  assert.equal(validSettings({ players: 2, jokers: 3, mode: 'quick', callLimit: 5 }), null);
  assert.equal(validSettings({ players: 2, jokers: 1, mode: 'blitz', callLimit: 5 }), null);
  for (let k = 0; k < 50; k++) assert.ok(isValidCode(newCode()));
  const room = Room.create('ABCD', validSettings({ players: 5, jokers: 1, mode: 'quick', callLimit: 5 }), { id: ids[0], name: 'Sam' });
  room.join(ids[1], 'sam'); room.join(ids[2], 'You'); room.join(ids[3], 'Bot2'); room.join(ids[4], '  a\u0007very long name indeed!!  ');
  assert.deepEqual(room.members.map((m) => m.name), ['Sam', 'sam 2', 'Player', 'Player 2', 'avery long name']);
});

test('lobby: full table, host-only start, start needs everyone', () => {
  const room = withClock(Room.create('ABCD', validSettings({ players: 3, jokers: 1, mode: 'quick', callLimit: 5 }), { id: ids[0], name: 'A' }, clock));
  room.connect(ids[0]);
  room.join(ids[1], 'B'); room.connect(ids[1]);
  drain(room);
  room.handle(ids[0], { type: 'start' });
  assert.match(drain(room).find((o) => o.msg.type === 'error').msg.message, /Not enough players: waiting for 1 more to join/);
  room.join(ids[2], 'C'); room.connect(ids[2]);
  assert.equal(room.join(ids[3], 'D'), 'This table is full.');
  drain(room);
  room.handle(ids[1], { type: 'start' });
  assert.match(drain(room)[0].msg.message, /Only the host/);
  room.handle(ids[0], { type: 'start' });
  const out = drain(room);
  assert.equal(room.data.status, 'playing');
  assert.equal(out.filter((o) => o.msg.type === 'event' && o.msg.event.kind === 'deal').length, 3);
  checkPrivacy(out);
  assert.equal(room.join(ids[3], 'D'), 'This game has already started.');
  // someone leaving the lobby frees their seat; the host moves on if the host goes
  const r2 = lobby(validSettings({ players: 3, jokers: 1, mode: 'quick', callLimit: 5 }), 2);
  r2.disconnect(ids[0]);
  assert.equal(r2.members.length, 2, 'a dropped connection keeps its seat for a moment');
  assert.equal(r2.data.hostId, ids[0]);
  r2.connect(ids[0]);                     // a quick reconnect changes nothing
  r2.disconnect(ids[0]);
  later(r2, GRACE_MS + 1);
  assert.equal(r2.members.length, 1);
  assert.equal(r2.data.hostId, ids[1]);
  r2.leave(ids[1]);                       // leaving on purpose frees the seat at once
  assert.equal(r2.members.length, 0);
});

test('acting out of turn or illegally is refused', () => {
  const room = lobby(validSettings({ players: 3, jokers: 1, mode: 'quick', callLimit: 5 }));
  room.handle(ids[0], { type: 'start' });
  const views = latestViews(drain(room), {});
  const current = room.memberBySeat(room.match.game.currentPlayer);
  const other = room.members.find((m) => m !== current);
  room.handle(other.id, { type: 'pass' });
  assert.match(drain(room)[0].msg.message, /isn't your turn/);
  if (room.match.game.phase === THROW) {
    room.handle(current.id, { type: 'throw', card: 'XX' });
    assert.match(drain(room)[0].msg.message, /not in your hand/);
  }
  assert.ok(views[current.id]);
});

function playGame(settings, seed, { dropOut = false } = {}) {
  const rng = new Rng(seed);
  const room = lobby(settings);
  room.handle(ids[0], { type: 'start' });
  let out = drain(room);
  checkPrivacy(out);
  const views = latestViews(out, {});
  let steps = 0, dropped = null, botMoves = 0;
  while (true) {
    assert.ok(steps++ < 20000, 'game did not finish');
    const match = room.match;
    if (match.over) break;
    if (match.game.over) {              // race: the host deals the next round
      room.handle(room.data.hostId, { type: 'next' });
    } else if (room.data.botAt || room.data.settleAt) {
      const before = room.match.game.turns + room.match.game.floor.length;
      clock = Math.max(clock, Math.min(...[room.data.botAt, room.data.settleAt].filter((t) => t)));
      room.tick(clock);
      if (room.match.game.turns + room.match.game.floor.length !== before || room.match.game.over) botMoves += 1;
    } else {
      // somebody drops out for a while, then comes back
      if (dropOut && !dropped && rng.random() < 0.02) {
        dropped = rng.choice(room.members.filter((m) => m.id !== room.data.hostId));
        room.disconnect(dropped.id);
      } else if (dropped && rng.random() < 0.01) {
        room.connect(dropped.id);
        dropped = null;
      } else {
        const seat = match.game.currentPlayer, member = room.memberBySeat(seat);
        const action = decide(views[member.id], rng);
        assert.ok(action, `no action for ${member.name}`);
        room.handle(member.id, action);
      }
    }
    out = drain(room);
    checkPrivacy(out);
    for (const o of out) assert.notEqual(o.msg.type, 'error', `unexpected error: ${o.msg.message}`);
    latestViews(out, views);
  }
  // everyone saw the final state, and their copy agrees with the server's
  for (const m of room.members) {
    if (!m.connected) continue;
    const v = loadMatch(views[m.id]);
    assert.ok(v.over && v.game.over);
    assert.deepEqual(v.winners.map((w) => (w === HUMAN ? m.name : w)).sort(),
      room.match.winners.map((s) => room.memberBySeat(s).name).sort());
  }
  return { room, botMoves };
}

test('quick games, 2-5 players, played from each player\'s view', () => {
  for (let seed = 0; seed < 120; seed++) {
    playGame(validSettings({ players: 2 + (seed % 4), jokers: 1 + (seed % 2), mode: 'quick', callLimit: [5, 10, 15][seed % 3] }), seed);
  }
});

test('races to 100 with knock-outs', () => {
  for (let seed = 0; seed < 25; seed++) {
    const { room } = playGame(validSettings({ players: 2 + (seed % 4), jokers: 1, mode: 'race', callLimit: [5, 10, 15][seed % 3] }), 1000 + seed);
    assert.ok(room.match.rounds.length >= 1);
  }
});

test('a bot plays for whoever drops out, and they can come back', () => {
  let bots = 0;
  for (let seed = 0; seed < 40; seed++) {
    bots += playGame(validSettings({ players: 3 + (seed % 3), jokers: 1, mode: seed % 2 ? 'race' : 'quick', callLimit: 15 }), 5000 + seed, { dropOut: true }).botMoves;
  }
  assert.ok(bots > 0, 'no bot ever played');
});

test('nobody connected: the bot waits; reconnecting gets a sync', () => {
  const room = lobby(validSettings({ players: 2, jokers: 1, mode: 'quick', callLimit: 5 }));
  room.handle(ids[0], { type: 'start' });
  drain(room);
  room.disconnect(ids[0]); room.disconnect(ids[1]);
  later(room, GRACE_MS + 1);
  assert.equal(room.data.botAt, null);
  assert.ok(room.nextWake(1000) > 0);
  room.connect(ids[1]);
  const out = drain(room);
  assert.ok(out.some((o) => o.to === ids[1] && o.msg.type === 'sync' && o.msg.view));
  checkPrivacy(out);
});

test('a blip during a game: no bot unless they stay away', () => {
  const room = lobby(validSettings({ players: 2, jokers: 1, mode: 'quick', callLimit: 5 }));
  room.handle(ids[0], { type: 'start' });
  drain(room);
  const current = room.memberBySeat(room.match.game.currentPlayer);
  room.disconnect(current.id);
  assert.equal(room.data.botAt, null, 'no bot during the grace period');
  assert.ok(room.data.settleAt);
  later(room, 2000);
  room.connect(current.id);
  later(room, GRACE_MS * 2);
  assert.equal(room.data.botAt, null, 'came back in time: still their turn');
  assert.equal(room.match.game.currentPlayer, current.seat);
  room.disconnect(current.id);
  later(room, GRACE_MS + 1);
  assert.ok(room.data.botAt, 'stayed away: a bot is due');
  const info = drain(room).filter((o) => o.msg.type === 'room' && o.to !== current.id).pop().msg.room;
  assert.equal(info.members.find((m) => !m.you).connected, false);
});

test('storage round trip mid-game keeps playing identically', () => {
  const room = lobby(validSettings({ players: 4, jokers: 2, mode: 'race', callLimit: 10 }));
  room.handle(ids[0], { type: 'start' });
  drain(room);
  const copy = withClock(new Room(JSON.parse(JSON.stringify(room.toJSON()))));
  assert.deepEqual(copy.viewFor(ids[2]), room.viewFor(ids[2]));
  assert.equal(copy.match.rng.constructor.name, 'CryptoRng');
});

test('play again returns everyone to the lobby', () => {
  const { room } = playGame(validSettings({ players: 3, jokers: 1, mode: 'quick', callLimit: 15 }), 77);
  room.handle(room.data.hostId, { type: 'again' });
  assert.equal(room.data.status, 'lobby');
  assert.equal(room.match, null);
  assert.ok(room.members.every((m) => m.seat === null));
  room.handle(room.data.hostId, { type: 'start' });
  assert.equal(room.data.status, 'playing');
});

console.log(`\n${passed} tests passed`);

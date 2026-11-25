// End-to-end test against a running server (wrangler dev, or the deployed one):
// three players create and join a table over WebSockets, play a quick game and a race,
// one of them drops out mid-game (a bot takes over on the server's timer) and comes back.
// Run: node server/test/live.test.mjs [http://127.0.0.1:8787]

import assert from 'node:assert/strict';
import { HUMAN, OPENING, PICK, THROW, loadMatch } from '../../extension/js/game.js';
import { Rng } from '../../extension/js/cards.js';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws');
const rng = new Rng(42);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomId = () => `test-${crypto.randomUUID()}`;

class Client {
  constructor(name) { this.name = name; this.id = randomId(); this.view = null; this.room = null; this.errors = []; this.events = []; this.version = 0; this.blips = 0; }
  connect(code) {
    this.code = code;
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS}/rooms/${code}/ws?id=${this.id}&name=${encodeURIComponent(this.name)}`);
      this.ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'room') { this.room = msg.room; resolve(); }
        else if (msg.type === 'event') { this.view = msg.view; this.events.push(msg.event); this.version += 1; }
        else if (msg.type === 'sync') { this.view = msg.view; this.version += 1; }
        else if (msg.type === 'error') { this.errors.push(msg.message); if (msg.fatal) reject(new Error(msg.message)); }
      };
      this.ws.onerror = () => reject(new Error('socket error'));
      const ws = this.ws;
      // like the extension: a dropped connection reconnects at once (the server keeps the seat)
      ws.onclose = () => { if (!this.closing && this.ws === ws) { this.blips += 1; setTimeout(() => this.connect(code).catch(() => {}), 300); } };
    });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  close() { this.closing = true; this.ws.close(); }
}

async function until(fn, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(20); }
  throw new Error(`timed out waiting for ${what}`);
}

function decide(view) {
  const g = loadMatch(view).game;
  if (!g || g.over || g.currentPlayer !== HUMAN) return null;
  if (g.phase === OPENING) return { type: 'pass' };
  if (g.phase === THROW) return g.canCall(HUMAN) ? { type: 'call' } : { type: 'throw', card: rng.choice(g.hands[HUMAN]) };
  if (g.phase === PICK) return g.pickables.length ? { type: 'pick', fromFloor: true, card: g.pickables[0] } : { type: 'pick', fromFloor: false };
  return null;
}

async function createRoom(settings, host) {
  const res = await fetch(`${BASE}/rooms`, { method: 'POST', body: JSON.stringify({ settings, id: host.id, name: host.name }) });
  assert.equal(res.status, 200);
  return (await res.json()).code;
}

async function play(settings, { dropOut = false } = {}) {
  const [a, b, c] = ['Asha', 'Bikash', 'Chandra'].map((n) => new Client(n));
  const code = await createRoom(settings, a);
  assert.match(code, /^[A-Z2-9]{4}$/);
  const info = await (await fetch(`${BASE}/rooms/${code}`)).json();
  assert.deepEqual(info, { exists: true, status: 'lobby', seats: 1, players: 3 });
  await a.connect(code); await b.connect(code); await c.connect(code);
  await until(() => a.room.members.length === 3, 'everyone in the lobby');
  assert.ok(a.room.isHost && !b.room.isHost);
  assert.deepEqual(a.room.members.map((m) => m.name), ['You', 'Bikash', 'Chandra']);

  // a fourth person can't join a full table
  await assert.rejects(new Client('Dipesh').connect(code), /full/);

  a.send({ type: 'start' });
  await until(() => a.view && b.view && c.view, 'the deal');
  let dropped = false, back = false, steps = 0;
  const players = [a, b, c];
  while (true) {
    assert.ok(steps++ < 4000, 'game did not finish');
    const live = players.filter((p) => p.ws.readyState === WebSocket.OPEN);
    const m = loadMatch(live[0].view);
    if (m.over) break;
    if (m.game.over) {
      const host = live.find((p) => p.room.isHost);
      const before = host.version;
      host.send({ type: 'next' });
      await until(() => host.version > before, 'the next round');
      continue;
    }
    if (dropOut && !dropped && m.game.turns >= 2) {
      dropped = true;
      c.close();
      await until(() => a.room.members.find((x) => x.name === 'Chandra')?.connected === false, 'Chandra to drop');
      continue;
    }
    if (dropOut && dropped && !back && c.events.length && a.events.filter((e) => e.kind === 'turn').length >= 2) {
      back = true;
      c.view = null;
      c.closing = false;
      await c.connect(code);
      await until(() => c.view, 'the resync');
      continue;
    }
    const mover = live.find((p) => decide(p.view));
    if (!mover) {             // a stand-in bot is due: wait for the server's timer
      // nobody's own copy says it's their turn: a stand-in bot is due, or some player's copy is
      // still catching up with the last move, so wait for anyone's next update
      const before = players.map((p) => p.version);
      try {
        await until(() => players.some((p, k) => p.version > before[k]), 'a bot move');
      } catch (e) {
        for (const p of players) {
          const g = p.view && loadMatch(p.view).game;
          console.log(`  ${p.name}: ws=${p.ws.readyState} blips=${p.blips} errors=${JSON.stringify(p.errors)} current=${g?.currentPlayer} phase=${g?.phase} over=${g?.over} turns=${g?.turns} room=${JSON.stringify(p.room?.members)}`);
        }
        throw e;
      }
      continue;
    }
    const before = mover.version;
    if (mover.ws.readyState !== WebSocket.OPEN) { await sleep(500); continue; }
    mover.send(decide(mover.view));
    await until(() => mover.version > before || mover.errors.length, 'the move');
    assert.deepEqual(mover.errors, []);
  }
  // every hand was hidden from everyone else in every event
  for (const p of players) {
    for (const e of p.events) if (e.pick && !e.pick.fromFloor && e.actor !== HUMAN) assert.equal(e.pick.card, null);
  }
  if (dropOut) assert.ok(a.events.some((e) => e.kind === 'turn'), 'a bot played for Chandra');
  const blips = players.reduce((n, p) => n + p.blips, 0);
  if (blips) console.log(`  (${blips} dropped connection${blips > 1 ? 's' : ''} reconnected along the way)`);
  players.forEach((p) => p.close());
  return loadMatch(a.view);
}

const quick = await play({ players: 3, jokers: 1, mode: 'quick', callLimit: 15 });
console.log(`ok - quick game over WebSockets (winners: ${quick.winners.join(', ') || 'none'})`);
const race = await play({ players: 3, jokers: 2, mode: 'race', callLimit: 15 }, { dropOut: true });
console.log(`ok - race with a drop-out and a stand-in bot: ${race.rounds.length} rounds`);
const missing = await fetch(`${BASE}/rooms/ZZZZ`);
assert.equal(missing.status, 404);
console.log('ok - unknown table code');
process.exit(0);   // (reconnect timers would otherwise keep Node running)

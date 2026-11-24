// Rule tests for the JavaScript engine (a port of the Python test suite's engine parts).
// Run: node tests/engine.test.mjs
import assert from 'node:assert/strict';
import * as C from '../js/cards.js';
import {
  CAUGHT_PENALTY, DumbalGame, GameError, HUMAN, Match, OPENING, PICK, QUICK, RACE, RACE_LIMIT, THROW,
} from '../js/game.js';

const { Rng } = C;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };
const throws = (fn) => assert.throws(fn, GameError);
const fresh = (n = 3, j = 1, seed = 0, extra = {}) =>
  new DumbalGame({ numPlayers: n, jokers: j, rng: new Rng(seed), opening: false, callLimit: 15, ...extra });

test('cards: deck, values, sets and sequences', () => {
  assert.equal(C.newDeck(new Rng(1), 1).length, 53);
  assert.equal(new Set(C.newDeck(new Rng(1), 2)).size, 54);
  assert.equal(C.cardValue('JK1'), 0);
  assert.equal(C.handTotal(['A♠', '10♦', 'K♣']), 24);
  for (const r of [['Q♠', 'K♠', 'A♠'], ['A♠', '2♠', '3♠'], ['10♦', 'J♦', 'Q♦', 'K♦', 'A♦'], ['8♠', '9♠', 'JK1'], ['8♠', '10♠', 'JK1']]) {
    assert.ok(C.isRun(r), r.join());
  }
  for (const r of [['K♠', 'A♠', '2♠'], ['A♠', '2♠', 'K♠'], ['A♠', '2♠'], ['A♠', '2♥', '3♠'], ['8♠', 'JK1', 'JK2']]) {
    assert.ok(!C.isRun(r), r.join());
  }
  assert.ok(C.isSet(['7♠', 'JK1']) && C.isSet(['JK1', 'JK2']) && !C.isSet(['7♠', '8♠', 'JK1']));
  assert.deepEqual(C.jokerStandsFor(['Q♠', 'K♠', 'JK1']), { JK1: 'A♠' });
  assert.deepEqual(C.jokerStandsFor(['8♠', '9♠', 'JK1']), { JK1: '10♠' });
  assert.deepEqual(C.autoGroup(['Q♣', 'K♣', 'A♣', '2♣', '7♦'], 'A♣'), ['Q♣', 'K♣', 'A♣']);
});

test('turn flow: throw then pick ends the turn; any card of the previous throw can be picked', () => {
  const g = fresh(3);
  assert.equal(g.currentPlayer, HUMAN);
  throws(() => g.throw('Bot1', g.hands.Bot1[0]));
  g.hands[HUMAN] = ['4♠', '5♠', '6♠', 'K♦', '2♣'];
  assert.deepEqual(g.throw(HUMAN, '6♠'), ['4♠', '5♠', '6♠']);
  throws(() => g.call(HUMAN));
  g.pick(HUMAN, false);
  assert.equal(g.currentPlayer, 'Bot1');
  assert.deepEqual(g.availablePicks('Bot1'), ['4♠', '5♠', '6♠']);
  g.hands.Bot1 = ['6♦', '9♣', '9♥', 'Q♠', 'A♣'];
  g.throw('Bot1', '9♥');
  assert.deepEqual(g.pickables, ['4♠', '5♠', '6♠']);            // unlocked by the double
  assert.equal(g.pick('Bot1', true, '5♠').card, '5♠');
  assert.deepEqual(g.availablePicks('Bot2').sort(), ['9♣', '9♥']); // any card of a double
});

test('floor picks unlock after a double or sequence and stay unlocked', () => {
  const g = fresh(2);
  g.hands[HUMAN] = ['5♣', '7♦', '7♠', '2♥', '3♥']; g.current = 1;
  g.hands.Bot1 = ['4♦', 'K♠', '9♣', '9♥', 'Q♠']; g.throw('Bot1', 'K♠'); g.pick('Bot1', false);
  g.throw(HUMAN, '5♣');
  assert.deepEqual(g.pickables, []);
  throws(() => g.pick(HUMAN, true));
  g.pick(HUMAN, false);
  g.hands.Bot1 = ['8♦', 'Q♥', '4♣', '10♠', '6♥']; g.throw('Bot1', 'Q♥'); g.pick('Bot1', false);
  g.hands[HUMAN] = ['7♦', '7♠', '2♥', '9♠', 'J♣']; g.throw(HUMAN, '7♦'); g.pick(HUMAN, false); // unlock
  g.hands.Bot1 = ['8♦', '3♣', '4♣', '10♠', '6♥']; g.throw('Bot1', '8♦'); g.pick('Bot1', false);
  g.hands[HUMAN] = ['9♠', 'J♣', '2♥', 'Q♦'];
  g.throw(HUMAN, '9♠');                                           // a single card...
  assert.deepEqual(g.pickables, ['8♦']);                          // ...but still unlocked
});

test('jokers: wild in sequences and doubles; thrown jokers can be picked', () => {
  const g = fresh(3, 2);
  g.current = 2; g.floorUnlocked.add(HUMAN);
  g.hands.Bot2 = ['3♠', 'JK1', 'K♣', 'Q♥', '9♦']; g.throw('Bot2', '3♠', { joker: 'JK1' }); g.pick('Bot2', false);
  g.hands[HUMAN] = ['9♣', 'Q♦', 'K♠', '4♦', 'J♣']; g.throw(HUMAN, 'K♠');
  assert.deepEqual(new Set(g.pickables), new Set(['JK1', '3♠']));
  assert.equal(g.pick(HUMAN, true, 'JK1').card, 'JK1');
  const h = fresh(2, 1); h.hands[HUMAN] = ['3♠', 'K♦', '9♣', 'Q♥', '2♥'];
  throws(() => h.throw(HUMAN, '3♠', { joker: 'JK1' }));
});

test('showdown: clean call, caught (+25), tie-breaks', () => {
  let g = fresh(3); g.hands = { [HUMAN]: ['A♠', '2♠'], Bot1: ['K♠'], Bot2: ['5♦', '9♣'] };
  let r = g.call(HUMAN); assert.ok(!r.caught); assert.deepEqual(r.winners, [HUMAN]);
  g = fresh(3); g.hands = { [HUMAN]: ['2♠', '3♠'], Bot1: ['A♦', '4♣'], Bot2: ['K♣'] };
  r = g.call(HUMAN); assert.ok(r.caught); assert.deepEqual(r.winners, ['Bot1']);
  assert.deepEqual(r.points, { [HUMAN]: 5 + CAUGHT_PENALTY, Bot1: 0, Bot2: 13 });
  g = fresh(4); g.hands = { [HUMAN]: ['5♠'], Bot1: ['3♦'], Bot2: ['A♣', '2♥'], Bot3: ['K♣'] };
  r = g.call(HUMAN); assert.deepEqual(r.winners, ['Bot1']); assert.equal(r.tiebreak, 'fewer cards');
  g = fresh(4); g.first = 2; g.hands = { [HUMAN]: ['5♠'], Bot1: ['3♦'], Bot2: ['3♣'], Bot3: ['K♣'] };
  r = g.call(HUMAN); assert.deepEqual(r.winners, ['Bot2']); assert.equal(r.tiebreak, 'turn order');
  g = fresh(2); g.hands[HUMAN] = ['K♠', 'K♦']; throws(() => g.call(HUMAN));
});

test('opening call: anyone with 15 or less, in turn, before the first throw', () => {
  const g = new DumbalGame({ numPlayers: 3, rng: new Rng(0), first: 1, callLimit: 5 });
  g.hands = { [HUMAN]: ['K♠', 'Q♠', 'J♠', '9♦', '8♣'], Bot1: ['2♠', '3♦', '4♣', 'A♥', '5♠'], Bot2: ['A♣', '2♦', '3♥', '4♠', '4♥'] };
  g.phase = OPENING; g.openingOffered = 0; g.current = 1; g.nextOpener();
  assert.equal(g.currentPlayer, 'Bot1'); assert.ok(g.canCall('Bot1')); assert.equal(g.limitNow(), 15);
  g.passOpening('Bot1'); assert.equal(g.currentPlayer, 'Bot2');
  g.passOpening('Bot2'); assert.equal(g.phase, THROW); assert.equal(g.currentPlayer, 'Bot1');
  assert.ok(!g.canCall('Bot1')); assert.equal(g.limitNow(), 5);
});

test('deck runs out twice: no winner, everyone scores their hand', () => {
  const g = fresh(2); g.deck = []; g.floor = ['2♠', '3♠', '4♠']; g.hands[HUMAN] = ['K♥', '5♣'];
  g.throw(HUMAN, 'K♥'); let r = g.pick(HUMAN, false);
  assert.ok(r.deckRecreated && g.reshuffles === 1 && !g.over);
  g.deck = []; g.hands.Bot1 = ['9♦', 'J♣']; g.throw('Bot1', '9♦'); r = g.pick('Bot1', false);
  assert.ok(r.roundOver && r.card === null && g.over && g.result.deckOut);
  assert.deepEqual(g.result.winners, []); assert.deepEqual(g.result.points, g.result.totals);
});

test('matches: quick winner, race scoring, knock-outs, the player after the winner starts next', () => {
  const roundOf = (m) => { const g = m.newRound(); g.phase = THROW; g.current = g.first; return g; };
  const callNow = (g, n) => { g.current = g.players.indexOf(n); g.phase = THROW; return g.call(n); };
  let m = new Match({ numPlayers: 3, mode: QUICK, rng: new Rng(1), callLimit: 15 }); let g = roundOf(m);
  g.hands = { [HUMAN]: ['3♠'], Bot1: ['2♦'], Bot2: ['K♣'] }; callNow(g, HUMAN); m.finishRound();
  assert.ok(m.over); assert.deepEqual(m.winners, ['Bot1']);
  const starters = new Set(Array.from({ length: 40 }, (_, s) => new Match({ numPlayers: 3, rng: new Rng(s) }).starter));
  assert.equal(starters.size, 3);
  m = new Match({ numPlayers: 3, mode: RACE, rng: new Rng(1), callLimit: 15 }); g = roundOf(m);
  g.hands = { [HUMAN]: ['3♠'], Bot1: ['9♦', 'K♠'], Bot2: ['K♣', 'Q♣'] }; callNow(g, HUMAN);
  const s1 = m.finishRound(); assert.deepEqual(m.scores, { [HUMAN]: 0, Bot1: 22, Bot2: 25 });
  assert.equal(m.finishRound(), s1); assert.equal(m.starter, 'Bot1');   // you won: the next seat starts
  m.scores.Bot2 = 90; g = roundOf(m);
  g.hands = { [HUMAN]: ['A♠'], Bot1: ['2♣'], Bot2: ['K♣'] }; callNow(g, 'Bot1');
  const s2 = m.finishRound(); assert.ok(s2.caught); assert.deepEqual(s2.winners, [HUMAN]);
  assert.deepEqual(m.out, ['Bot2']); assert.deepEqual(m.active, [HUMAN, 'Bot1']);
  g = roundOf(m); assert.deepEqual(g.players, [HUMAN, 'Bot1']);
  m.scores.Bot1 = 95; g.hands = { [HUMAN]: ['A♠'], Bot1: ['K♣'] }; callNow(g, HUMAN); m.finishRound();
  assert.ok(m.over); assert.deepEqual(m.winners, [HUMAN]);

  // who starts after: a winner in the last seat (wraps to you), a knocked-out next seat (skipped),
  // and a round with no winner (the seat after that round's starter)
  const finishWith = (winner, { knock = [], deckOut = false, starter = HUMAN } = {}) => {
    const mm = new Match({ numPlayers: 4, mode: RACE, rng: new Rng(3), callLimit: 15 });
    mm.starter = starter;
    const gg = roundOf(mm);
    for (const p of knock) mm.scores[p] = 99;
    if (deckOut) { gg.deckOut(); } else {
      gg.hands = { [HUMAN]: ['K♠'], Bot1: ['K♦'], Bot2: ['K♥'], Bot3: ['K♣'] };
      gg.hands[winner] = ['A♠']; callNow(gg, winner);
    }
    mm.finishRound();
    return mm.starter;
  };
  assert.equal(finishWith('Bot1'), 'Bot2');
  assert.equal(finishWith('Bot3'), HUMAN);
  assert.equal(finishWith('Bot1', { knock: ['Bot2'] }), 'Bot3');
  assert.equal(finishWith(null, { deckOut: true, starter: 'Bot2' }), 'Bot3');
});

test('random games and full races always finish with consistent cards', () => {
  let games = 0, races = 0;
  for (let seed = 0; seed < 1500; seed++) {
    const n = 2 + (seed % 4), j = 1 + (Math.floor(seed / 4) % 2), rng = new Rng(seed + 1000);
    const g = new DumbalGame({ numPlayers: n, jokers: j, rng: new Rng(seed), callLimit: [5, 10, 15][seed % 3] });
    const unlocked = new Set();
    for (let step = 0; step < 3000 && !g.over; step++) {
      if (g.phase === OPENING && g.currentPlayer === HUMAN) { rng.random() < 0.2 ? g.call(HUMAN) : g.passOpening(HUMAN); continue; }
      if (g.currentPlayer !== HUMAN) {
        const t = g.botTurn();
        if (t.thrown && t.thrown.length >= 2) unlocked.add(t.name);
        if (t.pick && t.pick.fromFloor) assert.ok(unlocked.has(t.name));
      } else if (g.canCall(HUMAN) && rng.random() < 0.4) {
        g.call(HUMAN);
      } else {
        const hand = g.hands[HUMAN], card = rng.choice(hand), alone = rng.random() < 0.3;
        const jk = hand.find((c) => C.isJoker(c) && c !== card) ?? null;
        const joker = jk && !alone && rng.random() < 0.5 ? jk : null;
        const expect = joker ? C.jokerGroup(hand, card, joker) : alone ? [card] : C.autoGroup(hand, card);
        const th = g.throw(HUMAN, card, { alone, joker });
        assert.deepEqual([...th].sort(), [...expect].sort());
        if (th.length >= 2) unlocked.add(HUMAN);
        if (!unlocked.has(HUMAN)) assert.equal(g.pickable, null);
        const choice = g.pickables.length && rng.random() < 0.5 ? rng.choice(g.pickables) : null;
        g.pick(HUMAN, choice !== null, choice);
      }
      if (g.over) break;
      const count = g.deck.length + g.floor.length + Object.values(g.hands).reduce((s, h) => s + h.length, 0);
      assert.equal(count, 52 + j);
    }
    assert.ok(g.over, `game ${seed} did not finish`); games++;
  }
  for (let seed = 0; seed < 300; seed++) {
    const m = new Match({ numPlayers: 2 + (seed % 4), jokers: 1 + (seed % 2), mode: RACE, rng: new Rng(seed), callLimit: [5, 10, 15][seed % 3] });
    while (!m.over) {
      const g = m.newRound();
      while (!g.over) g.botTurn();
      m.finishRound();
    }
    assert.ok(m.winners.length >= 1); races++;
  }
  console.log(`   (${games} random games, ${races} full bot races)`);
});

console.log(`\n${passed} tests passed`);

// ---- save and restore (the toolbar popup closes whenever you click away) ----
import { saveMatch, loadMatch } from '../js/game.js';
{
  let checked = 0;
  for (let seed = 0; seed < 200; seed++) {
    const m = new Match({ numPlayers: 2 + (seed % 4), jokers: 1 + (seed % 2), mode: seed % 2 ? RACE : QUICK, rng: new Rng(seed), callLimit: [5, 10, 15][seed % 3] });
    const twin = new Match({ numPlayers: 2 + (seed % 4), jokers: 1 + (seed % 2), mode: seed % 2 ? RACE : QUICK, rng: new Rng(seed), callLimit: [5, 10, 15][seed % 3] });
    let restored = null;
    const steps = 3 + (seed % 25);
    // play both the same way; part-way through, save one and continue from the restored copy
    let a = m, b = twin, n = 0;
    while (!a.over) {
      const ga = a.game && !a.game.over ? a.game : a.newRound();
      const gb = b.game && !b.game.over ? b.game : b.newRound();
      while (!ga.over) {
        ga.botTurn(); gb.botTurn(); n++;
        if (n === steps && !restored) {
          restored = loadMatch(JSON.parse(JSON.stringify(saveMatch(a))));
          assert.ok(restored, 'snapshot loads');
          a = restored;
          checked++;
          break;
        }
      }
      if (a !== m && a.game && !a.game.over) continue;   // keep playing the restored copy's round
      if (a.game?.over) a.finishRound();
      if (b.game?.over) b.finishRound();
    }
    while (!b.over) { const gb = b.game && !b.game.over ? b.game : b.newRound(); while (!gb.over) gb.botTurn(); b.finishRound(); }
    assert.deepEqual(a.scores, b.scores, `seed ${seed}: restored game diverged`);
    assert.deepEqual(a.winners, b.winners);
  }
  assert.equal(loadMatch({ v: 999 }), null);
  console.log(`ok - save/restore: ${checked} games resumed from a snapshot and finished exactly like an unbroken twin`);
}

// ---- Salami: a showdown called before anyone has thrown ----
import { SALAMI_BONUS } from '../js/game.js';
{
  const opening = (hands, caller) => {
    const g = new DumbalGame({ numPlayers: 3, rng: new Rng(1), callLimit: 5 });
    g.hands = hands; g.phase = OPENING; g.current = g.players.indexOf(caller);
    return g.call(caller);
  };
  let r = opening({ [HUMAN]: ['A♠', '2♠', '3♦', '4♣'], Bot1: ['K♠', 'Q♦'], Bot2: ['9♣', '8♥'] }, HUMAN);
  assert.ok(r.salami && !r.caught); assert.deepEqual(r.winners, [HUMAN]);
  assert.deepEqual(r.points, { [HUMAN]: 0, Bot1: 25 + SALAMI_BONUS, Bot2: 17 + SALAMI_BONUS });
  r = opening({ [HUMAN]: ['K♠', 'A♦'], Bot1: ['3♠', '4♦'], Bot2: ['9♣', '8♥'] }, HUMAN);
  assert.ok(r.salami && r.caught); assert.deepEqual(r.winners, ['Bot1']);
  assert.deepEqual(r.points, { [HUMAN]: 14 + 25, Bot1: 0, Bot2: 17 });
  const g = new DumbalGame({ numPlayers: 3, rng: new Rng(1), callLimit: 15, opening: false });
  g.hands = { [HUMAN]: ['A♠', '2♠'], Bot1: ['K♠'], Bot2: ['9♣', '8♥'] };
  r = g.call(HUMAN);
  assert.ok(!r.salami); assert.deepEqual(r.points, { [HUMAN]: 0, Bot1: 13, Bot2: 17 });
  console.log('ok - Salami: +10 to the others when not caught, normal scoring when caught, none mid-game');
}

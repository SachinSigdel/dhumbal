// Dumbal game rules, with no input/output so any interface can drive it.
// A port of game.py: same rules, same behaviour, same bot strategy.
//
// Game modes (see Match): a Quick game is one round; Race to 100 plays rounds until one player
// is left (round winner scores 0, others add their hand, a caught caller adds 25 on top;
// reaching 100 knocks you out). The player after each round's winner starts the next round.
//
// A round: an opening call, "Salami" (before anyone throws, anyone with 15 or less may call;
// if not caught, everyone else scores their hand + 10), then
// turns of: optionally call (at or under the call limit), throw a card (its double/triple/
// quadruple or sequence goes with it, unless thrown alone; a joker can be played with it as
// a wild card), then pick the top deck card or any one card the previous player threw
// (floor picks unlock after your first double or sequence). If the deck runs out the floor is
// shuffled in once; if it runs out again the round ends with no winner.

import {
  Rng, autoGroup, cardValue, handTotal, isJoker, isValidThrow, jokerGroup,
  longestRunWith, newDeck, orderThrow, rank,
} from './cards.js';

export const CALL_LIMITS = [5, 10, 15];
export const DEFAULT_CALL_LIMIT = 5;
export const OPENING_CALL_LIMIT = 15;
export const CAUGHT_PENALTY = 25;
export const SALAMI_BONUS = 10;   // an uncaught Salami (opening call) adds this to everyone else's hand
export const BOT_OPENING_CALL = 10;
export const MAX_TURNS = 300;
export const HAND_SIZE = 5;
export const HUMAN = 'You';
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
export const OPENING = 'opening', THROW = 'throw', PICK = 'pick';
export const QUICK = 'quick', RACE = 'race';
export const RACE_LIMIT = 100;

export const unlocksFloorPick = (thrown) => thrown.length >= 2;

// ----- bot strategy -----
export const KEEP_SEQUENCES_ABOVE = 25;
export const JOKER_COST = 3;
export const FIRST_UNLOCK_BONUS = 12;

/** Lexicographic comparison of number/boolean arrays, like Python tuples. */
const tupleGreater = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]), y = Number(b[i]);
    if (x !== y) return x > y;
  }
  return false;
};

/** How much a hand is worth keeping for its unfinished sequences (two in a row of one suit). */
export function unfinishedSequenceBonus(cards) {
  let bonus = 0;
  for (const card of cards) {
    if (isJoker(card)) continue;
    const run = longestRunWith(cards, card);
    if (run.length === 2 && run[0] === card) bonus += handTotal(run) / 2 + 3;
  }
  return bonus;
}

/** Pick {card, alone, joker} for a bot (see game.py's choose_bot_throw). */
export function chooseBotThrow(hand, unlocked = true) {
  const joker = hand.find(isJoker) ?? null;
  const keepSequences = handTotal(hand) > KEEP_SEQUENCES_ABOVE && joker === null;
  let best = null, bestKey = null;
  for (const card of hand) {
    const group = autoGroup(hand, card);
    const choices = [[false, null, group]];
    if (group.length > 1) choices.push([true, null, [card]]);
    if (joker !== null && !isJoker(card)) {
      const withJoker = jokerGroup(hand, card, joker);
      if (withJoker.length >= 3 || !unlocked) choices.push([false, joker, withJoker]);
    }
    for (const [alone, useJoker, thrown] of choices) {
      const left = hand.filter((c) => !thrown.includes(c));
      let score = handTotal(thrown) + (keepSequences ? unfinishedSequenceBonus(left) : 0);
      if (useJoker) score -= JOKER_COST;
      if (!unlocked && thrown.length >= 2) score += FIRST_UNLOCK_BONUS;
      const key = [score, thrown.length];
      if (bestKey === null || tupleGreater(key, bestKey)) {
        best = { card, alone, joker: useJoker };
        bestKey = key;
      }
    }
  }
  return best;
}

export const seatNames = (n) => [HUMAN, ...Array.from({ length: n - 1 }, (_, i) => `Bot${i + 1}`)];

export class GameError extends Error {}

const mod = (a, n) => ((a % n) + n) % n;

/** One round. */
export class DumbalGame {
  constructor({ numPlayers = 5, jokers = 1, rng = new Rng(), names = null, first = 0,
    callLimit = DEFAULT_CALL_LIMIT, opening = true } = {}) {
    if (names) numPlayers = names.length;
    if (numPlayers < 1 || numPlayers > MAX_PLAYERS || (!names && numPlayers < MIN_PLAYERS)) {
      throw new Error(`Players must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.`);
    }
    if (jokers !== 1 && jokers !== 2) throw new Error('Jokers must be 1 or 2.');
    this.numPlayers = numPlayers;
    this.jokers = jokers;
    this.callLimit = callLimit;
    this.rng = rng;
    this.players = names ? [...names] : seatNames(numPlayers);
    this.deck = newDeck(rng, jokers);
    this.floor = [];
    this.hands = Object.fromEntries(this.players.map((p) => [p, []]));
    for (let i = 0; i < HAND_SIZE; i++) for (const p of this.players) this.hands[p].push(this.deck.shift());
    this.lastThrow = Object.fromEntries(this.players.map((p) => [p, []]));
    this.first = first;
    this.current = first;
    this.pickables = [];
    this.floorUnlocked = new Set();
    this.reshuffles = 0;
    this.turns = 0;
    this.result = null;
    this.phase = opening ? OPENING : THROW;
    this.openingOffered = 0;
    this.nextOpener();
  }

  // ----- state helpers -----
  get over() { return this.result !== null; }
  get currentPlayer() { return this.players[this.current]; }
  previousPlayer(name) { return this.players[mod(this.players.indexOf(name) - 1, this.numPlayers)]; }
  total(name) { return handTotal(this.hands[name]); }
  turnOrder() { return [...this.players.slice(this.first), ...this.players.slice(0, this.first)]; }

  /** Floor cards `name` could take: any one card the player before them threw (still on the floor). */
  availablePicks(name = this.currentPlayer) {
    return this.lastThrow[this.previousPlayer(name)].filter((c) => this.floor.includes(c));
  }
  availablePick(name = this.currentPlayer) {
    const picks = this.availablePicks(name);
    return picks.length ? picks[picks.length - 1] : null;
  }
  get pickable() { return this.pickables.length ? this.pickables[this.pickables.length - 1] : null; }

  limitNow() { return this.phase === OPENING ? OPENING_CALL_LIMIT : this.callLimit; }
  canCall(name) {
    return !this.over && this.currentPlayer === name && (this.phase === OPENING || this.phase === THROW)
      && this.total(name) <= this.limitNow();
  }
  require(name, ...phases) {
    if (this.over) throw new GameError('The round is over.');
    if (this.currentPlayer !== name) throw new GameError(`It is ${this.currentPlayer}'s turn.`);
    if (!phases.includes(this.phase)) throw new GameError(`You can't do that now (expected ${this.phase}).`);
  }

  // ----- opening call -----
  nextOpener() {
    while (this.phase === OPENING) {
      if (this.openingOffered >= this.numPlayers) {
        this.phase = THROW;
        this.current = this.first;
        return;
      }
      if (this.total(this.currentPlayer) <= OPENING_CALL_LIMIT) return;
      this.openingOffered += 1;
      this.current = (this.current + 1) % this.numPlayers;
    }
  }
  passOpening(name) {
    this.require(name, OPENING);
    this.openingOffered += 1;
    this.current = (this.current + 1) % this.numPlayers;
    this.nextOpener();
  }

  // ----- turn actions -----
  throw(name, card, { alone = false, joker = null } = {}) {
    this.require(name, THROW);
    const hand = this.hands[name];
    if (!hand.includes(card)) throw new GameError('That card is not in your hand.');
    let cards;
    if (joker !== null) {
      if (!hand.includes(joker) || !isJoker(joker) || joker === card) {
        throw new GameError('Pick a joker from your hand to play with that card.');
      }
      cards = jokerGroup(hand, card, joker);
    } else {
      cards = alone ? [card] : autoGroup(hand, card);
    }
    if (!isValidThrow(cards)) throw new GameError("Those cards can't be thrown together.");
    if (unlocksFloorPick(cards)) this.floorUnlocked.add(name);
    this.pickables = this.floorUnlocked.has(name) ? this.availablePicks(name) : [];
    const thrown = orderThrow(cards);
    for (const c of thrown) hand.splice(hand.indexOf(c), 1);
    this.floor.push(...thrown);
    this.lastThrow[name] = thrown;
    this.phase = PICK;
    return thrown;
  }

  pick(name, fromFloor, card = null) {
    this.require(name, PICK);
    let recreated = false;
    if (fromFloor) {
      if (!this.pickables.length) {
        if (this.availablePicks(name).length) {
          throw new GameError('You can only pick from the floor once you have thrown a double or a sequence.');
        }
        throw new GameError('There is no card on the floor to pick.');
      }
      card = card ?? this.pickables[this.pickables.length - 1];
      if (!this.pickables.includes(card)) throw new GameError("You can't take that card from the floor.");
      this.floor.splice(this.floor.indexOf(card), 1);
    } else {
      if (!this.deck.length && this.reshuffles === 0) {
        const keep = this.floor.filter((c) => this.lastThrow[name].includes(c));
        this.deck = this.floor.filter((c) => !keep.includes(c));
        this.floor = keep;
        this.rng.shuffle(this.deck);
        this.reshuffles += 1;
        recreated = true;
      }
      if (!this.deck.length) {
        this.deckOut();
        return { card: null, fromFloor: false, deckRecreated: recreated, roundOver: true };
      }
      card = this.deck.shift();
    }
    this.hands[name].push(card);
    this.pickables = [];
    this.current = (this.current + 1) % this.numPlayers;
    this.phase = THROW;
    this.turns += 1;
    if (this.turns >= MAX_TURNS) {
      this.deckOut();
      return { card, fromFloor, deckRecreated: recreated, roundOver: true };
    }
    return { card, fromFloor, deckRecreated: recreated, roundOver: false };
  }

  deckOut() {
    const totals = Object.fromEntries(this.players.map((p) => [p, this.total(p)]));
    this.result = {
      caller: null, totals, hands: this.snapshotHands(), winners: [], caught: false,
      points: { ...totals }, tiebreak: null, deckOut: true, salami: false,
    };
  }

  snapshotHands() { return Object.fromEntries(this.players.map((p) => [p, [...this.hands[p]]])); }

  call(name) {
    this.require(name, OPENING, THROW);
    if (this.total(name) > this.limitNow()) {
      throw new GameError(`Not eligible: your total must be ${this.limitNow()} or less.`);
    }
    const salami = this.phase === OPENING;   // called before anyone threw
    const totals = Object.fromEntries(this.players.map((p) => [p, this.total(p)]));
    const catchers = this.players.filter((p) => p !== name && totals[p] <= totals[name]);
    let tiebreak = null, winners;
    if (catchers.length) {
      const order = this.turnOrder();
      const lowest = Math.min(...catchers.map((p) => totals[p]));
      const tied = catchers.filter((p) => totals[p] === lowest);
      let winner = tied[0];
      for (const p of tied.slice(1)) {
        if (tupleGreater([this.hands[winner].length, order.indexOf(winner)],
          [this.hands[p].length, order.indexOf(p)])) winner = p;
      }
      if (tied.length > 1) {
        const fewest = Math.min(...tied.map((p) => this.hands[p].length));
        tiebreak = tied.filter((p) => this.hands[p].length === fewest).length === 1 ? 'fewer cards' : 'turn order';
      }
      winners = [winner];
    } else {
      winners = [name];
    }
    const points = {};
    for (const p of this.players) {
      if (winners.includes(p)) points[p] = 0;
      else if (p === name) points[p] = totals[p] + CAUGHT_PENALTY;
      else if (salami && !catchers.length) points[p] = totals[p] + SALAMI_BONUS;   // an uncaught Salami
      else points[p] = totals[p];
    }
    this.result = {
      caller: name, totals, hands: this.snapshotHands(), winners, caught: catchers.length > 0,
      points, tiebreak, deckOut: false, salami,
    };
    return this.result;
  }

  static throwOptions(hand) { return Object.fromEntries(hand.map((c) => [c, autoGroup(hand, c)])); }

  // ----- bots -----
  botTurn() {
    const name = this.currentPlayer;
    const turn = { name, thrown: null, pick: null, showdown: null, passed: false };
    if (this.phase === OPENING) {
      if (this.total(name) <= BOT_OPENING_CALL) turn.showdown = this.call(name);
      else { this.passOpening(name); turn.passed = true; }
      return turn;
    }
    if (this.canCall(name)) { turn.showdown = this.call(name); return turn; }

    const hand = this.hands[name];
    const choice = chooseBotThrow(hand, this.floorUnlocked.has(name));
    turn.thrown = this.throw(name, choice.card, { alone: choice.alone, joker: choice.joker });

    // floor cards on offer; a plain low card only if lower than what was just thrown
    let best = null, bestKey = null;
    const shed = handTotal(turn.thrown);
    for (const offered of this.pickables) {
      const value = cardValue(offered);
      const pairsUp = hand.some((c) => rank(c) === rank(offered));
      const completesSequence = longestRunWith([...hand, offered], offered).length >= 3;
      if ((value <= 3 && value < shed) || completesSequence || (pairsUp && value <= 9)) {
        const key = [completesSequence, value <= 3, pairsUp, -value];
        if (bestKey === null || tupleGreater(key, bestKey)) { best = offered; bestKey = key; }
      }
    }
    turn.pick = this.pick(name, best !== null, best);
    if (turn.pick.roundOver) turn.showdown = this.result;
    return turn;
  }
}

/** A whole game: one round (QUICK) or rounds until one player is left (RACE). */
export class Match {
  constructor({ numPlayers = 5, jokers = 1, mode = QUICK, rng = new Rng(), callLimit = DEFAULT_CALL_LIMIT } = {}) {
    if (mode !== QUICK && mode !== RACE) throw new Error('Mode must be quick or race.');
    if (numPlayers < MIN_PLAYERS || numPlayers > MAX_PLAYERS) {
      throw new Error(`Players must be between ${MIN_PLAYERS} and ${MAX_PLAYERS}.`);
    }
    if (!CALL_LIMITS.includes(callLimit)) throw new Error(`Call limit must be one of ${CALL_LIMITS}.`);
    this.mode = mode;
    this.jokers = jokers;
    this.callLimit = callLimit;
    this.rng = rng;
    this.seats = seatNames(numPlayers);
    this.scores = Object.fromEntries(this.seats.map((p) => [p, 0]));
    this.out = [];
    this.rounds = [];
    this.starter = rng.choice(this.seats);
    this.game = null;
    this.scoredGame = null;
    this.finished = false;
    this.winners = [];
  }

  get active() { return this.seats.filter((p) => !this.out.includes(p)); }
  get over() { return this.finished; }

  newRound() {
    if (this.over) throw new GameError('The match is over.');
    if (this.game && !this.game.over) throw new GameError('The current round is still being played.');
    const names = this.active;
    this.game = new DumbalGame({
      jokers: this.jokers, rng: this.rng, names, first: names.indexOf(this.starter), callLimit: this.callLimit,
    });
    return this.game;
  }

  finishRound() {
    const game = this.game;
    if (!game || !game.over) throw new GameError("The round hasn't ended yet.");
    if (game === this.scoredGame) return this.rounds[this.rounds.length - 1];
    const result = game.result;
    const added = { ...result.points };
    const knocked = [];
    if (this.mode === RACE) {
      for (const [name, points] of Object.entries(added)) {
        this.scores[name] += points;
        if (this.scores[name] >= RACE_LIMIT) knocked.push(name);
      }
      this.out.push(...knocked);
    }
    const summary = {
      number: this.rounds.length + 1, caller: result.caller, winners: [...result.winners],
      caught: result.caught, added, knockedOut: knocked, deckOut: result.deckOut,
    };
    this.rounds.push(summary);
    this.scoredGame = game;
    const active = this.active;
    if (this.mode === QUICK) {
      this.finished = true;
      this.winners = [...result.winners];
    } else if (active.length === 1) {
      this.finished = true;
      this.winners = active;
    } else if (!active.length) {
      const best = Math.min(...knocked.map((p) => this.scores[p]));
      this.finished = true;
      this.winners = knocked.filter((p) => this.scores[p] === best);
    } else {
      // the player after the round winner starts the next round (skipping anyone who is out);
      // with no winner (deck ran out), the player after this round's starter does
      const anchor = result.winners.length ? result.winners[0] : this.starter;
      const i = this.seats.indexOf(anchor);
      for (let step = 1; step <= this.seats.length; step++) {
        const candidate = this.seats[(i + step) % this.seats.length];
        if (!this.out.includes(candidate)) { this.starter = candidate; break; }
      }
    }
    return summary;
  }
}

// ----- saving and restoring a match (the popup is destroyed whenever it closes) -----
export const SAVE_VERSION = 1;

/** A plain-JSON snapshot of a match, including the round in progress and the random state. */
export function saveMatch(m) {
  const g = m.game;
  return {
    v: SAVE_VERSION,
    mode: m.mode, jokers: m.jokers, callLimit: m.callLimit, rng: m.rng.state,
    seats: m.seats, scores: m.scores, out: m.out, rounds: m.rounds, starter: m.starter,
    finished: m.finished, winners: m.winners, scored: !!g && m.scoredGame === g,
    game: g && {
      numPlayers: g.numPlayers, jokers: g.jokers, callLimit: g.callLimit, players: g.players,
      deck: g.deck, floor: g.floor, hands: g.hands, lastThrow: g.lastThrow, first: g.first,
      current: g.current, pickables: g.pickables, floorUnlocked: [...g.floorUnlocked],
      reshuffles: g.reshuffles, turns: g.turns, result: g.result, phase: g.phase,
      openingOffered: g.openingOffered,
    },
  };
}

/** Rebuild a match saved with saveMatch (null if the snapshot is unusable). */
export function loadMatch(data) {
  if (!data || data.v !== SAVE_VERSION) return null;
  const copy = JSON.parse(JSON.stringify(data));
  const rng = new Rng(0);
  rng.state = copy.rng >>> 0;
  const m = Object.create(Match.prototype);
  Object.assign(m, {
    mode: copy.mode, jokers: copy.jokers, callLimit: copy.callLimit, rng, seats: copy.seats,
    scores: copy.scores, out: copy.out, rounds: copy.rounds, starter: copy.starter,
    finished: copy.finished, winners: copy.winners, game: null, scoredGame: null,
  });
  if (copy.game) {
    const g = Object.create(DumbalGame.prototype);
    Object.assign(g, copy.game, { rng, floorUnlocked: new Set(copy.game.floorUnlocked) });
    m.game = g;
    if (copy.scored) m.scoredGame = g;
  }
  return m;
}

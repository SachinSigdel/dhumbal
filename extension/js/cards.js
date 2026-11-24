// Cards, deck creation, hand values and which groups of cards can be thrown together.
// A port of cards.py: same rules, same names (in camelCase).

export const SUITS = ['♦', '♥', '♣', '♠'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const RED_SUITS = ['♦', '♥'];
export const JOKER_RANK = 'JK';
export const MIN_RUN = 3;
export const ACE_HIGH = 14; // in a sequence an ace can also sit above the king (Q-K-A); it still scores 1

// A is 1, number cards are face value, J/Q/K are 11/12/13, jokers are 0
export const RANK_VALUES = Object.fromEntries(RANKS.map((r, i) => [r, i + 1]));
RANK_VALUES[JOKER_RANK] = 0;

/** Small seeded random number generator (mulberry32), so games and tests can be replayed. */
export class Rng {
  constructor(seed) {
    if (seed === undefined) {
      seed = (globalThis.crypto?.getRandomValues?.(new Uint32Array(1))[0]) ?? Math.floor(Math.random() * 2 ** 32);
    }
    this.state = seed >>> 0;
  }
  random() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
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

/** A shuffled deck of 52 cards plus jokers. Cards look like 'A♦' or '10♠'; jokers are 'JK1', 'JK2'. */
export function newDeck(rng = new Rng(), jokers = 1) {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = 0; i < jokers; i++) deck.push(`${JOKER_RANK}${i + 1}`);
  return rng.shuffle(deck);
}

export const isJoker = (card) => card.startsWith(JOKER_RANK);
export const rank = (card) => (isJoker(card) ? JOKER_RANK : card.slice(0, -1));
export const suit = (card) => (isJoker(card) ? '' : card.slice(-1));
export const isRed = (card) => RED_SUITS.includes(suit(card));
export const cardValue = (card) => RANK_VALUES[rank(card)];
/** How a card is shown to people. */
export const cardText = (card) => (isJoker(card) ? 'JOKER' : card);
export const handTotal = (cards) => cards.reduce((sum, c) => sum + cardValue(c), 0);

/** One card, or a double/triple/quadruple: cards of one rank. A joker can stand in as another
 *  card of that rank (7♠ + joker is a double), and two jokers are a double. */
export function isSet(cards) {
  const ranks = new Set(cards.filter((c) => !isJoker(c)).map(rank));
  return cards.length >= 1 && ranks.size <= 1;
}

/** Position of a card in a sequence: A is 1 (A-2-3), or 14 when it sits above K (Q-K-A). */
export function seqValue(card, aceHigh = false) {
  const v = cardValue(card);
  return aceHigh && v === 1 ? ACE_HIGH : v;
}

export const rankAt = (value) => (value === 1 || value === ACE_HIGH ? 'A' : RANKS[value - 1]);

const range = (lo, hi) => Array.from({ length: Math.max(0, hi - lo + 1) }, (_, i) => lo + i);

/** If `cards` form a sequence: {values, aceHigh} (the position each place stands for, low to high).
 *  Otherwise null. 3+ consecutive cards of one suit; A low (A-2-3) or high (Q-K-A), no wrap-around
 *  (K-A-2). Jokers fill missing places, in a gap or at an end, if at least two real cards are in it. */
export function runLayout(cards) {
  const naturals = cards.filter((c) => !isJoker(c));
  const jokers = cards.length - naturals.length;
  if (cards.length < MIN_RUN || naturals.length < 2 || new Set(naturals.map(suit)).size !== 1) return null;
  const hasAce = naturals.some((c) => cardValue(c) === 1);
  for (const aceHigh of hasAce ? [false, true] : [false]) {
    const values = naturals.map((c) => seqValue(c, aceHigh)).sort((a, b) => a - b);
    if (new Set(values).size !== values.length) return null;
    const gaps = values[values.length - 1] - values[0] + 1 - values.length;
    if (gaps > jokers) continue;
    const spare = jokers - gaps;
    // spare jokers extend the top first (8♠ 9♠ + joker = 8-9-10; Q♠ K♠ + joker = Q-K-A),
    // and the bottom only when there is no room above
    const high = Math.min(ACE_HIGH, values[values.length - 1] + spare);
    const low = high - cards.length + 1;
    if (low < 1 || (hasAce && !aceHigh && high === ACE_HIGH)) continue;
    return { values: range(low, high), aceHigh };
  }
  return null;
}

export const isRun = (cards) => runLayout(cards) !== null;
export const isValidThrow = (cards) => isSet(cards) || isRun(cards);

/** Cards of `card`'s suit by sequence position; an ace is at both 1 and 14. */
export function suitPositions(hand, card) {
  const byValue = new Map();
  for (const c of hand) {
    if (!isJoker(c) && suit(c) === suit(card)) {
      byValue.set(cardValue(c), c);
      if (cardValue(c) === 1) byValue.set(ACE_HIGH, c);
    }
  }
  return byValue;
}

/** The longest same-suit sequence in `hand` containing `card` (may be shorter than a run).
 *  An ace can be at either end (A-2-3 or Q-K-A), never in the middle (K-A-2). */
export function longestRunWith(hand, card) {
  if (isJoker(card)) return [card];
  const byValue = suitPositions(hand, card);
  let best = [];
  for (const start of cardValue(card) === 1 ? [1, ACE_HIGH] : [cardValue(card)]) {
    let low = start, high = start;
    while (low - 1 >= 1 && byValue.has(low - 1)) low--;
    while (high + 1 <= ACE_HIGH && byValue.has(high + 1)) high++;
    const run = range(low, high).map((v) => byValue.get(v));
    if (new Set(run).size === run.length && run.length > best.length) best = run;
  }
  return best;
}

// compare (length, points) keys like Python tuples
const groupKey = (g) => [g.length, handTotal(g)];
const keyGreater = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1];
function biggestGroup(groups) {
  let best = groups[0];
  for (const g of groups.slice(1)) if (keyGreater(groupKey(g), groupKey(best))) best = g;
  return best;
}

/** Everything that goes to the floor when `card` is thrown: its double/triple/quadruple or its
 *  sequence (the bigger group if both: more cards, then more points), otherwise just the card. */
export function autoGroup(hand, card) {
  const sameRank = hand.filter((c) => rank(c) === rank(card));
  const run = longestRunWith(hand, card);
  const options = [sameRank, run].filter((g) => g.length >= 2 && isValidThrow(g));
  return options.length ? biggestGroup(options) : [card];
}

/** What goes to the floor when `card` is thrown together with `joker`: the joker completes a
 *  sequence with `card` (gap or end) or makes a double/triple with its rank; bigger group wins.
 *  One joker thrown with the other joker is a double of jokers. */
export function jokerGroup(hand, card, joker) {
  if (isJoker(card)) return [joker, card];
  const sameRank = [...hand.filter((c) => !isJoker(c) && rank(c) === rank(card)), joker];
  let bestRun = [];
  const byValue = suitPositions(hand, card);
  for (const v of cardValue(card) === 1 ? [1, ACE_HIGH] : [cardValue(card)]) {
    for (let low = 1; low <= v; low++) {
      for (let high = Math.max(v, low + MIN_RUN - 1); high <= ACE_HIGH; high++) {
        const missing = range(low, high).filter((x) => !byValue.has(x));
        if (missing.length !== 1) continue;
        const run = range(low, high).filter((x) => byValue.has(x)).map((x) => byValue.get(x));
        if (new Set(run).size !== run.length) continue; // the same ace can't sit at both ends
        run.push(joker);
        if (isRun(run) && keyGreater(groupKey(run), groupKey(bestRun))) bestRun = run;
      }
    }
  }
  const options = [sameRank, bestRun].filter((g) => g.length && isValidThrow(g));
  return biggestGroup(options);
}

/** For a thrown group, what each joker in it stands for (e.g. {JK1: '10♠'}). */
export function jokerStandsFor(cards) {
  const jokers = cards.filter(isJoker);
  const naturals = cards.filter((c) => !isJoker(c));
  if (!jokers.length || !naturals.length) return {};
  const layout = runLayout(cards);
  const out = {};
  if (layout) {
    const have = new Set(naturals.map((c) => seqValue(c, layout.aceHigh)));
    const free = layout.values.filter((x) => !have.has(x));
    jokers.forEach((j, i) => { if (i < free.length) out[j] = rankAt(free[i]) + suit(naturals[0]); });
  } else {
    for (const j of jokers) out[j] = rank(naturals[0]);
  }
  return out;
}

/** Order a throw as it lands: a sequence low to high with each joker in its place; in a set the
 *  jokers go first, so a real card is on top. */
export function orderThrow(cards) {
  const layout = runLayout(cards);
  if (layout) {
    const naturals = new Map(cards.filter((c) => !isJoker(c)).map((c) => [seqValue(c, layout.aceHigh), c]));
    const jokers = cards.filter(isJoker);
    let j = 0;
    return layout.values.map((x) => (naturals.has(x) ? naturals.get(x) : jokers[j++]));
  }
  return [...cards.filter(isJoker), ...cards.filter((c) => !isJoker(c))];
}

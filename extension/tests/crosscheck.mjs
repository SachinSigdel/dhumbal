// Compares the JavaScript engine with the Python one on hands exported from Python.
// Usage: node tests/crosscheck.mjs path/to/xcheck.json
import { readFileSync } from 'node:fs';
import * as C from '../js/cards.js';
import { chooseBotThrow, unfinishedSequenceBonus } from '../js/game.js';

const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let bad = 0;
const check = (i, what, js, py) => {
  if (!same(js, py)) { if (bad++ < 10) console.log(`case ${i} ${what}: js=${JSON.stringify(js)} py=${JSON.stringify(py)} hand=${JSON.stringify(cases[i].hand)}`); }
};
cases.forEach((c, i) => {
  const { hand, card, joker } = c;
  check(i, 'autoGroup', C.autoGroup(hand, card), c.auto);
  if (joker) check(i, 'jokerGroup', C.jokerGroup(hand, card, joker), c.jgroup);
  check(i, 'isRun', C.isRun(hand), c.isRun);
  check(i, 'isSet', C.isSet(hand), c.isSet);
  const lay = C.runLayout(hand);
  check(i, 'runLayout', lay ? [lay.values, lay.aceHigh] : null, c.layout);
  if (c.order) check(i, 'orderThrow', C.orderThrow(hand), c.order);
  if (c.stands) check(i, 'jokerStandsFor', C.jokerStandsFor(hand), c.stands);
  check(i, 'longestRunWith', C.longestRunWith(hand, card), c.longest);
  check(i, 'bonus', unfinishedSequenceBonus(hand), c.bonus);
  const b1 = chooseBotThrow(hand, true), b2 = chooseBotThrow(hand, false);
  check(i, 'bot(unlocked)', [b1.card, b1.alone, b1.joker], c.bot[0]);
  check(i, 'bot(locked)', [b2.card, b2.alone, b2.joker], c.bot[1]);
});
console.log(`cross-check: ${cases.length} hands x 11 functions, mismatches: ${bad}`);
process.exit(bad ? 1 : 0);

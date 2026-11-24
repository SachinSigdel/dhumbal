"""Cards, deck creation, hand values and which groups of cards can be thrown together."""
from __future__ import annotations

import random

SUITS = ('♦', '♥', '♣', '♠')
RANKS = ('A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K')
RED_SUITS = ('♦', '♥')
JOKER_RANK = 'JK'

# A is 1, number cards are face value, J/Q/K are 11/12/13, jokers are 0
RANK_VALUES = {rank: i + 1 for i, rank in enumerate(RANKS)}
RANK_VALUES[JOKER_RANK] = 0

MIN_RUN = 3


def new_deck(rng: random.Random | None = None, jokers: int = 1) -> list[str]:
    """Return a shuffled deck of 52 cards plus jokers.

    Cards look like 'A♦' or '10♠'; jokers are 'JK1', 'JK2'.
    """
    deck = [rank + suit for suit in SUITS for rank in RANKS]
    deck += [f"{JOKER_RANK}{i + 1}" for i in range(jokers)]
    (rng or random).shuffle(deck)
    return deck


def is_joker(card: str) -> bool:
    return card.startswith(JOKER_RANK)


def rank(card: str) -> str:
    return JOKER_RANK if is_joker(card) else card[:-1]


def suit(card: str) -> str:
    return '' if is_joker(card) else card[-1]


def is_red(card: str) -> bool:
    return suit(card) in RED_SUITS


def card_value(card: str) -> int:
    return RANK_VALUES[rank(card)]


def card_text(card: str) -> str:
    """How a card is shown to people."""
    return "JOKER" if is_joker(card) else card


def hand_total(cards: list[str]) -> int:
    """Sum of all card values in a hand."""
    return sum(card_value(card) for card in cards)


def is_set(cards: list[str]) -> bool:
    """One card, or a double/triple/quadruple: cards of one rank. A joker can stand in as
    another card of that rank (e.g. 7♠ + joker is a double), and two jokers are a double."""
    naturals = [card for card in cards if not is_joker(card)]
    return len(cards) >= 1 and len({rank(card) for card in naturals}) <= 1


ACE_HIGH = 14   # in a sequence an ace can also sit above the king (Q-K-A); it still scores 1


def seq_value(card: str, ace_high: bool = False) -> int:
    """Position of a card in a sequence: A is 1 (A-2-3), or 14 when it sits above K (Q-K-A)."""
    value = card_value(card)
    return ACE_HIGH if ace_high and value == 1 else value


def rank_at(value: int) -> str:
    return 'A' if value in (1, ACE_HIGH) else RANKS[value - 1]


def run_layout(cards: list[str]) -> tuple[list[int], bool] | None:
    """If `cards` form a sequence: (the position each place stands for, low to high; whether
    the ace is high). Otherwise None.

    A sequence is 3+ consecutive cards of one suit. A can be low (A-2-3) or high (Q-K-A),
    but a sequence can't wrap around (K-A-2 is not one). Jokers fill missing places, in a gap
    or at an end, as long as at least two real cards are in it.
    """
    naturals = [card for card in cards if not is_joker(card)]
    jokers = len(cards) - len(naturals)
    if len(cards) < MIN_RUN or len(naturals) < 2 or len({suit(card) for card in naturals}) != 1:
        return None
    has_ace = any(card_value(card) == 1 for card in naturals)
    for ace_high in ((False, True) if has_ace else (False,)):
        values = sorted(seq_value(card, ace_high) for card in naturals)
        if len(set(values)) != len(values):
            return None
        gaps = values[-1] - values[0] + 1 - len(values)
        if gaps > jokers:
            continue
        spare = jokers - gaps
        # spare jokers extend the top first (8♠ 9♠ + joker = 8-9-10; Q♠ K♠ + joker = Q-K-A),
        # and the bottom only when there is no room above
        high = min(ACE_HIGH, values[-1] + spare)
        low = high - len(cards) + 1
        if low < 1 or (has_ace and not ace_high and high == ACE_HIGH):
            continue   # out of range, or the ace would be needed at both ends
        return list(range(low, high + 1)), ace_high
    return None


def run_values(cards: list[str]) -> list[int] | None:
    layout = run_layout(cards)
    return layout[0] if layout else None


def is_run(cards: list[str]) -> bool:
    return run_values(cards) is not None


def is_valid_throw(cards: list[str]) -> bool:
    return is_set(cards) or is_run(cards)


def suit_positions(hand: list[str], card: str) -> dict[int, str]:
    """Cards of `card`'s suit by sequence position; an ace is at both 1 and 14."""
    by_value = {}
    for c in hand:
        if not is_joker(c) and suit(c) == suit(card):
            by_value[card_value(c)] = c
            if card_value(c) == 1:
                by_value[ACE_HIGH] = c
    return by_value


def longest_run_with(hand: list[str], card: str) -> list[str]:
    """The longest same-suit sequence in `hand` that contains `card` (may be shorter than a run).
    An ace can be at either end (A-2-3 or Q-K-A), never in the middle (K-A-2)."""
    if is_joker(card):
        return [card]
    by_value = suit_positions(hand, card)
    best: list[str] = []
    for start in ((1, ACE_HIGH) if card_value(card) == 1 else (card_value(card),)):
        low = high = start
        while low - 1 >= 1 and low - 1 in by_value:
            low -= 1
        while high + 1 <= ACE_HIGH and high + 1 in by_value:
            high += 1
        run = [by_value[v] for v in range(low, high + 1)]
        if len(set(run)) == len(run) and len(run) > len(best):
            best = run
    return best


def auto_group(hand: list[str], card: str) -> list[str]:
    """Everything that goes to the floor when `card` is thrown.

    A card that is part of a double/triple/quadruple takes all cards of its rank with it;
    a card that is part of a sequence takes the whole sequence. If it is part of both,
    the bigger group wins (more cards, then more points). Otherwise it goes alone.
    """
    same_rank = [c for c in hand if rank(c) == rank(card)]
    run = longest_run_with(hand, card)
    options = [group for group in (same_rank, run) if len(group) >= 2 and is_valid_throw(group)]
    if not options:
        return [card]
    return max(options, key=lambda group: (len(group), hand_total(group)))


def joker_group(hand: list[str], card: str, joker: str) -> list[str]:
    """What goes to the floor when `card` is thrown together with `joker`.

    The joker either completes a sequence with `card` (filling a gap or an end, so
    8♠ 9♠ + joker, or 8♠ 10♠ + joker), or makes a double/triple/... with `card`'s rank.
    The bigger group wins (more cards, then more points). Throwing one joker with the
    other joker makes a double of jokers.
    """
    if is_joker(card):
        return [joker, card]
    same_rank = [c for c in hand if not is_joker(c) and rank(c) == rank(card)] + [joker]
    best_run: list[str] = []
    by_value = suit_positions(hand, card)
    for v in ((1, ACE_HIGH) if card_value(card) == 1 else (card_value(card),)):
        for low in range(1, v + 1):
            for high in range(max(v, low + MIN_RUN - 1), ACE_HIGH + 1):
                missing = [x for x in range(low, high + 1) if x not in by_value]
                if len(missing) != 1:
                    continue
                run = [by_value[x] for x in range(low, high + 1) if x in by_value]
                if len(set(run)) != len(run):
                    continue      # the same ace can't sit at both ends
                run.append(joker)
                if is_run(run) and (len(run), hand_total(run)) > (len(best_run), hand_total(best_run)):
                    best_run = run
    options = [group for group in (same_rank, best_run) if group and is_valid_throw(group)]
    return max(options, key=lambda group: (len(group), hand_total(group)))


def joker_stands_for(cards: list[str]) -> dict[str, str]:
    """For a thrown group, what each joker in it stands for (e.g. {'JK1': '10♠'})."""
    jokers = [card for card in cards if is_joker(card)]
    naturals = [card for card in cards if not is_joker(card)]
    if not jokers or not naturals:
        return {}
    layout = run_layout(cards)
    if layout is not None:
        values, ace_high = layout
        have = {seq_value(card, ace_high) for card in naturals}
        free = [x for x in values if x not in have]
        return {j: rank_at(x) + suit(naturals[0]) for j, x in zip(jokers, free)}
    return {j: rank(naturals[0]) for j in jokers}


def order_throw(cards: list[str]) -> list[str]:
    """Order a throw as it lands on the floor. A sequence is laid out low to high with each
    joker in the place it stands for; in a set the jokers go first, so a real card is on top."""
    layout = run_layout(cards)
    if layout is not None:
        values, ace_high = layout
        naturals = {seq_value(card, ace_high): card for card in cards if not is_joker(card)}
        jokers = iter(card for card in cards if is_joker(card))
        return [naturals[x] if x in naturals else next(jokers) for x in values]
    return [card for card in cards if is_joker(card)] + [card for card in cards if not is_joker(card)]

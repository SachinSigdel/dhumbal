"""Dhumbal game rules, with no input/output so any interface (CLI, GUI) can drive it.

The rules chosen at the start (game mode, players, jokers, call limit) stay the same for
the whole game and apply to every player, human or bot.

Two game modes (see Match):
  * Quick game: one round; the round winner wins.
  * Race to 100: rounds are played until one player is left. Each round the winner scores 0
    and everyone else adds their hand total to the score table (a caught caller adds
    CAUGHT_PENALTY on top); reaching 100 points knocks a player out. The last player
    standing wins. The player after each round's winner starts the next round (the first
    starter is random).

A round:
  0. Opening call ("Salami"): before anyone throws, each player in turn may call a showdown
     if their hand is OPENING_CALL_LIMIT (15) or less. Catching works as usual. If the caller
     is caught, the round scores like any other; if not, every other player scores their hand
     plus SALAMI_BONUS (10).
  Then players take turns in seat order. A turn is:
  1. Optionally call a showdown instead of playing, if your total is the call limit or less
     (5, 10 or 15, chosen at the start). Everyone reveals. If nobody has a total equal to or
     lower than the caller's, the caller wins the round. Otherwise the caller is caught:
     CAUGHT_PENALTY is added to the caller's total and the catcher with the lowest hand wins
     (tied catchers: fewest cards wins, then the first in turn order from the round's starter).
  2. Throw a card. If it is part of a double/triple/quadruple or a sequence
     (3+ consecutive cards of one suit; A can be low or high, no wrap-around) in your hand,
     the whole group is thrown with it automatically - unless you choose to throw that card
     alone (e.g. throw one 8 from a pair to keep 8-9 of spades for a sequence).
     A joker is wild when you choose to play it with a card: it can complete a sequence
     (as its 3rd, 4th or 5th card, or in a gap) or make a double with any card.
  3. Pick: the top card of the deck, or any one card thrown by the player before you.
     Taking from the floor is unlocked the first time a player throws a double
     (2+ of the same rank) or a sequence, and stays unlocked for the rest of the game.
     Picking ends your turn and play moves to the next player.
  If the deck runs out, the floor is shuffled into a new deck once. If it runs out again,
  the round ends with no winner: everyone scores their hand. (So does a round that lasts
  MAX_TURNS turns, which can only happen if players keep swapping floor cards.)
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from cards import (auto_group, card_value, hand_total, is_joker, is_valid_throw, joker_group,
                   longest_run_with, new_deck, order_throw, rank)

CALL_LIMITS = (5, 10, 15)          # call a showdown during play with this much or less
DEFAULT_CALL_LIMIT = 5
OPENING_CALL_LIMIT = 15            # before the first throw of a round, anyone this low may call
CAUGHT_PENALTY = 25                # added to a caught caller's total
SALAMI_BONUS = 10                  # a Salami that isn't caught adds this to everyone else's hand
BOT_OPENING_CALL = 10              # bots only risk an opening call with this much or less
MAX_TURNS = 300                    # a round this long ends like a deck-out (no winner)
HAND_SIZE = 5
HUMAN = "You"
MIN_PLAYERS, MAX_PLAYERS = 2, 5

# turn phases
OPENING, THROW, PICK = "opening", "throw", "pick"


def unlocks_floor_pick(thrown: list[str]) -> bool:
    """Throwing a double (2+ cards of the same rank) or a sequence unlocks floor picks for good."""
    return len(thrown) >= 2


# ----- bot strategy -----
KEEP_SEQUENCES_ABOVE = 25   # bots only hold back cards for a sequence while their total is above this
JOKER_COST = 3              # how much a bot wants to shed before spending its joker as a wild card
FIRST_UNLOCK_BONUS = 12     # extra pull towards the first double/sequence (it unlocks floor picks)


def unfinished_sequence_bonus(cards: list[str]) -> float:
    """How much a hand is worth keeping for its unfinished sequences.

    Two cards in a row of one suit (e.g. 8♠ 9♠) can become a sequence with one more card.
    A finished sequence (3+) earns nothing here, so bots throw it instead of sitting on it.
    """
    bonus = 0.0
    for card in cards:
        if is_joker(card):
            continue
        run = longest_run_with(cards, card)
        if len(run) == 2 and run[0] == card:
            bonus += hand_total(run) / 2 + 3
    return bonus


def choose_bot_throw(hand: list[str], unlocked: bool = True) -> tuple[str, bool, str | None]:
    """Pick (card, alone, joker) for a bot.

    Every card is considered thrown with its group and, when it has one, thrown alone.
    A throw scores the points it sheds, plus (while the hand is still high) a bonus for
    the unfinished sequences it leaves in hand. Playing the joker as a wild card costs
    a little, since the joker is a 0-point card worth keeping. Ties go to throwing more cards.
    """
    joker = next((c for c in hand if is_joker(c)), None)
    # holding back for a sequence only makes sense without a joker (a joker can finish it any time)
    keep_sequences = hand_total(hand) > KEEP_SEQUENCES_ABOVE and joker is None
    best, best_score = None, None
    for card in hand:
        group = auto_group(hand, card)
        choices = [(False, None, group)]
        if len(group) > 1:
            choices.append((True, None, [card]))
        if joker is not None and not is_joker(card):
            with_joker = joker_group(hand, card, joker)
            # a joker double only helps to unlock floor picks; otherwise save it for sequences
            if len(with_joker) >= 3 or not unlocked:
                choices.append((False, joker, with_joker))
        for alone, use_joker, thrown in choices:
            left = [c for c in hand if c not in thrown]
            score = hand_total(thrown) + (unfinished_sequence_bonus(left) if keep_sequences else 0)
            if use_joker:
                score -= JOKER_COST        # a joker is a 0-point card worth keeping
            if not unlocked and len(thrown) >= 2:
                score += FIRST_UNLOCK_BONUS   # a first double/sequence unlocks floor picks
            key = (score, len(thrown))
            if best_score is None or key > best_score:
                best, best_score = (card, alone, use_joker), key
    return best


def seat_names(num_players: int) -> list[str]:
    return [HUMAN] + [f"Bot{i}" for i in range(1, num_players)]


class GameError(Exception):
    """Raised when an action is not allowed right now."""


@dataclass
class ShowdownResult:
    caller: str | None              # None when the round ended because the deck ran out twice
    totals: dict[str, int]          # everyone's hand total
    hands: dict[str, list[str]]
    winners: list[str]              # the caller, or the catcher who won; empty if no winner
    caught: bool                    # someone had a total equal to or lower than the caller's
    points: dict[str, int]          # what each player scores this round: the winner 0, a caught
                                    # caller their total + CAUGHT_PENALTY, everyone else their total
    tiebreak: str | None = None     # how tied catchers were split: "fewer cards" or "turn order"
    deck_out: bool = False          # ended because the deck ran out a second time
    salami: bool = False            # called before anyone threw (an opening call)


@dataclass
class PickResult:
    card: str | None                # None when the deck ran out for good and the round ended
    from_floor: bool
    deck_recreated: bool
    round_over: bool = False


@dataclass
class BotTurn:
    name: str
    thrown: list[str] | None = None
    pick: PickResult | None = None
    showdown: ShowdownResult | None = None
    passed: bool = False            # declined the opening call


class DumbalGame:
    def __init__(self, num_players: int = 5, jokers: int = 1, rng: random.Random | None = None,
                 names: list[str] | None = None, first: int = 0, call_limit: int = DEFAULT_CALL_LIMIT,
                 opening: bool = True):
        """One round. `names` picks who plays (default: you and num_players-1 bots, in seat
        order); `first` is the index in `names` of the player who starts; `call_limit` is
        the most a hand may hold to call during play; `opening` allows the opening call."""
        if names is not None:
            num_players = len(names)
        if not 1 <= num_players <= MAX_PLAYERS or (names is None and num_players < MIN_PLAYERS):
            raise ValueError(f"Players must be between {MIN_PLAYERS} and {MAX_PLAYERS}.")
        if jokers not in (1, 2):
            raise ValueError("Jokers must be 1 or 2.")
        self.num_players = num_players
        self.jokers = jokers
        self.call_limit = call_limit
        self.rng = rng or random.Random()
        self.players: list[str] = list(names) if names else seat_names(num_players)
        self.deck: list[str] = new_deck(self.rng, jokers)
        self.floor: list[str] = []
        self.hands: dict[str, list[str]] = {name: [] for name in self.players}
        for _ in range(HAND_SIZE):
            for name in self.players:
                self.hands[name].append(self.deck.pop(0))
        self.last_throw: dict[str, list[str]] = {name: [] for name in self.players}
        self.first = first                 # who starts the round (index in players)
        self.current = first
        self.pickables: list[str] = []     # floor cards the current player may take (set on throw)
        self.floor_unlocked: set[str] = set()   # players who have thrown a double or sequence
        self.reshuffles = 0                # times the floor has been shuffled into a new deck
        self.turns = 0                     # completed turns this round
        self.result: ShowdownResult | None = None
        # opening call: each player in turn, from the starter, may call with a low enough hand
        self.phase = OPENING if opening else THROW
        self._opening_offered = 0
        self._next_opener()

    # ----- state helpers -----
    @property
    def over(self) -> bool:
        return self.result is not None

    @property
    def current_player(self) -> str:
        return self.players[self.current]

    def previous_player(self, name: str) -> str:
        return self.players[self.players.index(name) - 1]

    def total(self, name: str) -> int:
        return hand_total(self.hands[name])

    def turn_order(self) -> list[str]:
        """Players in turn order, starting with the round's first player."""
        return self.players[self.first:] + self.players[:self.first]

    def available_picks(self, name: str | None = None) -> list[str]:
        """Floor cards `name` could take: any one card the player before them threw
        (only cards still on the floor)."""
        thrown = self.last_throw[self.previous_player(name or self.current_player)]
        return [card for card in thrown if card in self.floor]

    def available_pick(self, name: str | None = None) -> str | None:
        """The last of the available floor cards (the one on top), or None."""
        picks = self.available_picks(name)
        return picks[-1] if picks else None

    @property
    def pickable(self) -> str | None:
        """The top card the current player may take from the floor, or None."""
        return self.pickables[-1] if self.pickables else None

    def limit_now(self) -> int:
        """The most a hand may hold to call right now."""
        return OPENING_CALL_LIMIT if self.phase == OPENING else self.call_limit

    def can_call(self, name: str) -> bool:
        return (not self.over and self.current_player == name and self.phase in (OPENING, THROW)
                and self.total(name) <= self.limit_now())

    def _require(self, name: str, *phases: str):
        if self.over:
            raise GameError("The round is over.")
        if self.current_player != name:
            raise GameError(f"It is {self.current_player}'s turn.")
        if self.phase not in phases:
            raise GameError(f"You can't do that now (expected {self.phase}).")

    # ----- opening call -----
    def _next_opener(self):
        """Stop at the next player who may make the opening call; once everyone has had
        the chance, normal play starts with the round's first player."""
        while self.phase == OPENING:
            if self._opening_offered >= self.num_players:
                self.phase = THROW
                self.current = self.first
                return
            if self.total(self.current_player) <= OPENING_CALL_LIMIT:
                return
            self._opening_offered += 1
            self.current = (self.current + 1) % self.num_players

    def pass_opening(self, name: str):
        """Decline the opening call."""
        self._require(name, OPENING)
        self._opening_offered += 1
        self.current = (self.current + 1) % self.num_players
        self._next_opener()

    # ----- turn actions -----
    def throw(self, name: str, card: str, alone: bool = False, joker: str | None = None) -> list[str]:
        """Throw `card`; any double/triple/quadruple or sequence it belongs to goes with it,
        unless `alone` is True, which throws just that one card. With `joker`, that joker
        is played with the card as a wild card (completing a sequence or making a double)."""
        self._require(name, THROW)
        hand = self.hands[name]
        if card not in hand:
            raise GameError("That card is not in your hand.")
        if joker is not None:
            if joker not in hand or not is_joker(joker) or joker == card:
                raise GameError("Pick a joker from your hand to play with that card.")
            cards = joker_group(hand, card, joker)
        else:
            cards = [card] if alone else auto_group(hand, card)
        if not is_valid_throw(cards):
            raise GameError("Those cards can't be thrown together.")
        # the floor card may only be picked once you have thrown a double or a sequence
        # (this turn or any earlier turn)
        if unlocks_floor_pick(cards):
            self.floor_unlocked.add(name)
        self.pickables = self.available_picks(name) if name in self.floor_unlocked else []
        thrown = order_throw(cards)
        for card in thrown:
            hand.remove(card)
        self.floor.extend(thrown)
        self.last_throw[name] = thrown
        self.phase = PICK
        return thrown

    def pick(self, name: str, from_floor: bool, card: str | None = None) -> PickResult:
        """Pick a card; this ends the turn and moves play to the next player.
        From the floor, `card` chooses which of the available cards (default: the top one).
        If the deck runs out a second time the round ends instead (no card is taken)."""
        self._require(name, PICK)
        recreated = False
        if from_floor:
            if not self.pickables:
                if self.available_picks(name):
                    raise GameError("You can only pick from the floor once you have thrown a double or a sequence.")
                raise GameError("There is no card on the floor to pick.")
            card = card or self.pickables[-1]
            if card not in self.pickables:
                raise GameError("You can't take that card from the floor.")
            self.floor.remove(card)
        else:
            if not self.deck and self.reshuffles == 0:
                # shuffle the floor back in once, keeping this player's throw for the next player
                keep = [c for c in self.floor if c in self.last_throw[name]]
                self.deck = [c for c in self.floor if c not in keep]
                self.floor = keep
                self.rng.shuffle(self.deck)
                self.reshuffles += 1
                recreated = True
            if not self.deck:
                self._deck_out()
                return PickResult(None, False, recreated, round_over=True)
            card = self.deck.pop(0)
        self.hands[name].append(card)
        self.pickables = []
        self.current = (self.current + 1) % self.num_players
        self.phase = THROW
        self.turns += 1
        if self.turns >= MAX_TURNS:
            self._deck_out()                 # safety net: a round can't go on forever
            return PickResult(card, from_floor, recreated, round_over=True)
        return PickResult(card, from_floor, recreated)

    def _deck_out(self):
        """The deck ran out a second time: everyone shows, nobody wins, all score their hand."""
        totals = {player: self.total(player) for player in self.players}
        self.result = ShowdownResult(
            caller=None, totals=totals,
            hands={player: list(cards) for player, cards in self.hands.items()},
            winners=[], caught=False, points=dict(totals), deck_out=True)

    def call(self, name: str) -> ShowdownResult:
        """Call a showdown: before the first throw (opening call, OPENING_CALL_LIMIT or less)
        or at the start of your turn (the call limit or less)."""
        self._require(name, OPENING, THROW)
        if self.total(name) > self.limit_now():
            raise GameError(f"Not eligible: your total must be {self.limit_now()} or less.")
        salami = self.phase == OPENING            # nobody has thrown yet
        totals = {player: self.total(player) for player in self.players}
        catchers = [p for p in self.players if p != name and totals[p] <= totals[name]]
        tiebreak = None
        if catchers:
            order = self.turn_order()
            lowest = min(totals[p] for p in catchers)
            tied = [p for p in catchers if totals[p] == lowest]
            winner = min(tied, key=lambda p: (len(self.hands[p]), order.index(p)))
            if len(tied) > 1:
                fewest = min(len(self.hands[p]) for p in tied)
                tiebreak = ("fewer cards" if sum(len(self.hands[p]) == fewest for p in tied) == 1
                            else "turn order")
            winners = [winner]
        else:
            winners = [name]
        points = {}
        for player in self.players:
            if player in winners:
                points[player] = 0
            elif player == name:
                points[player] = totals[player] + CAUGHT_PENALTY
            elif salami and not catchers:
                points[player] = totals[player] + SALAMI_BONUS   # an uncaught Salami
            else:
                points[player] = totals[player]
        self.result = ShowdownResult(
            caller=name,
            totals=totals,
            hands={player: list(cards) for player, cards in self.hands.items()},
            winners=winners,
            caught=bool(catchers),
            points=points,
            tiebreak=tiebreak,
            salami=salami,
        )
        return self.result

    # ----- helpers for choosing throws -----
    @staticmethod
    def throw_options(hand: list[str]) -> dict[str, list[str]]:
        """For each card in `hand`, the group that would be thrown with it."""
        return {card: auto_group(hand, card) for card in hand}

    # ----- bots -----
    def bot_turn(self) -> BotTurn:
        """Play the current player's turn as a bot, using the same rules as everyone."""
        name = self.current_player
        turn = BotTurn(name)
        if self.phase == OPENING:
            if self.total(name) <= BOT_OPENING_CALL:
                turn.showdown = self.call(name)
            else:
                self.pass_opening(name)
                turn.passed = True
            return turn
        if self.can_call(name):
            turn.showdown = self.call(name)
            return turn

        hand = self.hands[name]
        card, alone, joker = choose_bot_throw(hand, unlocked=name in self.floor_unlocked)
        turn.thrown = self.throw(name, card, alone=alone, joker=joker)

        # floor cards on offer (empty until this bot has thrown a double or a sequence);
        # take the most useful one, if any is worth taking. A plain low card is only worth
        # taking if it is lower than what was just thrown (no swapping a 3 for a 3 forever).
        best, best_key = None, None
        shed = hand_total(turn.thrown)
        for offered in self.pickables:
            value = card_value(offered)
            pairs_up = any(rank(c) == rank(offered) for c in hand)
            completes_sequence = len(longest_run_with(hand + [offered], offered)) >= 3
            if (value <= 3 and value < shed) or completes_sequence or (pairs_up and value <= 9):
                key = (completes_sequence, value <= 3, pairs_up, -value)
                if best_key is None or key > best_key:
                    best, best_key = offered, key
        turn.pick = self.pick(name, from_floor=best is not None, card=best)
        if turn.pick.round_over:
            turn.showdown = self.result
        return turn


# ----- matches: quick game or race to 100 -----
QUICK, RACE = "quick", "race"
RACE_LIMIT = 100


@dataclass
class RoundSummary:
    number: int
    caller: str | None              # None if the deck ran out twice
    winners: list[str]              # who won the round (empty: no winner)
    caught: bool                    # was the caller caught
    added: dict[str, int]           # points each player added this round (winner: 0)
    knocked_out: list[str]          # players who reached RACE_LIMIT this round
    deck_out: bool = False


class Match:
    """A whole game: one round (QUICK) or rounds until one player is left (RACE).

    Quick game: the winner of the one round wins (the caller, or the catcher who won).
    If the deck runs out twice, nobody wins.
    Race to 100: the round winner scores 0, everyone else adds their hand total (a caught
    caller adds CAUGHT_PENALTY on top; after a deck-out everyone adds their hand).
    Reaching RACE_LIMIT points knocks a player out; the last player standing wins (if all
    the players left are knocked out together, the lowest score among them wins).
    The player seated after a round's winner starts the next round (with no winner, the player
    after that round's starter); the first round's starter is random.
    """

    def __init__(self, num_players: int = 5, jokers: int = 1, mode: str = QUICK,
                 rng: random.Random | None = None, call_limit: int = DEFAULT_CALL_LIMIT):
        if mode not in (QUICK, RACE):
            raise ValueError("Mode must be quick or race.")
        if not MIN_PLAYERS <= num_players <= MAX_PLAYERS:
            raise ValueError(f"Players must be between {MIN_PLAYERS} and {MAX_PLAYERS}.")
        if call_limit not in CALL_LIMITS:
            raise ValueError(f"Call limit must be one of {CALL_LIMITS}.")
        self.mode = mode
        self.jokers = jokers
        self.call_limit = call_limit
        self.rng = rng or random.Random()
        self.seats: list[str] = seat_names(num_players)     # fixed seats around the table
        self.scores: dict[str, int] = {name: 0 for name in self.seats}
        self.out: list[str] = []                             # knocked out, in order
        self.rounds: list[RoundSummary] = []
        self.starter = self.rng.choice(self.seats)           # first round: random starter
        self.game: DumbalGame | None = None
        self._scored_game: DumbalGame | None = None
        self.finished = False
        self.winners: list[str] = []                         # empty if the match ended with no winner

    @property
    def active(self) -> list[str]:
        return [name for name in self.seats if name not in self.out]

    @property
    def over(self) -> bool:
        return self.finished

    def new_round(self) -> DumbalGame:
        if self.over:
            raise GameError("The match is over.")
        if self.game is not None and not self.game.over:
            raise GameError("The current round is still being played.")
        names = self.active
        self.game = DumbalGame(jokers=self.jokers, rng=self.rng, names=names,
                               first=names.index(self.starter), call_limit=self.call_limit)
        return self.game

    def finish_round(self) -> RoundSummary:
        """Score the round that just ended (with a showdown or a deck-out)."""
        game = self.game
        if game is None or not game.over:
            raise GameError("The round hasn't ended yet.")
        if game is self._scored_game:
            return self.rounds[-1]         # already scored (safe to call twice)
        result = game.result
        added = dict(result.points)
        knocked = []
        if self.mode == RACE:
            for name, points in added.items():
                self.scores[name] += points
                if self.scores[name] >= RACE_LIMIT:
                    knocked.append(name)
            self.out.extend(knocked)
        summary = RoundSummary(len(self.rounds) + 1, result.caller, list(result.winners),
                               result.caught, added, knocked, result.deck_out)
        self.rounds.append(summary)
        self._scored_game = game
        if self.mode == QUICK:
            self.finished = True
            self.winners = list(result.winners)
        elif len(self.active) == 1:
            self.finished = True
            self.winners = list(self.active)
        elif not self.active:
            # everyone left was knocked out in the same round: the lowest score wins
            best = min(self.scores[name] for name in knocked)
            self.finished = True
            self.winners = [name for name in knocked if self.scores[name] == best]
        else:
            # the player after the round winner starts the next round (skipping anyone who is
            # out); with no winner (deck ran out), the player after this round's starter does
            anchor = result.winners[0] if result.winners else self.starter
            i = self.seats.index(anchor)
            for step in range(1, len(self.seats) + 1):
                candidate = self.seats[(i + step) % len(self.seats)]
                if candidate not in self.out:
                    self.starter = candidate
                    break
        return summary

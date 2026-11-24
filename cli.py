"""Terminal version of Dhumbal."""
from __future__ import annotations

import time

from cards import card_text, is_joker, joker_stands_for
from game import (CALL_LIMITS, CAUGHT_PENALTY, DEFAULT_CALL_LIMIT, HUMAN, MAX_PLAYERS, MIN_PLAYERS, OPENING,
                  OPENING_CALL_LIMIT, QUICK, RACE, RACE_LIMIT, SALAMI_BONUS, DumbalGame,
                  Match, ShowdownResult)


def ask_yes_no(question: str) -> bool:
    """Keep asking until the answer is y or n, return True for y."""
    while True:
        answer = input(question).strip().lower()
        if answer in ('y', 'n'):
            return answer == 'y'
        print("Invalid input. Please type y or n.")


def ask_choice(question: str, choices: list[int], default: int) -> int:
    while True:
        answer = input(f"{question} {choices} (Enter for {default}): ").strip()
        if not answer:
            return default
        if answer.isdigit() and int(answer) in choices:
            return int(answer)
        print("Please choose one of", choices)


def ask_throw(hand: list[str]) -> tuple[str, bool, str | None]:
    """Ask for one card index; its double/triple/quadruple or sequence is thrown with it.
    Adding '!' (e.g. 2!) throws only that card; adding 'j' (e.g. 2j) plays your joker
    with it as a wild card. Returns (card, alone, joker)."""
    joker = next((c for c in hand if is_joker(c)), None)
    tip = "; add j to play your joker with it, e.g. 2j" if joker else ""
    while True:
        answer = input(f"\nCard to throw (index; add ! to throw it alone, e.g. 2!{tip}): ").strip().lower()
        alone, use_joker = answer.endswith("!"), answer.endswith("j")
        try:
            index = int(answer.rstrip("!j").strip())
        except ValueError:
            print("Please type a card index, like 0, 3! or 2j.")
            continue
        if not 0 <= index < len(hand):
            print("Invalid card!")
            continue
        if use_joker and (joker is None or hand[index] == joker):
            print("Use j with a card other than your joker.")
            continue
        return hand[index], alone, joker if use_joker else None


def fmt(cards: list[str]) -> str:
    stands = joker_stands_for(cards)
    return '  '.join(card_text(card) + (f" (as {stands[card]})" if card in stands else "")
                     for card in cards)


def show_hand(cards: list[str], total: int):
    print('-' * 50)
    print("Your hand:", '\t'.join(f"{i}:{card_text(card)}" for i, card in enumerate(cards)),
          f"\t(total {total})")
    print('-' * 50)


def show_showdown(result: ShowdownResult):
    print('\n' + '=' * 50)
    if result.deck_out:
        print("The deck ran out a second time! Everyone reveals:")
    else:
        print(f"{result.caller} called {'Salami' if result.salami else 'a showdown'}! Everyone reveals:")
    for name, cards in result.hands.items():
        marker = " <- called" if name == result.caller else ""
        print(f"  {name:<5} total {result.totals[name]:>3}:  {fmt(cards)}{marker}")
    print('=' * 50)
    if result.deck_out:
        print("Nobody wins this round; everyone scores their hand.")
        return
    caller_total = result.totals[result.caller]
    if result.caught:
        tie = f" (tie won on {result.tiebreak})" if result.tiebreak else ""
        print(f"{result.caller} got caught: {caller_total} + {CAUGHT_PENALTY} = {caller_total + CAUGHT_PENALTY}. "
              f"{' and '.join(result.winners)} had the lowest hand and won the round{tie}.")
    else:
        print(f"Nobody had {caller_total} or less: {result.caller} wins the round."
              + (f" Salami: everyone else adds +{SALAMI_BONUS}." if result.salami else ""))


def show_scores(match: Match):
    print(f"\nScores (race to {RACE_LIMIT}):")
    for name in match.seats:
        last = match.rounds[-1].added.get(name) if match.rounds else None
        note = "OUT" if name in match.out else ""
        added = f"(+{last})" if last else ""
        print(f"  {name:<5} {match.scores[name]:>4} {added:>6}  {note}")


def ask_mode() -> str:
    print(f"Game modes:\n  1. Quick game - one round, the round winner wins\n"
          f"  2. Race to {RACE_LIMIT} - round winner scores 0, others add their hand; "
          f"{RACE_LIMIT} points and you're out; last one standing wins")
    return QUICK if ask_choice("Which game?", [1, 2], 1) == 1 else RACE


def play_round(game: DumbalGame, bot_delay: float) -> ShowdownResult:
    """Play one round until it ends (a call, or the deck running out twice)."""
    while not game.over:
        if game.current_player != HUMAN:
            time.sleep(bot_delay)
            turn = game.bot_turn()
            if turn.passed:
                continue                       # a bot declined the opening call
            if turn.thrown:
                if turn.pick.card is None:
                    print(f"{turn.name} threw {fmt(turn.thrown)}.")
                else:
                    took = (f"took {card_text(turn.pick.card)} from the floor" if turn.pick.from_floor
                            else "drew from the deck")
                    print(f"{turn.name} threw {fmt(turn.thrown)} and {took}.")
                if turn.pick.deck_recreated:
                    print("Deck ran out, so the floor was shuffled into a new deck (the last time).")
            continue

        hand = game.hands[HUMAN]
        print()
        show_hand(hand, game.total(HUMAN))
        if game.phase == OPENING:
            if ask_yes_no(f"Salami: your hand is {game.total(HUMAN)} ({OPENING_CALL_LIMIT} or less). "
                          f"Call Salami now? (not caught = everyone else +{SALAMI_BONUS})(y/n)"):
                game.call(HUMAN)
            else:
                game.pass_opening(HUMAN)
            continue
        offers = game.available_picks()
        offer = offers[-1] if offers else None
        if offer:
            unlocked = HUMAN in game.floor_unlocked
            print(f"On the floor: {fmt(offers)}"
                  + ("" if unlocked else " (taking it unlocks once you throw a double or a sequence)"))
        if game.can_call(HUMAN) and ask_yes_no(f"Your total is {game.total(HUMAN)}. Call a showdown?(y/n)"):
            game.call(HUMAN)
            break

        card, alone, joker = ask_throw(hand)
        thrown = game.throw(HUMAN, card, alone=alone, joker=joker)
        print(f"You threw: {fmt(thrown)}")
        if offer and game.pickable is None:
            print("You haven't thrown a double or sequence yet, so you draw from the deck.")
        choice = None
        if len(game.pickables) > 1:
            options = "  ".join(f"{i}:{card_text(c)}" for i, c in enumerate(game.pickables))
            answer = input(f"Pick from the floor ({options}) - type its number, or n to draw from the deck: ")
            while answer.strip().lower() != "n" and not (answer.strip().isdigit()
                                                         and int(answer) < len(game.pickables)):
                answer = input("Type a number shown, or n: ")
            if answer.strip().lower() != "n":
                choice = game.pickables[int(answer)]
        elif game.pickable and ask_yes_no(f"Pick {card_text(game.pickable)} from the floor? (n draws from the deck)(y/n)"):
            choice = game.pickable
        result = game.pick(HUMAN, choice is not None, card=choice)
        if result.deck_recreated:
            print("Deck ran out, so the floor was shuffled into a new deck (the last time).")
        if result.card is not None:
            print(f"You picked: {card_text(result.card)}")
    show_showdown(game.result)
    return game.result


def main(bot_delay: float = 1.0):
    mode = ask_mode()
    players = ask_choice("How many players?", list(range(MIN_PLAYERS, MAX_PLAYERS + 1)), 5)
    jokers = ask_choice("How many jokers (worth 0)?", [1, 2], 1)
    call_limit = ask_choice("Call a showdown during play with how much or less?", list(CALL_LIMITS),
                            DEFAULT_CALL_LIMIT)
    match = Match(players, jokers, mode, call_limit=call_limit)
    print(f"\n{players} players, {jokers} joker(s). Call a showdown at the start of your turn "
          f"with {call_limit} or less (before anyone throws: {OPENING_CALL_LIMIT} or less).")

    while not match.over:
        game = match.new_round()
        if HUMAN not in game.players:
            # you're out: the bots finish the race straight away
            print("\nYou're out of the race. The bots play the rest...")
            while not match.over:
                while not game.over:
                    game.bot_turn()
                match.finish_round()
                if not match.over:
                    game = match.new_round()
            show_scores(match)
            break
        if mode == RACE:
            print(f"\n--- Round {len(match.rounds) + 1}: {game.players[game.first]} starts ---")
        play_round(game, bot_delay)
        summary = match.finish_round()
        if mode == RACE:
            if summary.deck_out:
                print("Nobody wins the round; everyone adds their hand.")
            else:
                print(f"{' and '.join(summary.winners)} scored 0; everyone else adds their hand"
                      + (f" ({summary.caller} with +{CAUGHT_PENALTY})." if summary.caught else "."))
            for name in summary.knocked_out:
                print(f"{name} reached {RACE_LIMIT} and is out!")
            show_scores(match)
    if match.winners:
        print("\nWinner: " + " and ".join(match.winners) + ("  (that's you!)" if HUMAN in match.winners else "")
              + ("" if mode == QUICK else "  - last one standing"))
    else:
        print("\nNo winner this time.")


if __name__ == "__main__":
    main()

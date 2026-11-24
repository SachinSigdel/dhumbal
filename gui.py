"""Window (tkinter) version of Dumbal, drawn as a round card table with animations."""
from __future__ import annotations

import math
import random
import time
import tkinter as tk
import tkinter.font as tkfont

from sound import Sounds
from cards import (auto_group, card_text, card_value, is_joker, is_red, joker_group,
                   joker_stands_for, order_throw)
from game import (CALL_LIMITS, CAUGHT_PENALTY, DEFAULT_CALL_LIMIT, HUMAN, MAX_PLAYERS, MIN_PLAYERS, OPENING,
                  OPENING_CALL_LIMIT, PICK, QUICK, RACE, RACE_LIMIT, SALAMI_BONUS, THROW,
                  DumbalGame, Match)

W, H = 1040, 770               # fits a 1440x900 screen with the menu bar and title bar
CX, CY = W // 2, 318            # table centre
RX, RY = 430, 220               # table radii
HAND_Y = 634                    # your hand
TOAST_Y = CY - 74               # bottom edge of action messages: middle of the board, above "DUMBAL"
BAR_Y = 744                     # status line and buttons

# colours
BG_TOP, BG_BOTTOM = "#0d2418", "#050f09"
FELT_EDGE, FELT_CENTER = "#145a2f", "#2e8a4f"
FELT_LINE = "#3c9a5c"
RIM_DARK, RIM, RIM_LIGHT, INLAY = "#2e1a0c", "#5e3a1d", "#8a5a30", "#c9a24a"
CARD_BG, CARD_EDGE = "#fffdf6", "#9a968a"
BACK, BACK_DARK = "#8c1f30", "#5e1220"
GOLD, WINNER = "#ffd34d", "#f2c14e"
RED, BLACK, JOKER = "#c62828", "#1b1b1b", "#6a1b9a"
TEXT, MUTED = "#f4f1e6", "#9fc2ab"
PANEL = "#0c1f14"
AVATAR_COLORS = ["#e57373", "#64b5f6", "#81c784", "#ba68c8"]

BIG = (72, 104)      # your hand
MID = (52, 76)       # thrown cards, deck, floor
SMALL = (30, 44)     # bots' hands

# animation timing (milliseconds)
SHUFFLE_MS = 1800
DEAL_MS, DEAL_GAP_MS = 420, 120
MOVE_MS, MOVE_GAP_MS = 560, 110
BOT_THINK_MS = 800
TOAST_MS = 2000

FONT = "Helvetica"


def pick_font(root: tk.Tk):
    """Use a rounder system font when it's installed."""
    global FONT
    families = set(tkfont.families(root))
    for name in ("Avenir Next", "Avenir", "Helvetica Neue", "Helvetica"):
        if name in families:
            FONT = name
            return


def f(size: int, weight: str = "normal"):
    return (FONT, size, weight)


def mix(c1: str, c2: str, t: float) -> str:
    """Blend two #rrggbb colours; t=0 gives c1, t=1 gives c2."""
    a = [int(c1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(c2[i:i + 2], 16) for i in (1, 3, 5)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(a, b))


def ease(t: float) -> float:
    return t * t * (3 - 2 * t)


def who(names: list[str]) -> str:
    """'You', 'Bot2', or 'Bot1 and Bot3'."""
    return " and ".join("You" if n == HUMAN else n for n in names)


def wins(names: list[str]) -> str:
    """'You win', 'Bot2 wins', 'Bot1 and Bot3 win'."""
    return who(names) + (" wins" if len(names) == 1 and names[0] != HUMAN else " win")


def describe(cards: list[str]) -> str:
    """Cards as text, with what each joker stood for, e.g. '8♠  9♠  JOKER (as 10♠)'."""
    stands = joker_stands_for(cards)
    return "  ".join(card_text(c) + (f" (as {stands[c]})" if c in stands else "") for c in cards)


def rr_points(x1, y1, x2, y2, r=8):
    return [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
            x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]


def round_rect(canvas, x1, y1, x2, y2, r=8, **kw):
    return canvas.create_polygon(rr_points(x1, y1, x2, y2, r), smooth=True, **kw)


class PillButton(tk.Label):
    """A rounded-looking button that keeps its colours on macOS."""

    def __init__(self, parent, text, command, primary=False):
        self.primary = primary
        self.colors = ((GOLD, BLACK) if primary else ("#1d3a29", TEXT))
        super().__init__(parent, text=text, font=f(13, "bold"), padx=16, pady=7,
                         bg=self.colors[0], fg=self.colors[1], cursor="hand2",
                         disabledforeground="#6d8a77")
        self.command = command
        self.bind("<Button-1>", lambda e: self.click())
        self.bind("<Enter>", lambda e: self.hover(True))
        self.bind("<Leave>", lambda e: self.hover(False))

    def click(self):
        if str(self["state"]) != "disabled":
            self.command()

    def hover(self, on):
        if str(self["state"]) != "disabled":
            self.configure(bg=mix(self.colors[0], "#ffffff", 0.18) if on else self.colors[0])

    def set_enabled(self, enabled: bool):
        self.configure(state="normal" if enabled else "disabled",
                       bg=self.colors[0] if enabled else "#14281c",
                       cursor="hand2" if enabled else "")


MODE_INFO = {
    QUICK: "One round. Whoever calls a showdown wins.",
    RACE: f"Rounds until one player is left. The caller scores 0, everyone else adds their "
          f"hand total. Reach {RACE_LIMIT} and you're out; the last one standing wins.",
}


class SetupDialog(tk.Toplevel):
    """Choose the rules for a game: mode, number of players and jokers."""

    def __init__(self, parent, players: int, jokers: int, on_start, on_cancel, mode: str = QUICK,
                 call_limit: int = DEFAULT_CALL_LIMIT):
        super().__init__(parent)
        self.title("New game")
        self.configure(bg=PANEL, padx=28, pady=22)
        self.resizable(False, False)
        self.transient(parent)
        self.on_start, self.on_cancel = on_start, on_cancel
        self.players = tk.IntVar(value=players)
        self.jokers = tk.IntVar(value=jokers)
        self.mode = tk.StringVar(value=mode)
        self.call_limit = tk.IntVar(value=call_limit)

        tk.Label(self, text="♠ ♥  Dumbal  ♦ ♣", font=f(24, "bold"), bg=PANEL, fg=GOLD).pack(anchor="w")
        tk.Label(self, text="These rules apply to every player for the whole game.",
                 font=f(12), bg=PANEL, fg=MUTED).pack(anchor="w", pady=(2, 16))

        tk.Label(self, text="Game", font=f(13, "bold"), bg=PANEL, fg=TEXT).pack(anchor="w")
        mode_info = tk.Label(self, text="", font=f(12), bg=PANEL, fg=MUTED, justify="left",
                             wraplength=360)
        self.segmented(self.mode, [(QUICK, "Quick game"), (RACE, f"Race to {RACE_LIMIT}")],
                       on_change=lambda v: mode_info.configure(text=MODE_INFO[v])).pack(anchor="w", pady=(6, 4))
        mode_info.configure(text=MODE_INFO[self.mode.get()])
        mode_info.pack(anchor="w", pady=(0, 14))
        for title, var, values in (
            ("Players (you + bots)", self.players, range(MIN_PLAYERS, MAX_PLAYERS + 1)),
            ("Jokers (worth 0 points)", self.jokers, (1, 2)),
        ):
            tk.Label(self, text=title, font=f(13, "bold"), bg=PANEL, fg=TEXT).pack(anchor="w")
            self.segmented(var, [(v, str(v)) for v in values]).pack(anchor="w", pady=(6, 16))
        tk.Label(self, text="Call a showdown during play with", font=f(13, "bold"), bg=PANEL,
                 fg=TEXT).pack(anchor="w")
        self.segmented(self.call_limit, [(v, f"{v} or less") for v in CALL_LIMITS]).pack(anchor="w", pady=(6, 4))
        tk.Label(self, text=f"Before the first throw of a round, anyone with {OPENING_CALL_LIMIT} or "
                            f"less may call Salami: if they're not caught, everyone else gets +{SALAMI_BONUS}.",
                 font=f(12), bg=PANEL, fg=MUTED, wraplength=380, justify="left").pack(anchor="w", pady=(0, 14))

        buttons = tk.Frame(self, bg=PANEL)
        buttons.pack(fill="x", pady=(4, 0))
        PillButton(buttons, "Deal", self.start, primary=True).pack(side="right")
        PillButton(buttons, "Cancel", self.cancel).pack(side="right", padx=8)
        self.protocol("WM_DELETE_WINDOW", self.cancel)
        self.bind("<Return>", lambda e: self.start())

        self.update_idletasks()
        x = parent.winfo_rootx() + (parent.winfo_width() - self.winfo_width()) // 2
        y = parent.winfo_rooty() + 180
        self.geometry(f"+{max(x, 0)}+{max(y, 0)}")
        self.grab_set()

    def segmented(self, var: tk.Variable, options, on_change=None):
        """A row of pill choices; options are (value, label) pairs."""
        row = tk.Frame(self, bg=PANEL)
        labels = {}

        def paint():
            for value, label in labels.items():
                on = var.get() == value
                label.configure(bg=GOLD if on else "#1d3a29", fg=BLACK if on else TEXT)

        def choose(value):
            var.set(value)
            paint()
            if on_change:
                on_change(value)

        for value, text in options:
            label = tk.Label(row, text=text, font=f(14, "bold"), width=max(3, len(text) + 2), pady=6,
                             cursor="hand2")
            label.pack(side="left", padx=(0, 6))
            label.bind("<Button-1>", lambda e, v=value: choose(v))
            labels[value] = label
        paint()
        return row

    def start(self):
        players, jokers, mode = self.players.get(), self.jokers.get(), self.mode.get()
        call_limit = self.call_limit.get()
        self.grab_release()
        self.destroy()
        self.on_start(players, jokers, mode, call_limit)

    def cancel(self):
        self.grab_release()
        self.destroy()
        self.on_cancel()


class DumbalApp:
    def __init__(self, root: tk.Tk, rng: random.Random | None = None,
                 bot_delay_ms: int = BOT_THINK_MS, ask_setup: bool = True, animations: bool = True,
                 sound: bool | None = None):
        self.root = root
        self.rng = rng
        self.bot_delay_ms = bot_delay_ms
        self.animations = animations
        # sound follows animations unless asked otherwise (tests run silent and instant)
        self.sounds = Sounds(enabled=animations if sound is None else sound)
        self.settings = {"players": 5, "jokers": 1, "mode": QUICK, "call_limit": DEFAULT_CALL_LIMIT}
        self.auto_finished = None          # (round you went out, rounds the bots then played)
        self.match: Match | None = None
        self.game: DumbalGame | None = None       # the round being played
        self.hidden: set[str] = set()      # cards not drawn because they are in flight
        self.animating = False
        self.shuffling = False
        self.token = 0                     # bumps on new game, stops stale animations
        self.pending_bot = None
        self.toast_msg, self.toast_alpha, self.toast_job = "", 0.0, None

        pick_font(root)
        root.title("Dumbal")
        root.configure(bg=BG_BOTTOM)
        root.resizable(False, False)
        self.canvas = tk.Canvas(root, width=W, height=H, bg=BG_BOTTOM, highlightthickness=0)
        self.canvas.pack()
        self.toast_font = tkfont.Font(family=FONT, size=13, weight="bold")

        # buttons sit on the canvas (re-placed on every redraw) so they are always on screen
        self.new_btn = PillButton(self.canvas, "New game", lambda: (self.sfx("click"), self.ask_new_game()))
        self.call_btn = PillButton(self.canvas, "Call showdown · end game", self.on_call, primary=True)
        self.next_btn = PillButton(self.canvas, "Continue to next round",
                                   lambda: (self.sfx("click"), self.start_round()), primary=True)
        self.sound_btn = PillButton(self.canvas, "", self.toggle_sound)
        self.play_on_btn = PillButton(self.canvas, "Play on", lambda: (self.sfx("click"), self.on_play_on()))
        self.update_sound_button()
        root.bind("<KeyPress-m>", lambda e: self.toggle_sound())

        self.redraw()
        if ask_setup:
            root.after(50, lambda: self.ask_new_game(first=True))
        else:
            self.start_game(self.settings["players"], self.settings["jokers"], self.settings["mode"],
                            self.settings["call_limit"])

    # ---------- sound ----------
    def sfx(self, name: str):
        self.sounds.play(name)

    def toggle_sound(self):
        self.sounds.toggle()
        self.update_sound_button()
        self.sfx("click")

    def update_sound_button(self):
        if not self.sounds.available:
            self.sound_btn.configure(text="♪ No sound")
            self.sound_btn.set_enabled(False)
        else:
            self.sound_btn.configure(text="♪ Sound on" if self.sounds.enabled else "♪ Sound off")

    # ---------- game setup ----------
    def ask_new_game(self, first: bool = False):
        def cancel():
            if self.game is None:
                self.root.destroy()   # closed the very first setup: quit
        SetupDialog(self.root, self.settings["players"], self.settings["jokers"],
                    self.start_game, cancel, mode=self.settings["mode"],
                    call_limit=self.settings["call_limit"])

    def start_game(self, players: int, jokers: int, mode: str = QUICK, call_limit: int = DEFAULT_CALL_LIMIT):
        self.settings = {"players": players, "jokers": jokers, "mode": mode, "call_limit": call_limit}
        self.match = Match(players, jokers, mode, self.rng, call_limit=call_limit)
        self.auto_finished = None
        self.call_btn.configure(text="Call showdown · end game" if mode == QUICK
                                else "Call showdown · end round")
        self.start_round()

    def start_round(self):
        """Deal a new round (the first one, or the next one in a race)."""
        match = self.match
        if match is None or match.over or (match.game is not None and not match.game.over):
            return   # nothing to start: no match, match finished, or a round is still on
        if self.pending_bot:
            self.root.after_cancel(self.pending_bot)
            self.pending_bot = None
        self.token += 1
        self.animating = self.shuffling = False
        self.game = self.match.new_round()
        # shuffle, then deal the hands card by card
        self.hidden = {card for hand in self.game.hands.values() for card in hand}
        self.toast("Shuffling the deck…")
        def deal():
            self.toast("Dealing…")
            self.deal_anim(self.after_deal)
        self.shuffle_anim(deal)

    def after_deal(self):
        self.hidden = set()
        self.redraw()
        game = self.game
        first = who([game.players[game.first]])
        if game.phase == OPENING and game.current_player == HUMAN:
            self.toast(f"Your hand is {game.total(HUMAN)}: you may call Salami before anyone throws")
        else:
            self.toast(f"{first} {'start' if first == 'You' else 'starts'}")
        self.schedule_bots()

    def end_round(self):
        """Someone called: score the round and show the result."""
        summary = self.match.finish_round()
        match = self.match
        if match.mode == RACE and HUMAN in summary.knocked_out and not match.over:
            # you're out: the bots play the rest of the race instantly, then the winner is shown
            went_out = summary.number
            while not match.over:
                game = match.new_round()
                while not game.over:
                    game.bot_turn()
                summary = match.finish_round()
            self.game = match.game
            self.auto_finished = (went_out, summary.number - went_out)
        self.toast("")                       # the result panel says it all
        self.redraw()
        # sounds: the call, a buzzer if the caller was caught, then how it went for you
        self.sfx("call")
        if summary.caught:
            self.root.after(380, lambda: self.sfx("caught"))
        match = self.match
        if match.over:
            outcome = "win" if HUMAN in match.winners else "lose"
        elif HUMAN in summary.knocked_out:
            outcome = "out"
        elif HUMAN in summary.winners:
            outcome = "win"
        elif summary.knocked_out:
            outcome = "out"
        else:
            outcome = None
        if outcome:
            self.root.after(900 if summary.caught else 650, lambda: self.sfx(outcome))

    # ---------- layout ----------
    def seat_point(self, index: int, scale: float = 1.0):
        """Where seat `index` sits; seat 0 (you) is at the bottom, play goes clockwise."""
        angle = math.radians(90 + index * 360 / len(self.match.seats))
        return CX + RX * scale * math.cos(angle), CY + RY * scale * math.sin(angle)

    def bot_seat(self, index: int):
        x, y = self.seat_point(index)
        x += (x - CX) * 0.03
        y += (y - CY) * 0.12
        return min(max(x, 105), W - 105), y

    def bot_card_pos(self, index: int, k: int, n: int, revealed: bool = False):
        x, y = self.bot_seat(index)
        step = 26 if revealed else 16
        return x - step * (n - 1) / 2 + k * step, y

    def discard_spot(self, index: int):
        """Centre of a player's thrown cards: between their seat and the middle; players in
        the top half throw a little further out, leaving room for messages above the deck."""
        _, seat_y = self.seat_point(index)
        return self.seat_point(index, 0.72 if seat_y < CY - 1 else 0.55)

    def discard_pos(self, index: int, k: int, n: int):
        x, y = self.discard_spot(index)
        return x - 24 * (n - 1) / 2 + k * 24, y

    def hand_pos(self, k: int, n: int):
        step = BIG[0] + 12
        return CX - step * (n - 1) / 2 + k * step, HAND_Y

    def deck_pos(self):
        return CX - 50, CY

    def card_pos(self, name: str, k: int, n: int):
        if name == HUMAN:
            return self.hand_pos(k, n)
        return self.bot_card_pos(self.seat_of(name), k, n)

    def seat_of(self, name: str) -> int:
        """Seats stay put for the whole match, even when players are knocked out."""
        return self.match.seats.index(name)

    def shown_throw(self, name: str) -> list[str]:
        return [card for card in self.game.last_throw[name] if card in self.game.floor]

    # ---------- animation ----------
    def animate(self, moves: list[dict], on_done):
        """Fly cards along a gentle arc. Each move: card (None = back), frm, to,
        optional delay/dur (ms), size, on_arrive."""
        if not self.animations:
            for move in moves:
                if move.get("on_arrive"):
                    move["on_arrive"]()
            on_done()
            return
        self.animating = True
        token, start = self.token, time.perf_counter()
        for move in moves:
            move.setdefault("delay", 0)
            move.setdefault("dur", MOVE_MS)
            move.setdefault("size", MID)
            move["arrived"] = False
        total = max(m["delay"] + m["dur"] for m in moves)

        def frame():
            if token != self.token:
                return
            now = (time.perf_counter() - start) * 1000
            for move in moves:
                if not move["arrived"] and now >= move["delay"] + move["dur"]:
                    move["arrived"] = True
                    if move.get("on_arrive"):
                        move["on_arrive"]()
            self.canvas.delete("anim")
            for move in moves:
                p = (now - move["delay"]) / move["dur"]
                if 0 < p < 1:
                    e = ease(p)
                    (x0, y0), (x1, y1) = move["frm"], move["to"]
                    x = x0 + (x1 - x0) * e
                    y = y0 + (y1 - y0) * e - math.sin(math.pi * p) * 26
                    self.draw_card(x, y, move["card"], move["size"], tags=("anim",))
            if now >= total:
                self.canvas.delete("anim")
                self.animating = False
                on_done()
            else:
                self.root.after(16, frame)
        frame()

    def shuffle_anim(self, on_done):
        """Riffle the deck three times in the middle of the table."""
        if not self.animations:
            self.redraw()
            on_done()
            return
        self.animating = self.shuffling = True
        self.sfx("shuffle")
        self.redraw()
        token, start = self.token, time.perf_counter()
        dx, dy = self.deck_pos()

        def frame():
            if token != self.token:
                return
            t = (time.perf_counter() - start) * 1000 / SHUFFLE_MS
            self.canvas.delete("anim")
            if t >= 1:
                self.animating = self.shuffling = False
                self.redraw()
                on_done()
                return
            riffle = t * 3
            phase, k = riffle % 1, int(riffle)
            spread = math.sin(math.pi * phase)
            for i in range(14):
                side = 1 if (i + k) % 2 else -1
                x = dx + side * spread * 52
                y = dy - i * 1.3 - spread * 10 * (1 - abs(i - 7) / 7)
                self.draw_card(x, y, None, MID, tags=("anim",))
            self.root.after(16, frame)
        frame()

    def deal_anim(self, on_done):
        game = self.game
        n = game.num_players
        moves = []
        for r in range(len(game.hands[game.players[0]])):     # you may be out of the race
            for s, name in enumerate(game.players):
                hand = game.hands[name]
                card = hand[r]
                moves.append({
                    "card": None, "frm": self.deck_pos(), "to": self.card_pos(name, r, len(hand)),
                    "delay": (r * n + s) * DEAL_GAP_MS, "dur": DEAL_MS,
                    "size": BIG if name == HUMAN else SMALL,
                    # one soft tick per round of dealing (not every card)
                    "on_arrive": (lambda card=card: self.reveal(card, tick=True)) if s == 0
                                 else (lambda card=card: self.reveal(card)),
                })
        self.animate(moves, on_done)

    def reveal(self, card: str, tick: bool = False):
        self.hidden.discard(card)
        if tick:
            self.sfx("deal")
        self.redraw()

    # ---------- toast messages ----------
    def toast(self, message: str):
        if self.toast_job:
            try:
                self.root.after_cancel(self.toast_job)
            except (ValueError, tk.TclError):
                pass
        self.toast_msg, self.toast_alpha = message, 1.0
        self.draw_toast()
        self.toast_job = self.root.after(TOAST_MS, self.fade_toast) if message else None

    def fade_toast(self):
        self.toast_alpha -= 0.1
        if self.toast_alpha <= 0:
            self.toast_msg, self.toast_job = "", None
        else:
            self.toast_job = self.root.after(35, self.fade_toast)
        self.draw_toast()

    def draw_toast(self):
        c = self.canvas
        c.delete("toast")
        if not self.toast_msg:
            return
        fade = 1 - self.toast_alpha
        under = FELT_CENTER                     # fades into the felt it sits on
        box = round_rect(c, 0, 0, 1, 1, r=14, fill=mix("#0c2a19", under, fade),
                         outline=mix(GOLD, under, fade), width=1, tags=("toast",))
        text = c.create_text(CX, TOAST_Y - 6, text=self.toast_msg, font=self.toast_font, width=560,
                             justify="center", anchor="s", fill=mix(TEXT, under, fade), tags=("toast",))
        x1, y1, x2, y2 = c.bbox(text)
        width = self.toast_font.measure(self.toast_msg)          # one line: hug the text
        if width < x2 - x1:
            x1, x2 = CX - width / 2, CX + width / 2
        c.coords(box, *rr_points(x1 - 18, y1 - 5, x2 + 18, y2 + 5, 14))

    # ---------- turn flow ----------
    def my_turn(self, phase: str | None = None) -> bool:
        game = self.game
        return (game is not None and not game.over and not self.animating
                and game.current_player == HUMAN and (phase is None or game.phase == phase))

    def joker_click(self, card: str):
        """Shift-click: play this card with your joker as a wild card
        (it completes a sequence or makes a double)."""
        if not self.my_turn(THROW) or card not in self.game.hands[HUMAN]:
            return
        joker = next((c for c in self.game.hands[HUMAN] if is_joker(c) and c != card), None)
        if joker is None:
            self.toast("Shift-click plays a card with your joker, but you have no joker for it")
            self.sfx("nope")
            return
        self.throw_card(card, joker=joker)

    def throw_card(self, card: str, alone: bool = False, joker: str | None = None):
        """Throw a card together with its double/triple/quadruple or sequence.
        alone=True (right-click) throws just that card; `joker` (Shift-click) plays
        that joker with it as a wild card."""
        if not self.my_turn(THROW) or card not in self.game.hands[HUMAN]:
            return
        if alone:
            joker = None
        hand = self.game.hands[HUMAN]
        before = {c: self.hand_pos(k, len(hand)) for k, c in enumerate(hand)}
        thrown = self.game.throw(HUMAN, card, alone=alone, joker=joker)
        self.canvas.configure(cursor="")
        self.fly_throw(HUMAN, thrown, before, self.redraw)

    def fly_throw(self, name: str, thrown: list[str], origins: dict, on_done):
        index = self.seat_of(name)
        self.hidden |= set(thrown)
        self.redraw()
        moves = [{"card": card, "frm": origins[card], "to": self.discard_pos(index, j, len(thrown)),
                  "delay": j * MOVE_GAP_MS, "on_arrive": lambda: self.sfx("throw")}   # snap on landing
                 for j, card in enumerate(thrown)]

        def done():
            self.hidden -= set(thrown)
            self.redraw()
            on_done()
        self.animate(moves, done)

    def fly_pick(self, name: str, result, origin, face_up: bool, on_done):
        """Move a picked card from the deck/floor into `name`'s hand (shuffling first if needed)."""
        hand = self.game.hands[name]
        self.hidden.add(result.card)

        def fly():
            self.redraw()
            self.sfx("pick")
            to = self.card_pos(name, len(hand) - 1, len(hand))
            card = result.card if face_up or name == HUMAN else None
            self.animate([{"card": card, "frm": origin, "to": to,
                           "size": BIG if name == HUMAN else MID}], done)

        def done():
            self.hidden.discard(result.card)
            self.redraw()
            on_done()

        if result.deck_recreated:
            self.toast("Deck ran out: shuffling the floor into a new deck…")
            self.shuffle_anim(fly)
        else:
            fly()

    def on_pick(self, from_floor: bool, card: str | None = None):
        """Click the deck, or one of the gold floor cards (any card of a thrown sequence)."""
        game = self.game
        if not self.my_turn(PICK) or (from_floor and not game.pickables):
            return
        card = card or (game.pickable if from_floor else None)
        if from_floor and card not in game.pickables:
            return
        origin = self.deck_pos()
        if from_floor:
            prev = game.previous_player(HUMAN)
            shown = self.shown_throw(prev)
            origin = self.discard_pos(self.seat_of(prev), shown.index(card), len(shown))
        result = game.pick(HUMAN, from_floor, card=card)
        after = self.end_round if result.round_over else self.schedule_bots   # picking ends your turn
        if result.card is None:              # the deck ran out a second time: round over
            after()
        else:
            self.fly_pick(HUMAN, result, origin, True, after)

    def on_call(self):
        if self.game and not self.animating and self.game.can_call(HUMAN):
            self.game.call(HUMAN)
            self.end_round()

    def on_play_on(self):
        """Decline the opening call."""
        if self.my_turn(OPENING):
            self.game.pass_opening(HUMAN)
            self.schedule_bots()

    def schedule_bots(self):
        game = self.game
        if game and not game.over and game.current_player != HUMAN:
            self.redraw()
            self.pending_bot = self.root.after(self.bot_delay_ms, self.bot_step)
        elif game and not game.over:
            self.redraw()
            self.sfx("turn")                 # your turn

    def bot_step(self):
        self.pending_bot = None
        game = self.game
        name = game.current_player
        index = self.seat_of(name)
        hand = game.hands[name]
        before = {c: self.bot_card_pos(index, k, len(hand)) for k, c in enumerate(hand)}
        prev = game.previous_player(name)
        prev_shown = self.shown_throw(prev)

        turn = game.bot_turn()
        if turn.passed:                      # declined the opening call
            self.schedule_bots()
            return
        if turn.showdown and not turn.thrown:
            self.end_round()
            return
        pick = turn.pick
        if pick.card is None:                # threw, then the deck ran out a second time
            self.fly_throw(name, turn.thrown, before, self.end_round)
            return
        if pick.from_floor:
            origin = self.discard_pos(self.seat_of(prev), prev_shown.index(pick.card), len(prev_shown))
        else:
            origin = self.deck_pos()
        took = (f"took {card_text(pick.card)} from the floor" if pick.from_floor
                else "drew from the deck")
        message = f"{name} threw {describe(turn.thrown)} and {took}"

        self.hidden.add(pick.card)            # it is in the hand already; show it on arrival
        def after_throw():
            self.fly_pick(name, pick, origin, pick.from_floor, finish)

        def finish():
            self.toast(message)
            if pick.round_over:
                self.end_round()
            else:
                self.schedule_bots()
        self.fly_throw(name, turn.thrown, before, after_throw)

    # ---------- drawing helpers ----------
    def clickable(self, tag: str, handler):
        self.canvas.tag_bind(tag, "<Button-1>", lambda e: handler())
        self.canvas.tag_bind(tag, "<Enter>", lambda e: self.canvas.configure(cursor="hand2"))
        self.canvas.tag_bind(tag, "<Leave>", lambda e: self.canvas.configure(cursor=""))

    def draw_card(self, x, y, card: str | None, size, fill=CARD_BG, outline=CARD_EDGE,
                  width=1, tags=(), face_tag: str | None = None):
        """Draw a card centred on (x, y); card=None draws a card back."""
        w, h = size
        c = self.canvas
        x1, y1, x2, y2 = x - w / 2, y - h / 2, x + w / 2, y + h / 2
        r = 7 if w > 40 else 5
        round_rect(c, x1 + 2, y1 + 4, x2 + 3, y2 + 4, r=r, fill="#06110a", outline="", tags=tags)
        if card is None:
            round_rect(c, x1, y1, x2, y2, r=r, fill=BACK, outline=BACK_DARK, width=1, tags=tags)
            inset = 3 if w < 40 else 5
            round_rect(c, x1 + inset, y1 + inset, x2 - inset, y2 - inset, r=max(r - 2, 3),
                       fill=BACK_DARK, outline=INLAY, width=1, tags=tags)
            if w >= 40:
                dw, dh = w * 0.26, h * 0.22
                c.create_polygon(x, y - dh, x + dw, y, x, y + dh, x - dw, y,
                                 fill=BACK, outline=INLAY, width=1, tags=tags)
                c.create_polygon(x, y - dh / 2.4, x + dw / 2.4, y, x, y + dh / 2.4, x - dw / 2.4, y,
                                 fill=INLAY, outline="", tags=tags)
            return
        face_tags = tuple(tags) + ((face_tag,) if face_tag else ())
        round_rect(c, x1, y1, x2, y2, r=r, fill=fill, outline=outline, width=width, tags=face_tags)
        if is_joker(card):
            c.create_text(x, y - h * 0.08, text="★", fill=JOKER,
                          font=("Helvetica", int(h * 0.36), "bold"), tags=tags)
            c.create_text(x, y + h * 0.3, text="JOKER", fill=JOKER,
                          font=("Helvetica", max(int(h * 0.12), 7), "bold"), tags=tags)
            return
        color = RED if is_red(card) else BLACK
        # corner index (stays readable when cards overlap) and a big suit in the middle
        cx = x1 + max(w * 0.22, 9)
        c.create_text(cx, y1 + h * 0.17, text=card[:-1], fill=color,
                      font=("Helvetica", int(h * 0.2), "bold"), tags=tags)
        c.create_text(cx, y1 + h * 0.37, text=card[-1], fill=color,
                      font=("Helvetica", int(h * 0.17)), tags=tags)
        c.create_text(x + w * 0.1, y + h * 0.2, text=card[-1], fill=color,
                      font=("Helvetica", int(h * 0.4)), tags=tags)

    def draw_avatar(self, x, y, initials: str, color: str, active: bool, winner: bool, r=20):
        c = self.canvas
        if active or winner:
            glow = WINNER if winner else GOLD
            for k, t in ((10, 0.8), (6, 0.6), (3, 0.3)):
                c.create_oval(x - r - k, y - r - k, x + r + k, y + r + k, fill="",
                              outline=mix(glow, BG_BOTTOM, t), width=3)
        c.create_oval(x - r, y - r, x + r, y + r, fill=color, outline=GOLD if active or winner else "#0b1a10",
                      width=3 if active or winner else 2)
        c.create_text(x, y, text=initials, fill="#10261a", font=f(12, "bold"))

    # ---------- drawing ----------
    def redraw(self):
        c = self.canvas
        c.delete("all")
        self.draw_background()
        self.draw_table()
        game = self.game
        if game is None:
            self.draw_toast()
            self.draw_bar()
            return
        result = game.result
        can_pick = self.my_turn(PICK)
        # floor cards you may take: previewed while choosing a throw, clickable after throwing
        offers = game.pickables if can_pick else (game.available_picks() if self.my_turn(THROW) else [])

        mode = "Quick game" if self.match.mode == QUICK else f"Race to {RACE_LIMIT}"
        c.create_text(22, 22, anchor="w", fill=MUTED, font=f(12),
                      text=f"{mode}  ·  {len(self.match.seats)} players  ·  {game.jokers} joker"
                           f"{'s' if game.jokers > 1 else ''} (0 pts)  ·  call at {game.call_limit} or less"
                           f" (opening call {OPENING_CALL_LIMIT})")

        # centre: deck and floor
        dx, dy = self.deck_pos()
        fx = CX + 50
        if not self.shuffling and game.deck:
            for k in range(min(4, max(len(game.deck) // 10, 1)), 0, -1):    # a little stack depth
                self.draw_card(dx + k * 1.2, dy - k * 1.6, None, MID)
            self.draw_card(dx, dy, None, MID, tags=("deck",) if can_pick else ())
        if can_pick:
            round_rect(c, dx - 31, dy - 43, dx + 31, dy + 43, r=9, outline=GOLD, width=3,
                       fill="", tags=("deck",))
            self.clickable("deck", lambda: self.on_pick(False))
        c.create_text(dx, dy + 54, text=f"Deck {len(game.deck)}", fill=MUTED, font=f(11))
        visible_floor = [card for card in game.floor if card not in self.hidden]
        if visible_floor:
            self.draw_card(fx, CY, visible_floor[-1], MID)
        else:
            round_rect(c, fx - 26, CY - 38, fx + 26, CY + 38, r=7, outline=FELT_LINE, width=2, fill="")
        c.create_text(fx, CY + 54, text=f"Floor {len(game.floor)}", fill=MUTED, font=f(11))

        # each player's last throw, between their seat and the centre
        for name in (game.players if not result else []):
            i = self.seat_of(name)
            thrown = self.shown_throw(name)
            stands = joker_stands_for(game.last_throw[name])
            for k, card in enumerate(thrown):
                if card in self.hidden:
                    continue
                if card in stands:
                    jx, jy = self.discard_pos(i, k, len(thrown))
                    c.create_text(jx, jy + 48, text=f"as {stands[card]}", fill=GOLD, font=f(10, "bold"))
                is_offer = card in offers
                tags = (f"offer{k}",) if is_offer and can_pick else ()
                x, y = self.discard_pos(i, k, len(thrown))
                self.draw_card(x, y, card, MID,
                               fill=GOLD if is_offer and can_pick else CARD_BG,
                               outline=GOLD if is_offer else CARD_EDGE,
                               width=3 if is_offer else 1, tags=tags)
                if is_offer and can_pick:
                    self.clickable(f"offer{k}", lambda card=card: self.on_pick(True, card))
            if any(card in offers for card in thrown):
                tx, ty = self.discard_spot(i)
                many = len(offers) > 1
                c.create_text(tx, ty - 52, justify="center",
                              text=("pick any one of these" if many else "you can pick this") if can_pick
                              else ("available to pick" if HUMAN in game.floor_unlocked
                                    else "pickable once you throw\na double or sequence"),
                              fill=GOLD, font=f(11, "bold"))

        for name in self.match.seats:
            if name == HUMAN:
                continue
            if name in game.players:
                self.draw_bot(self.seat_of(name), name)
            else:
                self.draw_out_seat(self.seat_of(name), name)
        self.draw_human()
        if result:
            self.draw_result()
        self.draw_toast()

        self.draw_bar()

    def draw_bar(self):
        """Status line in the middle, New game on the left, Call showdown on the right."""
        c = self.canvas
        c.create_window(20, BAR_Y, anchor="w", window=self.new_btn)
        c.create_window(20 + self.new_btn.winfo_reqwidth() + 8, BAR_Y, anchor="w", window=self.sound_btn)
        c.create_window(W - 20, BAR_Y, anchor="e", window=self.call_btn)
        self.call_btn.set_enabled(bool(self.game) and self.game.can_call(HUMAN) and not self.animating)
        opening = self.my_turn(OPENING)
        mode_label = "Call showdown · end game" if self.match is None or self.match.mode == QUICK else "Call showdown · end round"
        self.call_btn.configure(text="Call Salami" if opening else mode_label)
        if opening:
            c.create_window(W - 20 - self.call_btn.winfo_reqwidth() - 8, BAR_Y, anchor="e", window=self.play_on_btn)
        left = 20 + self.new_btn.winfo_reqwidth() + 8 + self.sound_btn.winfo_reqwidth() + 14
        right = W - 20 - self.call_btn.winfo_reqwidth() - 14 - (self.play_on_btn.winfo_reqwidth() + 8 if opening else 0)
        c.create_text((left + right) / 2, BAR_Y, text=self.status_text(), fill=GOLD, font=f(13, "bold"),
                      width=right - left, justify="center", tags=("status",))

    def draw_background(self):
        c = self.canvas
        steps = 32
        for k in range(steps):
            y1 = H * k / steps
            c.create_rectangle(0, y1, W, y1 + H / steps + 1, outline="",
                               fill=mix(BG_TOP, BG_BOTTOM, k / (steps - 1)))

    def draw_table(self):
        c = self.canvas
        # shadow, wooden rim with a gold inlay, then the felt shaded from the edge to the centre
        c.create_oval(CX - RX - 40, CY - RY - 28, CX + RX + 46, CY + RY + 52, fill="#030a06", outline="")
        c.create_oval(CX - RX - 38, CY - RY - 38, CX + RX + 38, CY + RY + 38, fill=RIM_DARK, outline="")
        c.create_oval(CX - RX - 34, CY - RY - 34, CX + RX + 34, CY + RY + 34, fill=RIM, outline=RIM_LIGHT, width=2)
        c.create_oval(CX - RX - 20, CY - RY - 20, CX + RX + 20, CY + RY + 20, fill="", outline=INLAY, width=1)
        c.create_oval(CX - RX - 8, CY - RY - 8, CX + RX + 8, CY + RY + 8, fill=RIM_DARK, outline="")
        steps = 14
        for k in range(steps):
            t = k / (steps - 1)
            s = 1 - 0.62 * t
            c.create_oval(CX - (RX + 2) * s, CY - (RY + 2) * s, CX + (RX + 2) * s, CY + (RY + 2) * s,
                          fill=mix(FELT_EDGE, FELT_CENTER, t), outline="")
        c.create_oval(CX - RX * 0.74, CY - RY * 0.74, CX + RX * 0.74, CY + RY * 0.74,
                      outline=FELT_LINE, width=1, dash=(6, 6))
        c.create_text(CX, CY - 56, text="D U M B A L", fill=mix(FELT_CENTER, "#ffffff", 0.12),
                      font=f(15, "bold"))

    def draw_bot(self, index: int, name: str):
        c = self.canvas
        game = self.game
        result = game.result
        x, y = self.bot_seat(index)
        hand = game.hands[name]
        is_turn = not result and game.current_player == name
        is_winner = bool(result and name in result.winners)

        size = MID if result else SMALL
        for k, card in enumerate(hand):
            if card in self.hidden:
                continue
            px, py = self.bot_card_pos(index, k, len(hand), revealed=bool(result))
            self.draw_card(px, py, card if result else None, size)

        color = AVATAR_COLORS[(index - 1) % len(AVATAR_COLORS)]
        if y < 140:
            # a seat at the top edge: avatar beside the cards, so it stays on screen
            half = (26 if result else 16) * (len(hand) - 1) / 2 + size[0] / 2
            self.draw_avatar(x - half - 30, y, "B" + name[-1], color, is_turn, is_winner)
        else:
            self.draw_avatar(x, y - (62 if result else 46), "B" + name[-1], color, is_turn, is_winner)
        label = name + ("  · called" if result and result.caller == name else "")
        below = y + (46 if result else 32)
        c.create_text(x, below, text=label, fill=GOLD if is_turn or is_winner else TEXT,
                      font=f(13, "bold"))
        if result:
            c.create_text(x, below + 18, text=self.result_note(name), fill=TEXT, font=f(12))
        elif is_turn:
            c.create_text(x, below + 17, text="thinking…", fill=MUTED, font=f(11))

    def result_note(self, name: str) -> str:
        """Under each revealed hand: its total, and in a race the points it adds."""
        result = self.game.result
        total = result.totals[name]
        if name == result.caller and result.caught:
            note = f"total {total} + {CAUGHT_PENALTY}"
        elif result.salami and not result.caught and name != result.caller:
            note = f"total {total} + {SALAMI_BONUS}"
        else:
            note = f"total {total}"
        if self.match.mode == RACE:
            points = result.points[name]
            note += "  ·  scores 0" if points == 0 else f"  ·  +{points}"
        return note

    def draw_out_seat(self, index: int, name: str):
        """A player knocked out of the race: an empty seat with their final score."""
        c = self.canvas
        x, y = self.bot_seat(index)
        self.draw_avatar(x, y - 46, "B" + name[-1], "#4a5a50", False, False)
        c.create_text(x, y - 6, text="OUT", fill="#c86b6b", font=f(14, "bold"))
        c.create_text(x, y + 32, text=f"{name}  ·  {self.match.scores[name]}", fill=MUTED, font=f(12, "bold"))

    def draw_human(self):
        c = self.canvas
        game = self.game
        result = game.result
        if HUMAN not in game.players:
            lx = CX - 290
            self.draw_avatar(lx, HAND_Y - 26, "You", "#4a5a50", False, False, r=24)
            c.create_text(lx, HAND_Y + 14, text=f"OUT  ·  {self.match.scores[HUMAN]}", fill="#c86b6b",
                          font=f(13, "bold"))
            c.create_text(CX + 40, HAND_Y, text="You were knocked out of the race." if self.match.over
                          else "You're out of the race. Watching the bots…", fill=MUTED, font=f(15, "bold"))
            return
        hand = game.hands[HUMAN]
        selectable = self.my_turn(THROW)
        for k, card in enumerate(hand):
            if card in self.hidden:
                continue
            tag = f"hand{k}"
            x, y = self.hand_pos(k, len(hand))
            self.draw_card(x, y, card, BIG, tags=(tag,) if selectable else (), face_tag=f"face{k}")
            if selectable:
                c.tag_bind(tag, "<Button-1>", lambda e, card=card: self.throw_card(card))
                # Shift-click: play it with your joker
                c.tag_bind(tag, "<Shift-Button-1>", lambda e, card=card: self.joker_click(card))
                # throw just this card: right-click (Button-2 on older macOS Tk, 3 elsewhere)
                # or Control-click (the Mac right-click)
                for seq in ("<Button-2>", "<Button-3>", "<Control-Button-1>"):
                    c.tag_bind(tag, seq, lambda e, card=card: self.throw_card(card, alone=True))
                c.tag_bind(tag, "<Enter>", lambda e, card=card: self.preview(card, True))
                c.tag_bind(tag, "<Leave>", lambda e, card=card: self.preview(card, False))
        c.create_text(CX, HAND_Y - BIG[1] / 2 - 36, text="", fill=GOLD, tags=("hint",), font=f(12, "bold"))

        is_turn = not result and game.current_player == HUMAN
        is_winner = bool(result and HUMAN in result.winners)
        first_x, _ = self.hand_pos(0, max(len(hand), 1))
        lx = min(first_x - BIG[0] / 2 - 80, CX - 290)
        self.draw_avatar(lx, HAND_Y - 38, "You", GOLD if is_turn else "#d9cfa8", is_turn, is_winner, r=24)
        total = sum(card_value(card) for card in hand if card not in self.hidden)   # only cards in view
        c.create_text(lx, HAND_Y + 2, text=self.result_note(HUMAN) if result else f"total {total}",
                      font=f(13, "bold"), fill=GOLD if total <= game.limit_now() else TEXT)
        lines = []
        if self.match.mode == RACE:
            lines.append((f"score {self.match.scores[HUMAN]} / {RACE_LIMIT}", MUTED))
        if not result:
            unlocked = HUMAN in game.floor_unlocked
            lines.append(("floor pick unlocked" if unlocked else "floor pick locked", GOLD if unlocked else MUTED))
        for k, (text, color) in enumerate(lines):
            c.create_text(lx, HAND_Y + 20 + 17 * k, text=text, font=f(11), fill=color)

    def preview(self, card: str, on: bool):
        """While hovering a card, outline every card that would be thrown with it."""
        if not self.my_turn(THROW):
            return
        hand = self.game.hands[HUMAN]
        group = auto_group(hand, card)
        for k, other in enumerate(hand):
            if other in group:
                self.canvas.itemconfigure(f"face{k}", outline=GOLD if on else CARD_EDGE,
                                          width=3 if on else 1)
        joker = next((c for c in hand if is_joker(c) and c != card), None)
        parts = []
        if len(group) > 1:
            parts.append(f"click: {describe(group)}")
        if joker and not is_joker(card):
            parts.append(f"shift-click: {describe(order_throw(joker_group(hand, card, joker)))}")
        if len(group) > 1:
            parts.append(f"right-click: {card_text(card)} alone")
        elif parts:
            parts.insert(0, f"click: {card_text(card)}")
        hint = "   ·   ".join(parts) if on else ""
        self.canvas.itemconfigure("hint", text=hint)
        self.canvas.configure(cursor="hand2" if on else "")

    def draw_result(self):
        """The round result in the middle of the board. In a race it holds the score table
        and a button to continue. Text wraps and the panel grows to fit it."""
        c = self.canvas
        match = self.match
        result = self.game.result
        summary = match.rounds[-1]
        caller = result.caller
        if result.deck_out:
            called = "The deck ran out a second time: everyone shows their hand"
            detail = "Nobody wins this round; everyone scores their hand"
        else:
            caller_total = result.totals[caller]
            how = "called Salami" if result.salami else "called"
            if result.caught:
                called = (f"{who([caller])} {how} with {caller_total} and got caught: "
                          f"{caller_total} + {CAUGHT_PENALTY} = {caller_total + CAUGHT_PENALTY}")
                detail = f"{who(result.winners)} had the lowest hand ({result.totals[result.winners[0]]})"
                if result.tiebreak:
                    detail += f", winning the tie on {result.tiebreak}"
            else:
                called = f"{who([caller])} {how} with {caller_total}"
                detail = (f"Nobody had an equal or lower hand, so everyone else adds +{SALAMI_BONUS}"
                          if result.salami else "Nobody had an equal or lower hand")
        if self.auto_finished and match.over:
            went_out, extra = self.auto_finished
            called = (f"You were knocked out in round {went_out}. The bots played "
                      f"{extra} more round{'s' if extra != 1 else ''} to finish the race")
            detail = "Final scores below"
        knocked = summary.knocked_out if not (self.auto_finished and match.over) else []
        if knocked:
            detail += f". {who(knocked)} reached {RACE_LIMIT} and {'are' if len(knocked) > 1 or knocked == [HUMAN] else 'is'} out"
        if match.mode == QUICK:
            headline = wins(result.winners) + "!" if result.winners else "No winner"
        elif match.over:
            headline = wins(match.winners) + " the race!"
        elif result.deck_out:
            headline = f"Round {summary.number}: no winner"
        else:
            headline = f"Round {summary.number}: {wins(result.winners)}"

        x1, x2 = CX - 215, CX + 215
        inner = x2 - x1 - 48
        shadow = round_rect(c, 0, 0, 1, 1, r=18, fill="#030a06", outline="")
        panel = round_rect(c, 0, 0, 1, 1, r=18, fill=PANEL, outline=WINNER, width=2)
        y = 0

        def line(text, font, fill, gap):
            nonlocal y
            item = c.create_text(CX, y, text=text, font=font, fill=fill, width=inner, justify="center",
                                 anchor="n", tags=("panel",))
            y = c.bbox(item)[3] + gap

        if match.mode == QUICK or match.over:
            line("♛", f(18), WINNER, 0)
        line(headline, f(20, "bold"), WINNER, 6)
        line(called, f(13), TEXT, 3)
        line(detail, f(12), "#e69a9a" if knocked else MUTED, 10)

        if match.mode == RACE:
            cols = {"name": x1 + 28, "hand": x1 + 196, "round": x1 + 286, "score": x1 + 352, "note": x1 + 366}
            def cell(key, text, fill, font=f(12, "bold"), anchor="ne"):
                c.create_text(cols[key], y, text=text, fill=fill, font=font,
                              anchor="nw" if key in ("name", "note") else anchor, tags=("panel",))
            for key, text in (("name", "Player"), ("hand", "Hand"), ("round", "This round"), ("score", "Score")):
                cell(key, text, MUTED, f(11, "bold"))
            y += 22
            c.create_line(x1 + 24, y, x2 - 24, y, fill="#2d5a3d", tags=("panel",))
            y += 6
            for name in match.seats:
                played = name in result.totals
                out_now = name in knocked
                out_before = name in match.out and not out_now
                color = "#c86b6b" if (out_now or out_before) else (WINNER if name in result.winners else TEXT)
                cell("name", who([name]), color)
                if played:
                    extra = (f"+{CAUGHT_PENALTY}" if name == caller and result.caught
                             else f"+{SALAMI_BONUS}" if result.salami and not result.caught and name != caller else "")
                    cell("hand", str(result.totals[name]) + extra, color)
                    points = summary.added[name]
                    cell("round", "0" if points == 0 else f"+{points}", color)
                cell("score", str(match.scores[name]), color)
                note = "out" if out_now or out_before else ("★" if name in match.winners or name in result.winners else "")
                cell("note", note, color, f(11, "bold"))
                y += 24
            y += 4

        if match.mode == RACE and not match.over:
            c.create_window(CX, y + 2, anchor="n", window=self.next_btn, tags=("panel",))
            y += 44
        elif match.mode == QUICK or match.over:
            line("Press New game to play again", f(11), MUTED, 4)

        height = y + 28
        # centred a little below the middle: clear of the top seats' revealed hands
        top = min(max(CY + 24 - height / 2, 96), H - 210 - height)
        c.move("panel", 0, top + 18)
        c.coords(panel, *rr_points(x1, top, x2, top + height, 18))
        c.coords(shadow, *rr_points(x1 + 3, top + 5, x2 + 3, top + height + 5, 18))

    def status_text(self) -> str:
        game = self.game
        if game is None:
            return ""
        match = self.match
        if game.over:
            if match.over:
                if not match.winners:
                    return "Game over: no winner. Press New game to play again."
                return f"Game over: {wins(match.winners)}! Press New game to play again."
            return "Round over. Press Continue to next round when you're ready."
        if self.shuffling:
            return "Shuffling…"
        if HUMAN not in game.players:
            return f"You're out. {game.current_player} is playing…"
        if game.current_player != HUMAN:
            return f"{game.current_player} is playing…"
        if self.animating:
            return ""
        if game.phase == OPENING:
            return (f"Salami: your hand is {game.total(HUMAN)} ({OPENING_CALL_LIMIT} or less). Call Salami before "
                    f"anyone throws (if you're not caught, everyone else gets +{SALAMI_BONUS}), or Play on.")
        if game.phase == PICK:
            if len(game.pickables) > 1:
                return "Pick up: click the deck, or any one of the gold cards."
            if game.pickable:
                return f"Pick up: click the deck, or the gold {card_text(game.pickable)}."
            if game.available_pick():
                return ("You haven't thrown a double or sequence yet, so you can't take "
                        "from the floor. Click the deck.")
            return "Pick up: click the deck."
        if game.can_call(HUMAN):
            ends = "the game" if match.mode == QUICK else "the round"
            return (f"Your total is {game.total(HUMAN)}: press Call showdown to end {ends}, "
                    "or keep playing by throwing a card.")
        text = "Your turn: click a card to throw it (its pair or sequence goes too). Right-click throws it alone."
        if any(is_joker(c) for c in game.hands[HUMAN]):
            text += " Shift-click a card to play it with your joker."
        return text


def main():
    root = tk.Tk()
    DumbalApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()

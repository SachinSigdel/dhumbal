# Dhumbal

A simple card game, played especially in Nepal. Play it with friends online, or against 1 to 4 bots.

> Vibe-coded the whole game. 

## Play online with friends

Online play is in the Dhumbal browser extension (Chrome, Brave or another Chromium browser).
Everyone at the table needs it installed: until it's on the Chrome Web Store, install it from
this repository (see [Install the extension](#install-the-extension)).

**Start a table (the host)**

1. Click the Dhumbal icon in your browser's toolbar. If a game is already showing, press
   **New game**.
2. Under **Play against**, choose **Friends online**.
3. Type your name: it's what the others see at the table.
4. Choose the rules: **Quick game** or **Race to 100**, how many players (2 to 5, you
   included), 1 or 2 jokers, and the call limit (5, 10 or 15).
5. Press **Create table**. You get a 4-letter table code, like `K7QX`.
6. Send the code to your friends (**Copy code** puts it on your clipboard), over chat or any
   way you like.
7. Watch the lobby fill up. When every seat is taken, press **Start** to deal.

**Join a table (everyone else)**

1. Click the Dhumbal icon (press **New game** if a game is showing) and choose **Friends online**.
2. Type your name, then the table code under **Join a friend's table**, and press **Join**.
3. Wait in the lobby until the host presses **Start**.

**While you play**

- You're always the player at the bottom of the table; your friends sit around it in turn
  order, with their names. On your turn, play exactly as you would against bots: click a card
  to throw it, then pick from the deck or the floor, or press **Call showdown** / **Call
  Salami**.
- Each player only ever sees their own cards. The server deals and keeps every hand, so
  nobody can peek, not even with the browser's developer tools.
- **Race to 100:** after each round the host presses **Continue to next round** (everyone else
  sees "Waiting for … to deal the next round").
- **After the game:** the host can press **Play again at this table** to take everyone back to
  the lobby with the same code. Changing the rules means creating a new table.
- **Leave table** (bottom left) leaves for good: a bot finishes your game for you.

**Tips**

- Play in the **side panel** (or, in Brave, the Dhumbal **window**): press **Open in side
  panel** / **Open in a window** at the top right of the pop-up. The toolbar pop-up closes
  whenever you click outside it, which disconnects you from the table.
- Dropped out or closed the game by accident? Just open Dhumbal again: it reconnects you to
  your table automatically and catches you up. If you're gone for more than about 10 seconds,
  a bot plays your turns until you're back (the others see "away · a bot plays for them").
- If the host leaves, the next player at the table becomes the host.
- A table nobody is connected to is deleted after a day. A code that no longer works means
  the table has expired: create a new one.

## Rules

At the start you choose the game, the number of players (2-5), jokers (1 or 2) and the call
limit (5, 10 or 15). Those rules stay the same for the whole game and apply to every
player, bots included.

**Games**
- **Quick game:** one round. The winner of the round wins (if the deck runs out twice,
  nobody wins).
- **Race to 100:** rounds are played until one player is left. Each round, the round
  winner scores 0 and everyone else adds their hand total to the score table (a caught
  caller adds 25 on top). Reaching 100
  points knocks you out; the last player standing wins. Against bots, if you are knocked out the
  bots finish the race at once and the winner is shown; online, you watch the others finish. The player seated after each round's
  winner starts the next round; the first round's starter is random.

**A round**

- Everyone gets 5 cards. A = 1, number cards are face value, J = 11, Q = 12, K = 13, joker = 0.
- **Salami (opening call):** before anyone throws, each player in turn (starting with the
  round's first player) may call a showdown if their hand is 15 or less. Catching works as
  usual; a caught Salami scores like any other round, but if the caller isn't caught, every
  other player scores their hand **plus 10**.
- Then players take turns clockwise around the table. On your turn:
  1. **Call a showdown** (only at the start of your turn, with a total at or under the call
     limit you chose: 5, 10 or 15), or
  2. **Throw** a card by clicking it. If it is part of a double, triple, quadruple or a
     sequence (3+ in a row of one suit: A-2-3, J-Q-K, Q-K-A; the ace can be low or high
     but a sequence can't wrap around, so K-A-2 is not one) in your hand, the whole group is thrown with it automatically.
     If a card belongs to both a set and a sequence, the bigger group goes.
     To throw only that one card instead (say, one 8 from a pair so you can keep 8♠ 9♠
     for a sequence), right-click it. In the terminal, add `!` to the
     index (e.g. `1!`).
     **Jokers are wild** when you choose to use one: Shift-click a card to play it with
     your joker. The joker completes a sequence (as its 3rd, 4th or 5th card, or in a gap:
     8♠ 9♠ + joker = 8-9-10, 8♠ 10♠ + joker = 8-9-10, Q♠ K♠ + joker = Q-K-A) or makes a double with any card
     (7♦ + joker), which also unlocks floor picks. In the terminal, add `j` (e.g. `2j`). Then
  3. **Pick** the top card of the deck, or **any one** card thrown by the player before you
     (from a single card, a double or triple, or a sequence, jokers included).
     Taking a floor card unlocks the first time you throw a double (2+ of the same rank)
     or a sequence, and stays unlocked for the rest of the game. Until then you must draw
     from the deck.
     Picking ends your turn.
- Calling a showdown ends the round: everyone reveals their hand. If nobody has a total equal
  to or lower than the caller's, the caller wins the round. Otherwise the caller is **caught**:
  25 is added to the caller's total (calling at 5 costs 30), and the catcher with the lowest
  hand wins the round. If catchers tie on the lowest hand, the one with fewer cards wins; if
  that ties too, the first of them in turn order from the round's first player wins.
- If the deck runs out, the floor (except the last throw) is shuffled into a new deck once.
  If it runs out again, the round ends: everyone shows, **nobody wins**, and everyone scores
  their hand. (A round that somehow lasts 300 turns ends the same way.)

## Run

```bash
python3 gui.py        # window version (tkinter)
python3 cli.py        # terminal version
python3 dhumbal.py     # terminal, or: python3 dhumbal.py --gui
```

The window version has sound effects (card snaps, a riffle shuffle, chimes for a call or a win,
a buzzer when a caller is caught). They are generated by `sound.py` and played with the
system's player (afplay on macOS); press **M** or the ♪ button to mute.

The GUI needs tkinter. On macOS with Homebrew Python: `brew install python-tk@3.15`
(use your Python version).

## Chrome extension

`extension/` is the game for Chrome, published as **Dhumbal**. It's a JavaScript port with the
same rules and bots, plus a real-looking deck (Byron Knoll's public-domain card art, see
`extension/cards/CREDITS.txt`), a navy/burgundy/gold table, animations and sounds. It opens
as a pop-up from the toolbar (like a wallet extension). Chrome closes pop-ups when you click
away, so the game saves itself and resumes where you left off. **Open in side panel** moves
the game into Chrome's side panel (a tall layout), which stays open while you browse. Brave
doesn't show extension side panels, so there the button reads **Open in a window** and opens a
slim Dhumbal window instead (also used if the side panel ever fails). The pop-up, panel and
window all share the same saved game.

### Install the extension

To install it unpacked:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `extension` folder.
3. Pin the Dhumbal icon from the puzzle-piece menu and click it.

Its only permission is `sidePanel`, and playing against bots works offline. The same files also run as a web page: serve the
folder with `python3 -m http.server --directory extension` and open
`http://localhost:8000/game.html` (add `?popup` for the 800x600 pop-up size, or `?panel` for the side panel).

### The online server

How to play online is described in [Play online with friends](#play-online-with-friends).
The server deals and keeps every hand (each player is only ever sent their own), shuffles with
cryptographic randomness, gives a dropped player 10 seconds to reconnect before a bot plays for
them, and deletes tables that have been idle for a day. It lives in `server/`: a Cloudflare Worker with one Durable Object per table, running the
same rules engine as the extension (`extension/js/game.js`). To run it yourself:

```bash
cd server && npm install
npx wrangler dev                 # local server on http://127.0.0.1:8787
npx wrangler deploy              # deploy to your Cloudflare account (after `npx wrangler login`)
```

The extension connects to the server named in `extension/js/online.js` (`DEFAULT_SERVER`).
To point one browser at a local server instead, run
`localStorage.setItem('dhumbal.server', '"http://127.0.0.1:8787"')` in the game page's console.

Tests (need Node): `node extension/tests/engine.test.mjs` runs the rule tests and a
save/resume check; `extension/tests/crosscheck.mjs` compares the JavaScript engine with the
Python one on hands exported from Python. `node server/test/room.test.mjs` plays hundreds of
online games through the room logic and checks that nobody is ever sent a card they shouldn't
see; `node server/test/live.test.mjs [server URL]` plays over real WebSockets against a running
server.

## Code layout

| File        | What it does                                              |
|-------------|-----------------------------------------------------------|
| `cards.py`  | Deck creation and card / hand values                      |
| `game.py`   | Game rules and turn flow (no input/output)                |
| `cli.py`    | Terminal interface                                        |
| `gui.py`    | tkinter window interface                                  |
| `sound.py`  | Synthesised sound effects for the window                  |
| `dhumbal.py`| Launcher                                                  |
| `extension/`| Chrome extension (Dhumbal): `js/cards.js`, `js/game.js` (engine), `js/app.js` (table), `js/online.js` (connection), `js/sound.js`, `cards/` (card art) |
| `server/`   | Online play: `src/index.js` (Worker and Durable Object), `src/room.js` (tables, lobby, hidden hands) |

# Game Night

**Five games, one link.** Play friends online with a 4-letter room code, or play solo on any phone, tablet or computer. No app, no sign-up.

**Play:** https://abhisheksava32.github.io/game-night/

| Game | Mode |
| --- | --- |
| **Ballpark** | Online, 2-8 players. Everyone guesses the same number; closest wins the round. |
| **Ludo** | Online (2-4 players), pass and play, or against the computer. |
| **Chess** | Online (2 players), pass and play, or against the computer. Full rules. |
| **Tic Tac Toe** | Online (2 players), pass and play, or against the computer (hard never loses). |
| **Snake** | Solo, classic walls or wrap-around, with best scores. |

## Playing with friends

1. Open a game and choose **Host a game**. You get a 4-letter room code.
2. Share the code or the invite link. Friends join from their own devices, wherever they are.
3. Play. Refreshing the page keeps your seat, and anyone extra can watch.

## How it works

- A static site with no server of its own: plain HTML, CSS and JavaScript, no build step.
- Devices talk through public MQTT relays over secure WebSockets (EMQX, with HiveMQ and Mosquitto as fallbacks).
- The host's browser runs the game. Players send their moves, the host checks them against the game's rules, and everyone renders one shared state. A move that gets re-sent after a network hiccup is never applied twice.
- If the host's phone sleeps or drops offline, the game waits for everyone to reconnect instead of moving on without them.
- `site/shared/room.js` handles rooms and `site/shared/shell.js` is the page frame (home screen, lobby, top bar) that every game uses. Each game keeps its rules in a pure `engine.js`, so they can be tested on their own.
- Chess rules come from [chess.js](https://github.com/jhlywa/chess.js). See `site/vendor/LICENSES.txt`.

## Project layout

```
site/
  index.html          the Game Night home page
  shared/             room kit, page frame, shared styles
  vendor/             mqtt.js and chess.js
  games/<game>/       one folder per game
test/                 unit tests and browser tests for every game
```

## Run it locally

```bash
cd test
npm install
npm run serve        # http://localhost:8766
```

Open two windows (one normal, one private) to play an online game against yourself.

## Tests

```bash
cd test
npm test             # rules for every game
npm run e2e          # every game in real browser sessions (needs Google Chrome)
```

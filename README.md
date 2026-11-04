# Last Letter Loses 💣

A word-chain bomb game for the classroom. Players take turns carrying on a word from the **last letter** of the
previous one. The letters pile up along a bar that ends in a bomb – if **your last letter touches the bomb**, you lose
a heart. Last player standing wins.

* **Same computer** – hot-seat for up to 8 players, the teacher adds the names and colours.
* **Online** – up to **6 players per room**, each on their own device. One person (usually the teacher) creates a room,
  everyone else joins with the 4-letter code or the invite link. The teacher can host **watch-only** to put the game on
  the projector.

## How the game works

* The shared letter stays on the bar – the next player only types the *rest* of their word.
* Letters are evenly spaced, but each letter's ink has its real width: a wide **W** or **M** in the last slot touches the
  bomb where a skinny **I** doesn't.
* No repeats, and no plurals / conjugations of a word already used (`dog` → `dogs`, `run` → `ran`, `plan` → `planned`…).
  The teacher can override a rejected word ("accept anyway" – in online mode students ask the host).
* The bar starts long and gets shorter every round.
* **Points & shop** – every word earns ⭐ points that double with each extra letter (3 letters = 1, 6 = 8, 8 = 32, 10 = 128).
  After each round a shop opens:

| Power-up | Price | Effect |
|---|---|---|
| ⏱️ Extra Time | 8 | +10 s on your turn clock |
| 🤏 Shrink | 12 | your next word's letters are 40 % thinner |
| ✨ Double Points | 15 | your next word scores ×2 |
| 😈 Jinx | 22 | the next player's letters are 40 % wider |
| 📏 Extend | 26 | +10 spaces on the bar for the round — each player can buy **one per round** |
| 🔄 Swap | 90 | pass your turn to the next player |

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Node 20+ is required. The only dependency is [`ws`](https://github.com/websockets/ws).

## Deploy on Render

1. Push this repo to GitHub (done if you are reading this there).
2. In Render choose **New → Blueprint** and pick the repo (it reads `render.yaml`), **or** **New → Web Service** with
   *Runtime* `Node`, *Build command* `npm install`, *Start command* `npm start`, *Health check path* `/healthz`.
3. Open the service URL. Create a room, give the code to the class.

Notes:

* Rooms live in memory, so run **one instance**. A redeploy / restart ends running games (players land back on the start screen).
* On Render's free plan the service sleeps after ~15 min of inactivity; the first visit afterwards takes about a minute to wake it.
* The server is authoritative: it validates every word (ENABLE dictionary + plural / conjugation rules), decides when letters hit
  the bomb, runs the turn clocks and the shop. A player who loses connection can rejoin (same browser tab) and gets
  the current state back; if it is their turn they have 20 s to return before the bomb goes off.

## Project layout

```
server.js            HTTP static server + WebSocket entry point
server/engine.js     game rooms: lobby, turns, scoring, shop, reconnects
shared/rules.js      word-form rules, points, items, glyph widths – used by the server AND the browser
src/game.src.html    the whole client (three.js scene, HUD, setup, online lobby)
assets/              embedded font + compressed ENABLE word list
tools/build.py       builds public/index.html from src/ (inlines font, dictionary and shared/rules.js)
public/index.html    built client (committed so Render needs no build step)
test/                engine.test.js (logic), e2e.js (real browsers, optional)
```

After editing `src/game.src.html` or `shared/rules.js` run `python3 tools/build.py` and commit `public/index.html`.

## Tests

```bash
npm test                      # engine logic with fake sockets + mocked clocks
node test/e2e.js              # optional: 4 real browsers play a full online game (needs playwright + Chrome)
```

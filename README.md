# Out of Signal

**A real-world Among Us for phones.** Players walk around a real neighbourhood, and one of them is secretly
the impostor. Phones find each other in two steps: **GPS** says who is roughly nearby (~30 m), then
**near-ultrasonic sound** (17.8–19.9 kHz, inaudible to most adults) confirms who is within about **2 m**.
The impostor takes someone out by staying within 2 m of them for 3.5 s and pressing *Kill*. That player's
phone goes dark with **SIGNAL LOST**. The crew wins by surviving until the timer runs out.

Live: **https://outofsignal.pl/** · Hackathon 2026

---

## Contents

- [Repository layout](#repository-layout)
- [Branches](#branches)
- [The game (`gps/`)](#the-game-gps)
  - [How a round works](#how-a-round-works)
  - [How proximity detection works](#how-proximity-detection-works)
  - [Files](#files)
  - [HTTP API](#http-api)
  - [Tuning constants](#tuning-constants)
  - [Run locally](#run-locally)
  - [Tests](#tests)
- [Sonar test page (`sonar/`)](#sonar-test-page-sonar)
- [React + Socket.IO prototype (`client/`, `server/`)](#react--socketio-prototype-client-server)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)

---

## Repository layout

```
hackaton2026/
├── README.md                  ← this file
├── package.json               ← root scripts for the React/Socket.IO prototype (concurrently)
│
├── gps/                       ← ★ THE GAME (deployed at outofsignal.pl)
│   ├── server.js              ← Express 5 app: static files + JSON API under BASE_PATH
│   ├── game.js                ← all game rules: Lobbies (codes) → Game (players, roles, kills, sonar gate)
│   ├── package.json           ← only dependency: express
│   ├── README.md              ← game-specific notes
│   ├── test/
│   │   └── game.test.js       ← node:test suite (rules + HTTP API)
│   └── public/                ← the browser app (plain JS, no build step)
│       ├── index.html         ← all screens: join, lobby, game, end, overlays
│       ├── app.js             ← UI + polling + location upload + kill bar
│       ├── sonar.js           ← Web Audio: plays your tone, listens for everyone else's
│       ├── world.js           ← MapLibre map behind every screen (globe → your street → game zone)
│       ├── style.css          ← dark monochrome UI, phone bottom-sheet / desktop side panel
│       ├── manifest.webmanifest, apple-touch-icon.png, icon-*.png, favicon.ico
│       │                      ← "Add to Home Screen" as a full-screen web app
│
├── sonar/
│   └── index.html             ← standalone ultrasonic calibration / recording tool (outofsignal.pl/sonar)
│
├── client/                    ← React 19 + Vite + TypeScript prototype frontend (Socket.IO)
│   └── src/ App.tsx, Game.tsx, SocketExample.tsx, NotFound.tsx, main.tsx
│
└── server/                    ← Express + Socket.IO + zod prototype backend (TypeScript, tsx)
    ├── src/app.ts, src/env.ts
    └── SOCKET_API.md          ← Socket.IO event reference
```

## Branches

| Branch | What's on it |
|---|---|
| `master` | Team base: React/Socket.IO prototype (`client/`, `server/`) |
| `feature/sonar-gps` | **The game**: `gps/` (GPS + sonar merged) and `sonar/`. This is what runs on outofsignal.pl |
| `sonar` | The standalone sonar test page only (`sonar/index.html`), as deployed at `/sonar` |
| `gps` | Snapshot of the original standalone GPS game, as deployed at `/gps` |

---

## The game (`gps/`)

### How a round works

1. **Join screen.** Type a name, then either
   - **Create lobby**: choose the zone radius (50 / 100 / 200 / 300 m) and max players (2–8). You get a
     4-letter code (letters only, no I/O). You are the host.
   - **Join**: type the code. A shared link `outofsignal.pl/?code=ABCD` opens Join with the code filled in.
2. **Lobby.** The map flies from the globe down to a 1 km × 1 km view of where you are, showing only your
   own dot with a radar pulse. Each player taps **Enable sound + location**. On iOS that tap is required
   before audio can start. Each player gets their own frequency slot. Tap the code to share it.
3. **Start** (host, at least 2 players). The host's position becomes the centre of the zone. The server
   secretly picks **one impostor**.
4. **In game.** The screen shows only the map (plus the kill bar for the impostor).
   - The **impostor** sees everyone's position live, updated every 1 s.
   - **Crew** get a map snapshot every 15 s (countdown at the top).
   - The impostor's kill bar shows one button per player within 2 m. The button charges for 3.5 s and
     then becomes **Kill NAME**. If several players are close, the impostor picks one. Kills have a 30 s
     cooldown.
   - The victim's phone stops its tone and shows **SIGNAL LOST**. They can watch the rest of the round or quit.
5. **End.**
   - **Impostor wins** when at most one crewmate is left (with 2 players: when the crewmate is out).
   - **Crew wins** when the 10-minute timer runs out, or if the impostor quits.
   - The roles are revealed. The host starts a new round with the same lobby; otherwise it returns to the
     lobby by itself after 90 s.

### How proximity detection works

```
 phone A ──GPS every ≤5 s──▶ server ◀──GPS── phone B
                               │
         "anyone within 30 m (+ GPS error, max +10 m)?"  →  sonarOn = true/false
                               │
 phone A ◀──── state poll every 1 s (sonarOn) ────▶ phone B
    │                                                  │
    ├─ plays its own tone  (17800 + slot·300 Hz) ──────┤
    └─ listens (FFT 8192) for every other slot's tone ─┘
          SNR = peak(±100 Hz) − median noise floor(±250 Hz), 1 s average
          ≥ 25 dB → "within ~2 m";  drops below 20 dB → out of range
          in range 3.5 s in total (gaps < 1.5 s pause the charge, longer gaps reset it) → kill allowed
```

- **GPS gate (server, `Game.gateInfo`)**: the sonar only runs while GPS says another living player is
  close. The gate stays open 10 s after leaving, and it is **fail-open**: if either phone's GPS is missing
  or older than 30 s, the gate is on, so kills still work without GPS. It ignores roles on purpose, so a
  phone switching its sonar on doesn't reveal anything.
- **Sonar (client, `sonar.js`)**: each phone plays one sine tone. Slots are spaced 300 Hz apart, which is
  wide enough for walking-speed Doppler shift.
- **Server sanity check on kills**: GPS can't measure 2 m, so the server only rejects kills that are
  clearly impossible (both fixes fresh and more than 50 m apart).
- **Debug**: open `outofsignal.pl/?debug=1` to see the gate state, nearest player on GPS, accuracy, and
  live dB per player.

### Files

| File | Responsibility |
|---|---|
| `server.js` | Express app. Security headers, same-origin check, JSON-only POSTs (4 KB limit), Bearer-token auth, routes, static files. `BASE_PATH` sets the URL prefix (`/` = site root). Sweeps empty lobbies every 30 s. |
| `game.js` → `Lobbies` | Map of code → `Game`. Creates lobbies (validates radius 25–1000 m, players 2–8), joins by code, finds a player's game from their token, deletes lobbies everyone has left. Max 200 lobbies. |
| `game.js` → `Game` | One lobby/round: players, frequency slots (lowest free), host, start, roles, kills, cooldown, win check, quit/leave, per-player map snapshots, GPS gate, **self-healing** (see below). |
| `public/app.js` | Screens (`join` / `lobby` / `game` / `end`), polls `/api/state` every 1 s, uploads GPS (`watchPosition`, at most every 3 s, plus a fresh fix every 5 s), kill bar, HUD, debug panel, SIGNAL LOST / reconnect overlays. |
| `public/sonar.js` | `window.Sonar`: `start()` (needs a user tap), `configure(sonar, slot)`, `setEmitting/setListening`, `near(slot)` → `{near, held, db}`. Threshold overridable with `?db=NN`. |
| `public/world.js` | `window.World`: MapLibre GL 5 globe with the OpenFreeMap dark style, turned grey. Spinning globe in the menu, fly-in to a 1 km view in the lobby, zone circle + dots in game. |
| `public/style.css` | Black/white UI. Phones: lobby/end as a bottom sheet over the map. ≥900 px: panel on the left. |

**Self-healing.** Each phone polls every second, so the server knows who is still there:
- If nobody in a round has been seen for 45 s, the round is wiped.
- A finished round returns to the lobby after 90 s.
- Lobby players not seen for 2 min are dropped. The long grace period covers a locked screen.
- If the host disappears, the host role passes to someone who is still connected.
- An empty lobby is deleted.

### HTTP API

All under `{BASE_PATH}/api`. POST bodies are JSON. Every route except create/join needs
`Authorization: Bearer <token>`.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/create` | `{name, radius, maxPlayers}` | `201 {token, code}` |
| POST | `/join` | `{name, code}` | `201 {token, code}`. Returns 404 for an unknown code and 409 if the lobby is full, the name is taken, or a round is running |
| GET | `/state` | n/a | Full view for *this* player: phase, lobby `{code, radius, maxPlayers}`, self, players, sonar config, `sonarOn`, zone, timers, positions (per-player snapshot), result. Header `X-Debug: 1` adds the `gate` field |
| POST | `/sound` | `{ready: true}` | Marks the player's sound as working |
| POST | `/location` | `{latitude, longitude, accuracy}` | Stores a GPS fix |
| POST | `/start` | `{}` | Host only, ≥2 players, fresh host fix |
| POST | `/kill` | `{targetId}` | Impostor only; returns 429 during the cooldown |
| POST | `/reset` | `{}` | Host, after a round: same lobby, new round |
| POST | `/quit` | `{}` | Leave at any time (mid-round you count as out) |
| POST | `/leave` | `{}` | Leave the lobby before the game starts |

The server never sends other players' roles, and it caches each player's map snapshot per session, so
polling faster or editing requests doesn't reveal more.

### Tuning constants

| Where | Constant | Value | Meaning |
|---|---|---|---|
| `game.js` | `GATE_M`, `GATE_SLACK_M`, `GATE_HOLD_MS` | 30 m, +10 m, 10 s | GPS gate for the sonar |
| `game.js` | `KILL_COOLDOWN_MS` | 30 s | Between kills |
| `game.js` | `KILL_RANGE_M` | 50 m | Server rejects kills further apart than this (fresh fixes) |
| `game.js` | `GAME_DURATION_MS` | 10 min | Round length |
| `game.js` | `IMPOSTOR_UPDATE_MS` / `REGULAR_UPDATE_MS` | 1 s / 15 s | Map refresh (15 s is a testing value) |
| `game.js` | `SONAR` | base 17800 Hz, spacing 300 Hz, 8 slots | Frequency plan |
| `game.js` | `GONE_MS`, `LOBBY_DROP_MS`, `ENDED_AUTO_RESET_MS` | 45 s, 2 min, 90 s | Self-healing |
| `public/sonar.js` | `KILL_DB`, `HYST` | 25 dB, 5 dB | Enter / leave the 2 m range |
| `public/sonar.js` | `HOLD_S`, `GRACE_S` | 3.5 s, 1.5 s | Kill charge time, allowed dropout |

### Run locally

Requires Node ≥ 22.

```bash
cd gps
npm install
npm run dev                  # http://localhost:3000/gps/   (default BASE_PATH=/gps)
BASE_PATH=/ npm start        # serve at http://localhost:3000/
```

Location and microphone need a **secure context**. `localhost` counts as secure, but to test from a
phone you need HTTPS, e.g. a tunnel or the deployed site.

### Tests

```bash
cd gps && npm test           # node --test: slots, kills, cooldown, wins, quit, gate, self-healing, lobbies, HTTP API
```

---

## Sonar test page (`sonar/`)

A single self-contained HTML file for calibrating the ultrasonic detection on real phones
(https://outofsignal.pl/sonar). It plays and detects tones, shows live SNR, and has an **interval
recorder**: record continuously, cut labelled intervals ("standing in kill zone", "walking away" …) and
export CSV. The game's thresholds (25/20 dB, 3.5 s hold, 1.5 s grace) were tuned from these recordings.
It also has the kill-tone / SIGNAL LOST demo. There's no build step: open it in a browser over HTTPS.

## React + Socket.IO prototype (`client/`, `server/`)

The team's first scaffold, from `master`: React 19 + Vite + TypeScript frontend, Express + Socket.IO + zod
backend. The game above doesn't use it. Socket events are documented in
[server/SOCKET_API.md](./server/SOCKET_API.md).

Setup (from the repo root):

1. `npm install`
2. `npm run i`: installs the backend and the frontend
3. copy `client/.env.example` → `client/.env` (`VITE_API_URL="http://localhost:4000"`)
4. copy `server/.env.example` → `server/.env` (`PORT="4000"`, `WEB_ORIGIN="http://localhost:5173"`)
5. `npm run dev`: runs both at once (backend :4000, frontend :5173)

---

## Deployment

VPS behind **Caddy** (automatic HTTPS) for `outofsignal.pl`:

| URL | Served by |
|---|---|
| `/` | The game: `gps/` in `/opt/outofsignal-app`, systemd `outofsignal-app`, port 3004, `BASE_PATH=/` |
| `/app`, `/app/*` | 308 redirect to `/` (old links) |
| `/sonar`, `/sonar/*` | Static `sonar/index.html` (`Cache-Control: no-store`) |
| `/gps/*` | Teammate's standalone GPS game, port 3003 |

Redeploy the game:

```bash
tar --exclude node_modules --exclude test -czf app.tgz -C gps .
scp app.tgz <server>:/tmp/
ssh <server> 'cd /opt/outofsignal-app && sudo tar xzf /tmp/app.tgz && sudo npm ci --omit=dev \
  && sudo chmod -R u=rwX,go=rX . && sudo systemctl restart outofsignal-app'
```

- If only `public/` files changed, skip `npm ci` and the restart. A restart wipes all lobbies, because
  games live only in memory.
- Caddy: back up `/etc/caddy/Caddyfile` first, run `caddy validate --config /etc/caddy/Caddyfile`, then
  `systemctl reload caddy`. Use exact path matchers (`path /sonar /sonar/*`), not prefixes like
  `/sonar*`. A prefix also catches the game's own `/sonar.js` and `/app.js`.
- iPhone: open outofsignal.pl in Safari → Share → **Add to Home Screen** (Open as Web App on). It then runs
  full screen with no Safari bars.

## Known limitations

- **In-memory state**: no database. A server restart clears all lobbies and games.
- **No accounts / anti-cheat**: GPS can be spoofed, and the 2 m check runs on the impostor's phone.
- **Sonar depends on the hardware**: some phones filter out frequencies above ~18 kHz, and pockets or
  cases weaken the signal. Use `?debug=1` and the `/sonar` page to check.
- **iOS** needs a tap before audio starts (the *Enable sound + location* / *TAP* reconnect overlay), and
  locking the screen pauses audio.
- **Max 8 players** per lobby (the number of frequency slots that fit below the microphone's limit).
- Crew tasks are planned and not built yet.

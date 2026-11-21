# Out of Signal

**A real-world Among Us for phones.** Players walk around a real neighbourhood, and one of them is secretly
the impostor. Phones find each other in two steps: **GPS** says who is roughly nearby (~30 m), then
**near-ultrasonic sound** (17.8–19.9 kHz, inaudible to most adults) confirms who is within about **2 m**.
The impostor takes someone out by staying within 2 m of them for 3.5 s and pressing *Kill*. That player's
phone goes dark with **SIGNAL LOST**. The crew wins by surviving until the timer runs out.

Live: **https://outofsignal.pl/** · Hackathon 2026

---

## Stack

- **Client**: React 19 + TypeScript, built with Vite. MapLibre GL for the map, Web Audio for the sonar.
- **Server**: Node.js + Express 5 + TypeScript. Node ≥ 22.18 runs the `.ts` files directly (type
  stripping), so the server has no build step. All state is in memory.
- **Shared**: API types used by both sides (`shared/types.ts`).
- npm workspaces: one `npm install` at the root installs everything.

## Project structure

```
.
├── package.json                 workspaces + scripts: dev, build, start, typecheck
│
├── shared/
│   └── types.ts                 API types (GameView, PlayerSummary, …) shared by client and server
│
├── server/                      Express API + serves the built client
│   └── src/
│       ├── index.ts             entry point: reads PORT / HOST / BASE_PATH, starts the HTTP server
│       ├── app.ts               Express app: security headers, JSON API routes, static files
│       ├── lobbies.ts           all running games, each behind a 4-letter lobby code
│       ├── game.ts              one lobby + its rounds: players, roles, kills, win check, sonar gate
│       ├── config.ts            every gameplay number (timers, distances, frequencies, limits)
│       ├── geo.ts               distance between two GPS points
│       └── errors.ts            GameError (message shown to the player + HTTP status)
│
├── client/                      React app (Vite)
│   ├── index.html
│   ├── vite.config.ts           dev server proxies /api → :3000
│   ├── public/                  manifest, favicon, home-screen icons (copied as-is)
│   └── src/
│       ├── main.tsx             React entry
│       ├── App.tsx              picks the screen from the game phase; map, overlays, toast around it
│       ├── styles.css           black & white UI (phone bottom sheet / desktop side panel)
│       ├── hooks/
│       │   ├── useGame.ts       polls /api/state every second, keeps the sonar in sync, all game actions
│       │   └── useTicker.ts     re-render every N ms (countdowns, live sonar)
│       ├── screens/
│       │   ├── JoinScreen.tsx   name + Create lobby (radius, players) / Join (code)
│       │   ├── LobbyScreen.tsx  code + share, player list, sound/location status, start
│       │   ├── GameScreen.tsx   map, HUD, impostor kill bar, ?debug=1 readout
│       │   └── EndScreen.tsx    winner + roles revealed, new round
│       ├── components/
│       │   ├── WorldMap.tsx     the map behind every screen
│       │   ├── Overlays.tsx     SIGNAL LOST, tap-to-reconnect
│       │   ├── ErrorToast.tsx, PlayerRow.tsx, Choice.tsx
│       └── lib/                 plain TypeScript, no React
│           ├── api.ts           fetch wrapper + session token
│           ├── sonar.ts         Web Audio: plays your tone, listens for everyone else's
│           ├── world.ts         MapLibre: globe → your street → game zone (lazy-loaded)
│           ├── location.ts      GPS: one-off fixes, tracking, uploads (+ useLocation hook)
│           ├── toast.ts         error toast store (showError from anywhere)
│           └── time.ts          server clock, countdown formatting
│
└── tools/
    └── sonar-lab/index.html     standalone sonar calibration + recording page (outofsignal.pl/sonar)
```

### Branches

| Branch | What's on it |
|---|---|
| `feature/sonar-gps` | **The game** (React + TS). Runs on outofsignal.pl |
| `master` | The team's first scaffold: React + Socket.IO prototype (not used by the game) |
| `sonar` | The original sonar test page only |
| `gps` | Snapshot of the original standalone GPS game (outofsignal.pl/gps) |

---

## How a round works

1. **Join screen.** Type a name, then either
   - **Create lobby**: choose the zone radius (50 / 100 / 200 / 300 m) and max players (2–8). You get a
     4-letter code and you are the host.
   - **Join**: type the code. A shared link `outofsignal.pl/?code=ABCD` opens Join with the code filled in.
2. **Lobby.** The map flies from the globe down to a 1 km × 1 km view of where you are, showing only your
   own dot. Each player taps **Enable sound + location**. On iOS that tap is required before audio can
   start. Each player gets their own sonar frequency. Tap the code to share it.
3. **Start** (host, at least 2 players). The host's position becomes the centre of the zone. The server
   secretly picks **one impostor**.
4. **In game.** The screen shows only the map.
   - The **impostor** sees everyone live, updated every 1 s.
   - **Crew** get a map snapshot every 15 s.
   - The impostor's kill bar shows a button for each player within 2 m. The button charges for 3.5 s and
     then becomes **Kill NAME**. If several players are close, the impostor picks one. Kills have a 30 s
     cooldown.
   - The victim gets **SIGNAL LOST**. They can watch the rest of the round or quit.
5. **End.**
   - **Impostor wins** when at most one crewmate is left.
   - **Crew wins** when the 10-minute timer runs out, or if the impostor quits.
   - Roles are revealed. The host starts a new round; otherwise the lobby reopens by itself after 90 s.

## How proximity works

```
 phone A ──GPS every 3–5 s──▶ server ◀──GPS── phone B
                               │
          another living player within 30 m (+ GPS error)?  →  sonarOn
                               │
 phone A ◀──── poll every 1 s (sonarOn) ────▶ phone B
    ├─ plays its own tone   17 800 + slot × 300 Hz
    └─ listens for every other slot's tone (FFT 8192)
          SNR = peak (±100 Hz) − median noise (±250 Hz), averaged over 1 s
          ≥ 25 dB → within ~2 m;   below 20 dB → out of range
          3.5 s in range (gaps < 1.5 s pause the charge, longer gaps reset it) → kill allowed
```

- **Sonar gate** (`server/src/game.ts` → `sonarGate`): the sonar only runs while GPS says someone is close. It
  stays on 10 s after that, and it is **fail-open**: without fresh GPS the sonar runs anyway. It ignores
  roles on purpose, so a phone switching its sonar on doesn't give the impostor away.
- **Kill check on the server**: GPS can't measure 2 m, so the server only rejects kills where both phones
  have fresh GPS fixes more than 50 m apart.
- **Self-healing**:
  - If nobody in a round has been seen for 45 s, the round is wiped.
  - A finished round reopens the lobby after 90 s.
  - Lobby players not seen for 2 min are dropped.
  - If the host disappears, the host role passes to someone present.
  - An empty lobby is deleted.
- **Debug**: `outofsignal.pl/?debug=1` shows the gate state, the nearest player on GPS and live dB per
  player. `?db=NN` overrides the kill threshold on that phone.

All numbers live in `server/src/config.ts` (server) and at the top of `client/src/lib/sonar.ts` (thresholds).

## HTTP API

Everything is under `/api`. POST bodies are JSON. Every route except `create` and `join` needs
`Authorization: Bearer <token>`.

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/create` | `{name, radius, maxPlayers}` | `201 {token, code}` |
| POST | `/join` | `{name, code}` | `201 {token, code}`. 404 if the code is unknown; 409 if the lobby is full, the name is taken, or a round is running |
| GET | `/state` | n/a | This player's view: phase, lobby, self, players, sonar, `sonarOn`, zone, timers, map snapshot, result. `X-Debug: 1` adds `gate` |
| POST | `/sound` | `{ready: true}` | Marks the player's sound as working |
| POST | `/location` | `{latitude, longitude, accuracy}` | Stores a GPS fix |
| POST | `/start` | `{}` | Host only, ≥ 2 players, fresh host fix |
| POST | `/kill` | `{targetId}` | Impostor only. 429 during the cooldown |
| POST | `/reset` | `{}` | Host, after a round: new round with the same lobby |
| POST | `/quit` | `{}` | Leave at any time (mid-round you count as out) |
| POST | `/leave` | `{}` | Leave the lobby before the game starts |

The server never sends other players' roles. Map snapshots are cached per player, so polling faster
reveals nothing extra.

## Run locally

Requires Node ≥ 22.18.

```bash
npm install
npm run dev          # API on :3000 + Vite on :5173 (hot reload) → open http://localhost:5173
npm run typecheck    # tsc for server and client
npm run build        # client → client/dist
npm start            # production: server on :3000 serves the API + client/dist
```

`BASE_PATH=/play npm start` serves everything under `/play/`. Location and the microphone need a secure
context. `localhost` counts as secure, but to test from a phone you need HTTPS, e.g. a tunnel or the
deployed site.

## Deployment

The VPS runs **Caddy** (automatic HTTPS) in front of `outofsignal.pl`:

| URL | Served by |
|---|---|
| `/` | The game: `/opt/outofsignal-app`, systemd `outofsignal-app` (`node server/src/index.ts`, port 3004) |
| `/app`, `/app/*` | 308 redirect to `/` (old links) |
| `/sonar`, `/sonar/*` | `tools/sonar-lab/index.html` as a static file |
| `/gps/*` | The original standalone GPS game (port 3003) |

Redeploy the game (build locally, ship the build + server):

```bash
npm run build
tar --exclude node_modules -czf app.tgz package.json package-lock.json shared server client/package.json client/dist
scp app.tgz <server>:/tmp/
ssh <server> 'cd /opt/outofsignal-app && sudo tar xzf /tmp/app.tgz && sudo npm ci --omit=dev -w @oos/server \
  && sudo chmod -R u=rwX,go=rX . && sudo systemctl restart outofsignal-app'
```

- If only the client changed, shipping `client/dist` is enough (no restart). A restart wipes all lobbies, because games live
  only in memory.
- Caddy: back up `/etc/caddy/Caddyfile`, run `caddy validate --config /etc/caddy/Caddyfile`, then
  `systemctl reload caddy`. Use exact matchers (`path /sonar /sonar/*`), not prefixes like `/sonar*`. A
  prefix also catches the game's own files.
- iPhone: open outofsignal.pl in Safari → Share → **Add to Home Screen** (Open as Web App on).

## Known limitations

- **In-memory state**: no database. A server restart clears all lobbies.
- **No accounts / anti-cheat**: GPS can be spoofed, and the 2 m check runs on the impostor's phone.
- **Sonar depends on the hardware**: some phones filter out frequencies above ~18 kHz, and pockets and
  cases weaken the signal. Use `?debug=1` and `/sonar` to check.
- **iOS** needs a tap before audio starts, and locking the screen pauses it.
- **Max 8 players** per lobby (the number of frequency slots below the microphone's limit).
- Crew tasks are planned and not built yet.

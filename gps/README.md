# Out of Signal — GPS + sonar game

Express app served under `/gps/`. GPS map + 100 m zone + one hidden impostor, merged with the
ultrasonic 2 m proximity detection from `/sonar`.

## How a round works

- **Lobby:** up to 8 players. Each player gets a **sonar slot** = their own frequency
  (slot 0 = 17.8 kHz, +300 Hz per slot, up to 19.9 kHz). Everyone taps **Enable sound & mic**
  (needs a tap on iOS) and **Enable location**. The lobby list shows 🔊 / 🔇 per player.
- **Start:** host starts (≥ 2 players); one random impostor; 10 minute round.
- **During the round** every living phone plays its tone. The impostor's phone listens: anyone
  within 2 m (1 s average ≥ 27 dB above noise, leaves below 22 dB) shows up in **Targets**.
  After **3.5 s** close the row becomes a **Kill** button. Several close → the impostor picks.
  Dropouts shorter than 1.5 s don't reset the 3.5 s.
- **Kill:** `POST /gps/api/kill {targetId}`. Server rules: only the living impostor, target alive,
  **30 s cooldown**, and rejected only if both GPS fixes are fresh and > 50 m apart (GPS can't see 2 m;
  sonar is the authority). The victim's phone shows **SIGNAL LOST** and stops broadcasting.
- **End:** impostor wins when ≤ 1 regular is alive; regular players win if the timer runs out.
  The impostor is revealed; the host can start a **New round** (same players and slots).

Tuning constants: `game.js` (cooldown, round length, slots) and `public/sonar.js` (dB thresholds,
hold/grace). Calibration page: `/sonar`.

## Original notes

Standalone Express application. All frontend files and API routes are served under `/gps/`. The original project in the parent directory is independent and unchanged.

## Local development

Requires Node.js 22 or newer. From this directory:

```sh
npm install
npm start
```

On Windows PowerShell, use `npm.cmd` if script execution is restricted. Open http://localhost:3000/gps/. Run `npm test` for backend and HTTP integration tests; `npm run dev` restarts the server when files change. No frontend build is required. The initial install creates `package-lock.json`; commit it and use `npm ci` for subsequent installations.

Verification in the development environment: JavaScript syntax checks and the five game-logic tests passed. Installing Express was blocked by network permissions, so the Express HTTP integration test and browser verification still need to be run after installation.

**Lobbies.** Enter a name, then *Create lobby* (pick the zone radius — 50/100/200/300 m — and max players, 2–8) or *Join* with the 4-letter lobby code. The lobby screen shows the code; tap it to share a link (`…/app/?code=ABCD` opens the join screen with the code filled in). Many lobbies run at once; a lobby disappears once everyone in it has left. The creator is the host. At least two players are needed to start. Starting obtains a fresh host location and fixes the zone (the lobby's radius) there. The server chooses exactly one impostor. Players see their own role and the shared map, with no special abilities. Regular players receive position snapshots every 120 seconds and the impostor every 10 seconds. The server enforces these intervals per authenticated session; polling faster or changing request parameters cannot bypass them. Coordinates are hidden in the lobby and other players' roles are never returned.

Game state lives in memory in a single process; restart to reset. The roster closes on start. Reloading the same tab preserves its session. Missing GPS fixes or fixes over 30 seconds old are marked unavailable at the next snapshot. Keep the page open for GPS updates. Location on phones requires HTTPS. Leaflet and map tiles need internet access.

## Deploy to outofsignal.pl/gps/

After installing dependencies locally (which creates `package-lock.json`) and running the tests, upload the project outside the public web root. From the local `gps/` directory:

```sh
ssh gps@57.131.194.95 "mkdir -p ~/fieldwork-express/public"
scp package.json package-lock.json server.js game.js gps@57.131.194.95:fieldwork-express/
scp -r public/* gps@57.131.194.95:fieldwork-express/public/
ssh gps@57.131.194.95
```

Then on the server:

```sh
cd ~/fieldwork-express
npm ci --omit=dev
HOST=127.0.0.1 PORT=3000 node server.js
```

For ongoing operation, have the administrator configure a process manager to run that command with automatic restart. Use one process because game state is not shared between workers. If another app already uses port 3000, choose a free port and match it in the proxy configuration.

In the existing Nginx HTTPS server configuration for `outofsignal.pl`, the administrator should route the whole `/gps/` path to Express:

```nginx
location = /gps {
    return 308 /gps/;
}

location /gps/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Preserve `/gps/` in the upstream URL: `proxy_pass` intentionally has no trailing slash. Replace any conflicting old `/gps/` static or `/gps/api/` proxy rules, validate the configuration, then reload Nginx. The rest of the website keeps its existing routing. Apache or managed hosting needs equivalent proxy rules.

Express serves the frontend itself, so copying files to `/www/` is not necessary for this deployment. Do not expose the project root as a static directory. Upload-only hosting cannot run the app without backend hosting support.

Check that `https://outofsignal.pl/gps/` loads and `/gps/api/state` returns a JSON HTTP 401 without authentication. Then join from two devices and start. This prototype has no persistent storage, accounts, GPS anti-cheat, or public join-abuse controls.

## Git branch

The supplied workspace was not a Git repository, so no branch was created. To use this in your website repository, create a feature branch there and copy this `gps/` directory into it, excluding `node_modules/`:

```sh
git switch -c feature/gps-express
```

A branch does not configure the `/gps/` URL; the reverse proxy does that.

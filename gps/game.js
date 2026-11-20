import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Kill rules. The 2 m check happens on the impostor's phone (sonar). GPS can't see 2 m, so the
// server only rejects kills that are clearly impossible: both fixes fresh and > KILL_RANGE_M apart.
// GPS gate for the sonar: phones only play / analyse tones while another living player is within
// GATE_M on GPS (+ up to GATE_SLACK_M for GPS error). Stays on GATE_HOLD_MS after leaving, and
// is on whenever GPS is missing/stale (fail open, so kills still work without GPS).
// 30 m: phone GPS between two phones is often 15–30 m off, so 15 m missed real encounters.
export const GATE_M = 30, GATE_SLACK_M = 10, GATE_HOLD_MS = 10000;
// Self-healing (there is only one game): a phone polls every second, so a player not seen for
// GONE_MS has closed the tab. Gone players leave the lobby; a round nobody is watching any more is
// wiped; a finished round goes back to the lobby by itself; the host passes to someone present.
export const GONE_MS = 45000, LOBBY_DROP_MS = 120000, ENDED_AUTO_RESET_MS = 90000;   // lobby: 2 min grace (screen lock)
export const KILL_RANGE_M = 50, KILL_FIX_MAX_AGE_MS = 30000, KILL_COOLDOWN_MS = 30000, GAME_DURATION_MS = 10 * 60000;

// Sonar: every player gets a slot = their own near-ultrasonic frequency (one tone per phone).
// Phones must stay well below the mic's limit, so slots are capped at 8 (17.8 – 19.9 kHz).
// Map refresh: the impostor tracks everyone live; crewmates get a snapshot every 15 s (testing value).
export const IMPOSTOR_UPDATE_MS = 1000, REGULAR_UPDATE_MS = 15000;

export const SONAR = { base: 17800, spacing: 300, slots: 8 };
export const slotFreq = slot => SONAR.base + slot * SONAR.spacing;

// Great-circle distance in metres.
export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad, dLon = (b.longitude - a.longitude) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export class Game {
  constructor({ now = Date.now, choose = randomInt, duration = GAME_DURATION_MS } = {}) {
    this.now = now;
    this.choose = choose;
    this.duration = duration;
    this.players = new Map();
    this.sessions = new Map();
    this.phase = 'lobby';
    this.hostId = null;
    this.zone = null;
    this.result = null;
    this.lastKillAt = null;
  }

  seen(p) { return this.now() - (p.lastSeen ?? 0) < GONE_MS; }

  // Called before every request.
  maintain() {
    const players = [...this.players.values()];
    if (this.phase !== 'lobby' && players.length && !players.some(p => this.seen(p))) {
      // Everybody left mid-round or after it: start completely fresh.
      this.players.clear(); this.sessions.clear(); this.hostId = null;
      this.phase = 'lobby'; this.zone = null; this.result = null; this.startedAt = undefined; this.endsAt = undefined; this.lastKillAt = null;
      return;
    }
    if (this.phase === 'ended' && this.now() - this.result.endedAt >= ENDED_AUTO_RESET_MS) this.backToLobby();
    if (this.phase === 'lobby') for (const p of players) if (this.now() - (p.lastSeen ?? 0) >= LOBBY_DROP_MS) { this.players.delete(p.id); this.dropSessions(p); }
    const host = this.players.get(this.hostId);
    if (!host || !this.seen(host)) {
      const next = [...this.players.values()].filter(p => this.seen(p) && this.hasSession(p)).sort((a, b) => b.lastSeen - a.lastSeen)[0];
      if (next) this.hostId = next.id;
    }
  }

  join(name) {
    this.maintain();
    if (this.phase !== 'lobby') {
      const left = this.endsAt ? Math.max(0, Math.ceil((this.endsAt - this.now()) / 1000)) : 0;
      throw new GameError(this.phase === 'playing'
        ? `A round is in progress (${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left). Try again when it ends.`
        : 'A round just ended. The lobby opens again in a moment.', 409);
    }
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24)
      throw new GameError('Choose a name between 1 and 24 characters.');
    if (this.players.size >= SONAR.slots) throw new GameError(`The lobby is full (${SONAR.slots} players max).`, 409);
    if ([...this.players.values()].some(p => p.name.toLowerCase() === name.trim().toLowerCase()))
      throw new GameError('That name is already taken.', 409);
    const token = randomBytes(32).toString('hex');
    const used = new Set([...this.players.values()].map(p => p.slot));
    let slot = 0; while (used.has(slot)) slot++;             // lowest free frequency slot
    const player = { id: randomUUID(), lastSeen: this.now(), name: name.trim(), slot, role: null, alive: true, location: null, snapshot: null, nextUpdateAt: null };
    this.players.set(player.id, player);
    this.sessions.set(token, player.id);
    this.hostId ??= player.id;
    return token;
  }

  authenticate(token) {
    this.maintain();
    const player = this.players.get(this.sessions.get(token));
    if (!player) throw new GameError('Join the game to continue.', 401);
    player.lastSeen = this.now();
    return player;
  }

  setSound(player, ready) { player.soundReady = ready === true; }

  updateLocation(player, location) {
    const { latitude, longitude, accuracy } = location ?? {};
    if (![latitude, longitude, accuracy].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100000)
      throw new GameError('Invalid coordinates or accuracy.');
    player.location = { latitude, longitude, accuracy, recordedAt: this.now() };
  }

  start(player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start the game.', 403);
    if (this.phase !== 'lobby') throw new GameError('The game has already started.', 409);
    if (this.players.size < 2) throw new GameError('At least two players are required.', 409);
    if (!player.location || this.now() - player.location.recordedAt > 15000)
      throw new GameError('Get a fresh location before starting.', 409);
    this.zone = { latitude: player.location.latitude, longitude: player.location.longitude, radius: 100 };
    const players = [...this.players.values()];
    const impostor = this.choose(players.length);
    this.phase = 'playing';
    this.startedAt = this.now();
    this.endsAt = this.startedAt + this.duration;
    this.lastKillAt = null;
    players.forEach((p, i) => {
      p.role = i === impostor ? 'impostor' : 'regular';
      p.alive = true;
      this.release(p);
    });
  }

  // Impostor kills a living regular player who is close by.
  kill(killer, targetId) {
    this.checkEnd();
    if (this.phase !== 'playing') throw new GameError('The game is not running.', 409);
    if (killer.role !== 'impostor') throw new GameError('Only the impostor can kill.', 403);
    if (!killer.alive) throw new GameError('You are out of the game.', 403);
    const target = this.players.get(targetId);
    if (!target || target === killer) throw new GameError('Unknown target.', 404);
    if (!target.alive) throw new GameError('That player is already out.', 409);
    const now = this.now();
    if (this.lastKillAt !== null && now - this.lastKillAt < KILL_COOLDOWN_MS)
      throw new GameError(`Kill cooling down (${Math.ceil((KILL_COOLDOWN_MS - (now - this.lastKillAt)) / 1000)} s).`, 429);
    const fresh = p => p.location && now - p.location.recordedAt <= KILL_FIX_MAX_AGE_MS;
    if (fresh(killer) && fresh(target) && distanceM(killer.location, target.location) > KILL_RANGE_M)
      throw new GameError('Target is too far away.', 409);
    target.alive = false;
    target.diedAt = now;
    target.killedBy = killer.id;
    this.lastKillAt = now;
    this.checkEnd();
  }

  // Impostor wins when no more than one regular is alive (they can't be stopped 1-on-1);
  // regular players win if they survive until the timer runs out.
  checkEnd() {
    if (this.phase !== 'playing') return;
    const players = [...this.players.values()];
    const regularsAlive = players.filter(p => p.role === 'regular' && p.alive).length;
    const totalRegulars = players.filter(p => p.role === 'regular').length;
    let winner = null, reason = null;
    if (regularsAlive === 0 || (totalRegulars > 1 && regularsAlive <= 1)) { winner = 'impostor'; reason = 'The impostor took out the crew.'; }
    else if (this.now() >= this.endsAt) { winner = 'regular'; reason = 'Time ran out – the crew survived.'; }
    if (!winner) return;
    this.phase = 'ended';
    const impostor = players.find(p => p.role === 'impostor');
    this.result = { winner, reason, impostorId: impostor.id, impostorName: impostor.name, endedAt: this.now() };
  }

  // Host returns everyone to a fresh lobby (same players, roles cleared).
  reset(player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start a new round.', 403);
    if (this.phase !== 'ended') throw new GameError('The game is still running.', 409);
    this.backToLobby();
  }

  backToLobby() {
    for (const p of [...this.players.values()]) if (!this.hasSession(p) || !this.seen(p)) { this.players.delete(p.id); this.dropSessions(p); }   // quitters / gone
    this.phase = 'lobby'; this.zone = null; this.result = null; this.startedAt = undefined; this.endsAt = undefined; this.lastKillAt = null;
    for (const p of this.players.values()) Object.assign(p, { role: null, alive: true, snapshot: null, snapshotAt: null, nextUpdateAt: null, diedAt: undefined, killedBy: undefined });
  }

  release(player) {
    const now = this.now();
    player.snapshot = [...this.players.values()].filter(p => p.alive).map(p => ({
      id: p.id, name: p.name,
      location: p.location && now - p.location.recordedAt <= 30000 ? { ...p.location } : null
    }));
    player.snapshotAt = now;
    player.nextUpdateAt = now + (player.role === 'impostor' ? IMPOSTOR_UPDATE_MS : REGULAR_UPDATE_MS);
  }

  // Is any other living player close enough on GPS for the sonar to bother? Role-blind on purpose:
  // the phone switching on must not reveal who is near.
  sonarGate(player) { return this.gateInfo(player).on; }

  // Also returns what the decision was based on, for the ?debug=1 readout.
  gateInfo(player) {
    const info = { on: false, why: 'not playing', me: null, nearest: null };
    if (this.phase !== 'playing' || !player.alive) return info;
    const now = this.now(), fresh = p => p.location && now - p.location.recordedAt <= KILL_FIX_MAX_AGE_MS;
    const fix = p => p.location ? { acc: Math.round(p.location.accuracy), age: Math.round((now - p.location.recordedAt) / 1000) } : null;
    info.me = fix(player);
    let near = false;
    if (!fresh(player)) { near = true; info.why = 'my GPS stale'; }                    // fail open
    for (const p of this.players.values()) {
      if (p === player || !p.alive) continue;
      if (!fresh(p)) { if (!near) info.why = 'their GPS stale'; near = true; continue; }
      if (!fresh(player)) continue;
      const d = distanceM(player.location, p.location);
      if (!info.nearest || d < info.nearest.m) info.nearest = { m: Math.round(d), ...fix(p) };
      const slack = Math.min(GATE_SLACK_M, (player.location.accuracy + p.location.accuracy) / 2);
      if (d <= GATE_M + slack) { if (!near) info.why = 'gps close'; near = true; }
    }
    if (near) player.gateUntil = now + GATE_HOLD_MS;
    else if (now < (player.gateUntil ?? 0)) { near = true; info.why = 'hold'; }
    else info.why = 'nobody close';
    info.on = near;
    return info;
  }

  state(player, { debug = false } = {}) {
    // The cache belongs to the authenticated player, never the request/connection.
    // Polling faster, reconnecting, or supplying a different role cannot bypass it.
    this.checkEnd();
    if (this.phase === 'playing' && this.now() >= player.nextUpdateAt) this.release(player);
    const killer = player.killedBy && this.players.get(player.killedBy);
    return {
      phase: this.phase, serverTime: this.now(), hostId: this.hostId,
      self: { id: player.id, name: player.name, slot: player.slot, role: player.role, alive: player.alive, diedAt: player.diedAt ?? null },
      // Who is out is public (like a body being found); who did it stays secret until the end.
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, sound: !!p.soundReady })),
      sonar: SONAR,
      ...(() => { const g = this.gateInfo(player); return { sonarOn: g.on, ...(debug ? { gate: g } : {}) }; })(),
      zone: this.zone, startedAt: this.startedAt ?? null, endsAt: this.endsAt ?? null,
      killCooldownUntil: player.role === 'impostor' && this.lastKillAt !== null ? this.lastKillAt + KILL_COOLDOWN_MS : null,
      result: this.result && { ...this.result, killedByName: killer ? killer.name : null },
      positions: player.snapshot ?? [], snapshotAt: player.snapshotAt ?? null,
      nextUpdateAt: player.nextUpdateAt,
      updateInterval: this.phase === 'playing' ? (player.role === 'impostor' ? IMPOSTOR_UPDATE_MS : REGULAR_UPDATE_MS) / 1000 : null
    };
  }

  leave(player) {
    if (this.phase !== 'lobby') throw new GameError('Players cannot leave the roster after the game starts.', 409);
    this.players.delete(player.id);
    this.dropSessions(player);
  }

  // Quit at any time. In the lobby / after a round: removed. Mid-round: counts as out (signal
  // lost) and stays on the roster until the next round; if the impostor quits, the crew wins.
  quit(player) {
    if (this.phase !== 'playing') {
      this.players.delete(player.id);
      this.dropSessions(player);
      return;
    }
    player.alive = false; player.quit = true; player.diedAt = this.now();
    this.dropSessions(player);
    if (player.role === 'impostor') {
      this.phase = 'ended';
      this.result = { winner: 'regular', reason: 'The impostor quit.', impostorId: player.id, impostorName: player.name, endedAt: this.now() };
    } else this.checkEnd();
  }

  hasSession(player) { for (const id of this.sessions.values()) if (id === player.id) return true; return false; }

  dropSessions(player) {
    for (const [token, id] of this.sessions) if (id === player.id) this.sessions.delete(token);
    if (this.hostId === player.id)
      this.hostId = [...this.players.values()].find(p => p.id !== player.id && this.hasSession(p))?.id ?? null;
  }
}

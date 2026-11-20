import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  CREW_MAP_INTERVAL_MS, ENDED_RETURN_TO_LOBBY_MS, IMPOSTOR_MAP_INTERVAL_MS, KILL_COOLDOWN_MS,
  KILL_MAX_DISTANCE_M, LOBBY_IDLE_DROP_MS, LOCATION_MAX_AGE_MS, NAME_MAX_LENGTH, PLAYER_GONE_MS,
  ROUND_DURATION_MS, SONAR, SONAR_GATE_HOLD_MS, SONAR_GATE_M, SONAR_GATE_SLACK_M, START_LOCATION_MAX_AGE_MS,
  ZONE_RADIUS_M
} from './config.js';
import { GameError } from './errors.js';
import { distanceMeters } from './geo.js';

export function validateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH)
    throw new GameError(`Choose a name between 1 and ${NAME_MAX_LENGTH} characters.`);
  return trimmed;
}

const formatClock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// One lobby and the rounds played in it.
// phase: 'lobby' (gathering players) → 'playing' → 'ended' → back to 'lobby'.
export class Game {
  constructor({ code = null, radius = ZONE_RADIUS_M.default, maxPlayers = SONAR.slots, now = Date.now, pickIndex = randomInt } = {}) {
    this.code = code;
    this.radius = radius;
    this.maxPlayers = maxPlayers;
    this.now = now;
    this.pickIndex = pickIndex;   // pickIndex(n) → 0..n-1, chooses the impostor
    this.players = new Map();     // player id → player
    this.sessions = new Map();    // session token → player id
    this.hostId = null;
    this.clearRound();
  }

  // ---------- helpers ----------

  list() {
    return [...this.players.values()];
  }

  isPresent(player) {
    return this.now() - player.lastSeen < PLAYER_GONE_MS;
  }

  hasSession(player) {
    return [...this.sessions.values()].includes(player.id);
  }

  hasFreshLocation(player, maxAge = LOCATION_MAX_AGE_MS) {
    return !!player.location && this.now() - player.location.recordedAt <= maxAge;
  }

  clearRound() {
    this.phase = 'lobby';
    this.zone = null;
    this.result = null;
    this.endsAt = null;
    this.lastKillAt = null;
  }

  // Removes a player and their sessions; hands the host role on if needed.
  remove(player) {
    this.players.delete(player.id);
    this.dropSessions(player);
  }

  dropSessions(player) {
    for (const [token, id] of this.sessions) if (id === player.id) this.sessions.delete(token);
    if (this.hostId === player.id) this.hostId = this.pickHost({ presentOnly: false });
  }

  // The most recently seen player who still has the app open.
  pickHost({ presentOnly }) {
    const candidates = this.list()
      .filter(p => this.hasSession(p) && (!presentOnly || this.isPresent(p)))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return candidates[0]?.id ?? null;
  }

  lowestFreeSlot() {
    const used = new Set(this.list().map(p => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    return slot;
  }

  // ---------- self-healing (runs before every request) ----------

  maintain() {
    const now = this.now();

    // Everyone left mid-round or after it: empty the game (Lobbies then deletes it).
    if (this.phase !== 'lobby' && this.players.size && !this.list().some(p => this.isPresent(p))) {
      this.players.clear();
      this.sessions.clear();
      this.hostId = null;
      this.clearRound();
      return;
    }

    if (this.phase === 'ended' && now - this.result.endedAt >= ENDED_RETURN_TO_LOBBY_MS) this.backToLobby();

    if (this.phase === 'lobby')
      for (const p of this.list()) if (now - p.lastSeen >= LOBBY_IDLE_DROP_MS) this.remove(p);

    const host = this.players.get(this.hostId);
    if (!host || !this.isPresent(host)) this.hostId = this.pickHost({ presentOnly: true }) ?? this.hostId;
  }

  // ---------- joining ----------

  join(rawName) {
    this.maintain();
    if (this.phase === 'playing') {
      const secondsLeft = Math.max(0, Math.ceil((this.endsAt - this.now()) / 1000));
      throw new GameError(`A round is in progress (${formatClock(secondsLeft)} left). Try again when it ends.`, 409);
    }
    if (this.phase === 'ended') throw new GameError('A round just ended. The lobby opens again in a moment.', 409);

    const name = validateName(rawName);
    if (this.players.size >= this.maxPlayers) throw new GameError(`The lobby is full (${this.maxPlayers} players max).`, 409);
    if (this.list().some(p => p.name.toLowerCase() === name.toLowerCase())) throw new GameError('That name is already taken.', 409);

    const player = {
      id: randomUUID(),
      name,
      slot: this.lowestFreeSlot(),   // = this player's sonar frequency
      role: null,                    // 'impostor' | 'regular' once a round starts
      alive: true,
      soundReady: false,
      location: null,                // { latitude, longitude, accuracy, recordedAt }
      lastSeen: this.now(),
      snapshot: null,                // the map this player is currently allowed to see
      nextUpdateAt: null,
      gateUntil: 0,
      diedAt: null,
      killedBy: null
    };
    const token = randomBytes(32).toString('hex');
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

  // ---------- player updates ----------

  setSound(player, ready) {
    player.soundReady = ready === true;
  }

  updateLocation(player, body) {
    const { latitude, longitude, accuracy } = body ?? {};
    const valid = [latitude, longitude, accuracy].every(Number.isFinite)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && accuracy >= 0 && accuracy <= 100_000;
    if (!valid) throw new GameError('Invalid coordinates or accuracy.');
    player.location = { latitude, longitude, accuracy, recordedAt: this.now() };
  }

  // ---------- round ----------

  start(player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start the game.', 403);
    if (this.phase !== 'lobby') throw new GameError('The game has already started.', 409);
    if (this.players.size < 2) throw new GameError('At least two players are required.', 409);
    if (!this.hasFreshLocation(player, START_LOCATION_MAX_AGE_MS)) throw new GameError('Get a fresh location before starting.', 409);

    this.zone = { latitude: player.location.latitude, longitude: player.location.longitude, radius: this.radius };
    this.phase = 'playing';
    this.endsAt = this.now() + ROUND_DURATION_MS;
    this.lastKillAt = null;

    const players = this.list();
    const impostorIndex = this.pickIndex(players.length);
    players.forEach((p, i) => {
      p.role = i === impostorIndex ? 'impostor' : 'regular';
      p.alive = true;
      this.refreshSnapshot(p);
    });
  }

  kill(killer, targetId) {
    this.checkEnd();
    if (this.phase !== 'playing') throw new GameError('The game is not running.', 409);
    if (killer.role !== 'impostor') throw new GameError('Only the impostor can kill.', 403);
    if (!killer.alive) throw new GameError('You are out of the game.', 403);

    const target = this.players.get(targetId);
    if (!target || target === killer) throw new GameError('Unknown target.', 404);
    if (!target.alive) throw new GameError('That player is already out.', 409);

    const now = this.now();
    const cooldownLeft = this.lastKillAt === null ? 0 : KILL_COOLDOWN_MS - (now - this.lastKillAt);
    if (cooldownLeft > 0) throw new GameError(`Kill cooling down (${Math.ceil(cooldownLeft / 1000)} s).`, 429);

    const bothFresh = this.hasFreshLocation(killer) && this.hasFreshLocation(target);
    if (bothFresh && distanceMeters(killer.location, target.location) > KILL_MAX_DISTANCE_M)
      throw new GameError('Target is too far away.', 409);

    target.alive = false;
    target.diedAt = now;
    target.killedBy = killer.id;
    this.lastKillAt = now;
    this.checkEnd();
  }

  // Impostor wins when at most one regular is left (or none, with two players);
  // the crew wins if they last until the timer runs out.
  checkEnd() {
    if (this.phase !== 'playing') return;
    const regulars = this.list().filter(p => p.role === 'regular');
    const regularsAlive = regulars.filter(p => p.alive).length;

    if (regularsAlive === 0 || (regulars.length > 1 && regularsAlive <= 1)) this.finish('impostor', 'The impostor took out the crew.');
    else if (this.now() >= this.endsAt) this.finish('regular', 'Time ran out – the crew survived.');
  }

  finish(winner, reason) {
    const impostor = this.list().find(p => p.role === 'impostor');
    this.phase = 'ended';
    this.result = { winner, reason, impostorId: impostor.id, impostorName: impostor.name, endedAt: this.now() };
  }

  // Host starts a new round with the same lobby.
  reset(player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start a new round.', 403);
    if (this.phase !== 'ended') throw new GameError('The game is still running.', 409);
    this.backToLobby();
  }

  backToLobby() {
    for (const p of this.list()) if (!this.hasSession(p) || !this.isPresent(p)) this.remove(p);
    this.clearRound();
    for (const p of this.list())
      Object.assign(p, { role: null, alive: true, snapshot: null, nextUpdateAt: null, diedAt: null, killedBy: null });
  }

  // Leave before the round starts.
  leave(player) {
    if (this.phase !== 'lobby') throw new GameError('Players cannot leave the roster after the game starts.', 409);
    this.remove(player);
  }

  // Quit at any time. Mid-round the player counts as out; if the impostor quits, the crew wins.
  quit(player) {
    if (this.phase !== 'playing') {
      this.remove(player);
      return;
    }
    player.alive = false;
    player.diedAt = this.now();
    this.dropSessions(player);
    if (player.role === 'impostor') this.finish('regular', 'The impostor quit.');
    else this.checkEnd();
  }

  // ---------- what each player may see ----------

  // Positions are handed out as snapshots: live for the impostor, every few seconds for the crew.
  refreshSnapshot(player) {
    const now = this.now();
    player.snapshot = this.list().filter(p => p.alive).map(p => ({
      id: p.id,
      location: this.hasFreshLocation(p) ? { ...p.location } : null
    }));
    player.nextUpdateAt = now + (player.role === 'impostor' ? IMPOSTOR_MAP_INTERVAL_MS : CREW_MAP_INTERVAL_MS);
  }

  // Should this phone run its sonar? Only while another living player is close on GPS.
  // Role-blind on purpose: a phone switching on must not reveal who is near.
  // Returns the reasons too, for the ?debug=1 readout.
  sonarGate(player) {
    const now = this.now();
    const gate = { on: false, why: 'not playing', me: null, nearest: null };
    if (this.phase !== 'playing' || !player.alive) return gate;

    const describe = p => p.location
      ? { acc: Math.round(p.location.accuracy), age: Math.round((now - p.location.recordedAt) / 1000) }
      : null;
    gate.me = describe(player);

    let close = false;
    const markClose = why => { if (!close) gate.why = why; close = true; };
    if (!this.hasFreshLocation(player)) markClose('my GPS stale');   // fail open

    for (const other of this.list()) {
      if (other === player || !other.alive) continue;
      if (!this.hasFreshLocation(other)) { markClose('their GPS stale'); continue; }
      if (!this.hasFreshLocation(player)) continue;

      const meters = distanceMeters(player.location, other.location);
      if (!gate.nearest || meters < gate.nearest.m) gate.nearest = { m: Math.round(meters), ...describe(other) };
      const slack = Math.min(SONAR_GATE_SLACK_M, (player.location.accuracy + other.location.accuracy) / 2);
      if (meters <= SONAR_GATE_M + slack) markClose('gps close');
    }

    if (close) player.gateUntil = now + SONAR_GATE_HOLD_MS;
    else if (now < player.gateUntil) { close = true; gate.why = 'hold'; }
    else gate.why = 'nobody close';

    gate.on = close;
    return gate;
  }

  // Everything one player's phone needs. Never includes other players' roles.
  view(player, { debug = false } = {}) {
    this.checkEnd();
    if (this.phase === 'playing' && this.now() >= player.nextUpdateAt) this.refreshSnapshot(player);

    const gate = this.sonarGate(player);
    const killer = player.killedBy && this.players.get(player.killedBy);
    const isImpostor = player.role === 'impostor';

    return {
      phase: this.phase,
      serverTime: this.now(),
      hostId: this.hostId,
      lobby: { code: this.code, radius: this.radius, maxPlayers: this.maxPlayers },
      self: { id: player.id, name: player.name, slot: player.slot, role: player.role, alive: player.alive },
      // Who is out is public (like finding a body); who did it stays secret until the end.
      players: this.list().map(p => ({ id: p.id, name: p.name, slot: p.slot, alive: p.alive, sound: p.soundReady })),
      sonar: SONAR,
      sonarOn: gate.on,
      ...(debug ? { gate } : {}),
      zone: this.zone,
      endsAt: this.endsAt,
      killCooldownUntil: isImpostor && this.lastKillAt !== null ? this.lastKillAt + KILL_COOLDOWN_MS : null,
      result: this.result && { ...this.result, killedByName: killer ? killer.name : null },
      positions: player.snapshot ?? [],
      nextUpdateAt: player.nextUpdateAt
    };
  }
}

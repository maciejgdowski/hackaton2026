import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { GameResult, GameView, LocationFix, Phase, Position, Role, SonarGate, Zone } from '@oos/shared';
import {
  CREW_MAP_INTERVAL_MS, ENDED_RETURN_TO_LOBBY_MS, IMPOSTOR_MAP_INTERVAL_MS, KILL_COOLDOWN_MS,
  KILL_MAX_DISTANCE_M, LOBBY_IDLE_DROP_MS, LOCATION_MAX_AGE_MS, NAME_MAX_LENGTH, PLAYER_GONE_MS,
  ROUND_DURATION_MS, SONAR, SONAR_GATE_HOLD_MS, SONAR_GATE_M, SONAR_GATE_SLACK_M, START_LOCATION_MAX_AGE_MS,
  ZONE_RADIUS_M
} from './config.ts';
import { GameError } from './errors.ts';
import { distanceMeters } from './geo.ts';

export function validateName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > NAME_MAX_LENGTH)
    throw new GameError(`Choose a name between 1 and ${NAME_MAX_LENGTH} characters.`);
  return trimmed;
}

const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

export interface Player {
  id: string;
  name: string;
  slot: number;                  // = this player's sonar frequency
  role: Role | null;             // set when a round starts
  alive: boolean;
  soundReady: boolean;
  location: (LocationFix & { recordedAt: number }) | null;
  lastSeen: number;
  snapshot: Position[] | null;   // the map this player is currently allowed to see
  nextUpdateAt: number | null;
  gateUntil: number;
  diedAt: number | null;
  killedBy: string | null;
}

interface GameOptions {
  code?: string | null;
  radius?: number;
  maxPlayers?: number;
  now?: () => number;
  pickIndex?: (n: number) => number;
}

// One lobby and the rounds played in it.
// phase: 'lobby' (gathering players) → 'playing' → 'ended' → back to 'lobby'.
export class Game {
  code: string | null;
  radius: number;
  maxPlayers: number;
  now: () => number;
  pickIndex: (n: number) => number;
  players = new Map<string, Player>();   // player id → player
  sessions = new Map<string, string>();  // session token → player id
  hostId: string | null = null;
  phase: Phase = 'lobby';
  zone: Zone | null = null;
  result: Omit<GameResult, 'killedByName'> | null = null;
  endsAt: number | null = null;
  lastKillAt: number | null = null;

  constructor({ code = null, radius = ZONE_RADIUS_M.default, maxPlayers = SONAR.slots, now = Date.now, pickIndex = randomInt }: GameOptions = {}) {
    this.code = code;
    this.radius = radius;
    this.maxPlayers = maxPlayers;
    this.now = now;
    this.pickIndex = pickIndex;   // pickIndex(n) → 0..n-1, chooses the impostor
  }

  // ---------- helpers ----------

  list(): Player[] {
    return [...this.players.values()];
  }

  isPresent(player: Player): boolean {
    return this.now() - player.lastSeen < PLAYER_GONE_MS;
  }

  hasSession(player: Player): boolean {
    return [...this.sessions.values()].includes(player.id);
  }

  hasFreshLocation(player: Player, maxAge = LOCATION_MAX_AGE_MS): boolean {
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
  remove(player: Player) {
    this.players.delete(player.id);
    this.dropSessions(player);
  }

  dropSessions(player: Player) {
    for (const [token, id] of this.sessions) if (id === player.id) this.sessions.delete(token);
    if (this.hostId === player.id) this.hostId = this.pickHost({ presentOnly: false });
  }

  // The most recently seen player who still has the app open.
  pickHost({ presentOnly }: { presentOnly: boolean }): string | null {
    const candidates = this.list()
      .filter(p => this.hasSession(p) && (!presentOnly || this.isPresent(p)))
      .sort((a, b) => b.lastSeen - a.lastSeen);
    return candidates[0]?.id ?? null;
  }

  lowestFreeSlot(): number {
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

    if (this.phase === 'ended' && this.result && now - this.result.endedAt >= ENDED_RETURN_TO_LOBBY_MS) this.backToLobby();

    if (this.phase === 'lobby')
      for (const p of this.list()) if (now - p.lastSeen >= LOBBY_IDLE_DROP_MS) this.remove(p);

    const host = this.hostId ? this.players.get(this.hostId) : undefined;
    if (!host || !this.isPresent(host)) this.hostId = this.pickHost({ presentOnly: true }) ?? this.hostId;
  }

  // ---------- joining ----------

  join(rawName: unknown): string {
    this.maintain();
    if (this.phase === 'playing') {
      const secondsLeft = Math.max(0, Math.ceil(((this.endsAt ?? 0) - this.now()) / 1000));
      throw new GameError(`A round is in progress (${formatClock(secondsLeft)} left). Try again when it ends.`, 409);
    }
    if (this.phase === 'ended') throw new GameError('A round just ended. The lobby opens again in a moment.', 409);

    const name = validateName(rawName);
    if (this.players.size >= this.maxPlayers) throw new GameError(`The lobby is full (${this.maxPlayers} players max).`, 409);
    if (this.list().some(p => p.name.toLowerCase() === name.toLowerCase())) throw new GameError('That name is already taken.', 409);

    const player: Player = {
      id: randomUUID(),
      name,
      slot: this.lowestFreeSlot(),
      role: null,
      alive: true,
      soundReady: false,
      location: null,
      lastSeen: this.now(),
      snapshot: null,
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

  authenticate(token: string): Player {
    this.maintain();
    const id = this.sessions.get(token);
    const player = id ? this.players.get(id) : undefined;
    if (!player) throw new GameError('Join the game to continue.', 401);
    player.lastSeen = this.now();
    return player;
  }

  // ---------- player updates ----------

  setSound(player: Player, ready: unknown) {
    player.soundReady = ready === true;
  }

  updateLocation(player: Player, body: unknown) {
    const { latitude, longitude, accuracy } = (body ?? {}) as Record<string, unknown>;
    const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const valid = isNumber(latitude) && isNumber(longitude) && isNumber(accuracy)
      && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && accuracy >= 0 && accuracy <= 100_000;
    if (!valid) throw new GameError('Invalid coordinates or accuracy.');
    player.location = { latitude, longitude, accuracy, recordedAt: this.now() };
  }

  // ---------- round ----------

  start(player: Player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start the game.', 403);
    if (this.phase !== 'lobby') throw new GameError('The game has already started.', 409);
    if (this.players.size < 2) throw new GameError('At least two players are required.', 409);
    if (!this.hasFreshLocation(player, START_LOCATION_MAX_AGE_MS)) throw new GameError('Get a fresh location before starting.', 409);

    const { latitude, longitude } = player.location!;
    this.zone = { latitude, longitude, radius: this.radius };
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

  kill(killer: Player, targetId: unknown) {
    this.checkEnd();
    if (this.phase !== 'playing') throw new GameError('The game is not running.', 409);
    if (killer.role !== 'impostor') throw new GameError('Only the impostor can kill.', 403);
    if (!killer.alive) throw new GameError('You are out of the game.', 403);

    const target = typeof targetId === 'string' ? this.players.get(targetId) : undefined;
    if (!target || target === killer) throw new GameError('Unknown target.', 404);
    if (!target.alive) throw new GameError('That player is already out.', 409);

    const now = this.now();
    const cooldownLeft = this.lastKillAt === null ? 0 : KILL_COOLDOWN_MS - (now - this.lastKillAt);
    if (cooldownLeft > 0) throw new GameError(`Kill cooling down (${Math.ceil(cooldownLeft / 1000)} s).`, 429);

    const bothFresh = this.hasFreshLocation(killer) && this.hasFreshLocation(target);
    if (bothFresh && distanceMeters(killer.location!, target.location!) > KILL_MAX_DISTANCE_M)
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
    else if (this.endsAt !== null && this.now() >= this.endsAt) this.finish('regular', 'Time ran out – the crew survived.');
  }

  finish(winner: Role, reason: string) {
    const impostor = this.list().find(p => p.role === 'impostor')!;
    this.phase = 'ended';
    this.result = { winner, reason, impostorId: impostor.id, impostorName: impostor.name, endedAt: this.now() };
  }

  // Host starts a new round with the same lobby.
  reset(player: Player) {
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
  leave(player: Player) {
    if (this.phase !== 'lobby') throw new GameError('Players cannot leave the roster after the game starts.', 409);
    this.remove(player);
  }

  // Quit at any time. Mid-round the player counts as out; if the impostor quits, the crew wins.
  quit(player: Player) {
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
  refreshSnapshot(player: Player) {
    const now = this.now();
    player.snapshot = this.list().filter(p => p.alive).map(p => ({
      id: p.id,
      location: p.location && this.hasFreshLocation(p) ? { ...p.location } : null
    }));
    player.nextUpdateAt = now + (player.role === 'impostor' ? IMPOSTOR_MAP_INTERVAL_MS : CREW_MAP_INTERVAL_MS);
  }

  // Should this phone run its sonar? Only while another living player is close on GPS.
  // Role-blind on purpose: a phone switching on must not reveal who is near.
  // Returns the reasons too, for the ?debug=1 readout.
  sonarGate(player: Player): SonarGate {
    const now = this.now();
    const gate: SonarGate = { on: false, why: 'not playing', me: null, nearest: null };
    if (this.phase !== 'playing' || !player.alive) return gate;

    const describe = (p: Player) => p.location
      ? { acc: Math.round(p.location.accuracy), age: Math.round((now - p.location.recordedAt) / 1000) }
      : null;
    gate.me = describe(player);

    let close = false;
    const markClose = (why: string) => { if (!close) gate.why = why; close = true; };
    if (!this.hasFreshLocation(player)) markClose('my GPS stale');   // fail open

    for (const other of this.list()) {
      if (other === player || !other.alive) continue;
      if (!this.hasFreshLocation(other)) { markClose('their GPS stale'); continue; }
      if (!this.hasFreshLocation(player)) continue;

      const meters = distanceMeters(player.location!, other.location!);
      if (!gate.nearest || meters < gate.nearest.m) gate.nearest = { m: Math.round(meters), ...describe(other)! };
      const slack = Math.min(SONAR_GATE_SLACK_M, (player.location!.accuracy + other.location!.accuracy) / 2);
      if (meters <= SONAR_GATE_M + slack) markClose('gps close');
    }

    if (close) player.gateUntil = now + SONAR_GATE_HOLD_MS;
    else if (now < player.gateUntil) { close = true; gate.why = 'hold'; }
    else gate.why = 'nobody close';

    gate.on = close;
    return gate;
  }

  // Everything one player's phone needs. Never includes other players' roles.
  view(player: Player, { debug = false } = {}): GameView {
    this.checkEnd();
    if (this.phase === 'playing' && this.now() >= (player.nextUpdateAt ?? 0)) this.refreshSnapshot(player);

    const gate = this.sonarGate(player);
    const killer = player.killedBy ? this.players.get(player.killedBy) : undefined;
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

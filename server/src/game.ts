// Game rules: roles, sonar slots, GPS, kills and win conditions.
// The lobby routes in app.ts call these; nothing in here knows about HTTP or sockets.

export type Role = "hunter" | "runner";
export type Phase = "lobby" | "playing" | "ended";

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface PlayerLocation extends Coordinates {
  accuracy: number;
  recordedAt: number;
}

export interface GamePlayer {
  name: string;
  role: Role;
  slot: number; // sonar frequency = SONAR.base + slot * SONAR.spacing
  alive: boolean;
  location: PlayerLocation | null;
  diedAt: number | null;
  killedBy: string | null;
  gateUntil: number; // sonar stays on until this time after the last "close on GPS"
  lastScanAt: number | null;
  contacts: string[]; // runners this runner exchanged data with (they see each other on the map)
}

export interface GameResult {
  winner: Role;
  reason: string;
  endedAt: number;
}

export interface GameState {
  startedAt: number;
  endsAt: number;
  zone: { center: Coordinates; radius: number }; // radius in metres
  players: Map<string, GamePlayer>; // UUID -> player
  clue: { at: number; positions: { id: string; lat: number; lng: number }[] } | null; // last snapshot hunters got
  result: GameResult | null;
}

// ---------- tuning ----------

export const ROUND_DURATION_MS = 10 * 60_000;
export const SCAN_COOLDOWN_MS = 30_000; // after every scan, for hunters and runners alike
export const KILL_MAX_DISTANCE_M = 50; // the 2 m check is the sonar's job; GPS only rejects the impossible
export const LOCATION_MAX_AGE_MS = 30_000; // older fixes count as "no GPS"

export const ZONE_RADIUS_M = { small: 150, medium: 300, large: 600 } as const;

// How often hunters get a fresh "clue": the runners' positions.
export const CLUE_INTERVAL_MS = { easy: 15_000, medium: 30_000, hard: 60_000 } as const;

// Sonar: every player gets one slot = one tone (17.8–19.9 kHz for 8 slots).
// Phones only play and listen while another living player is this close on GPS.
// Phone-to-phone GPS is often 15–30 m off, so the gate is generous and fails open without GPS.
export const SONAR = { base: 17_800, spacing: 300, slots: 8 };
export const SONAR_GATE_M = 30;
export const SONAR_GATE_SLACK_M = 10; // + up to this much for reported GPS inaccuracy
export const SONAR_GATE_HOLD_MS = 10_000; // stay on this long after the last "close"

// ---------- helpers ----------

const EARTH_RADIUS_M = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

function hasFreshLocation(player: GamePlayer, now: number): boolean {
  return !!player.location && now - player.location.recordedAt <= LOCATION_MAX_AGE_MS;
}

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- round ----------

// members: lobby members in join order (UUID -> username). Picks `hunters` random hunters.
export function createGame(
  members: Map<string, string>,
  props: { radius: keyof typeof ZONE_RADIUS_M; center: Coordinates; hunters: number },
  now = Date.now(),
): GameState {
  const ids = Array.from(members.keys());
  if (ids.length < 2) throw new GameError("At least two players are required.", 409);
  if (ids.length > SONAR.slots) throw new GameError(`At most ${SONAR.slots} players can play.`, 409);
  if (props.hunters >= ids.length) throw new GameError("There must be at least one runner.", 409);

  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const hunterIds = new Set(shuffled.slice(0, props.hunters));

  const players = new Map<string, GamePlayer>();
  ids.forEach((id, slot) => {
    players.set(id, {
      name: members.get(id) ?? "Player",
      role: hunterIds.has(id) ? "hunter" : "runner",
      slot,
      alive: true,
      location: null,
      diedAt: null,
      killedBy: null,
      gateUntil: 0,
      lastScanAt: null,
      contacts: [],
    });
  });

  return {
    startedAt: now,
    endsAt: now + ROUND_DURATION_MS,
    zone: { center: props.center, radius: ZONE_RADIUS_M[props.radius] },
    players,
    clue: null,
    result: null,
  };
}

export function updateLocation(game: GameState, userId: string, body: unknown, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player) throw new GameError("You are not in this game.", 403);

  const { lat, lng, accuracy } = (body ?? {}) as Record<string, unknown>;
  const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  if (!isNumber(lat) || !isNumber(lng) || !isNumber(accuracy)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180 || accuracy < 0 || accuracy > 100_000) {
    throw new GameError("Invalid coordinates or accuracy.");
  }
  player.location = { lat, lng, accuracy, recordedAt: now };
}

// Everyone has the same "Scan" button, so nobody can tell roles apart by looking at a screen.
// The phone only allows a scan once the sonar says the target is within ~2 m; the server checks the rest.
//   hunter -> runner: caught (out of the game)
//   runner -> runner: exchange data (from now on they see each other on the map)
//   anything else:    nothing happens (still costs the cooldown)
export type ScanResult = "caught" | "linked" | "already linked" | "nothing";

export function scan(game: GameState, scannerId: string, targetId: unknown, now = Date.now()): { result: ScanResult; name: string } {
  checkEnd(game, now);
  if (game.result) throw new GameError("The game is over.", 409);

  const scanner = game.players.get(scannerId);
  if (!scanner) throw new GameError("You are not in this game.", 403);
  if (!scanner.alive) throw new GameError("You are out of the game.", 403);

  const target = typeof targetId === "string" ? game.players.get(targetId) : undefined;
  if (!target || target === scanner) throw new GameError("Unknown target.", 404);
  if (!target.alive) throw new GameError("That player is already out.", 409);

  const cooldownLeft = scanner.lastScanAt === null ? 0 : SCAN_COOLDOWN_MS - (now - scanner.lastScanAt);
  if (cooldownLeft > 0) throw new GameError(`Scanner recharging (${Math.ceil(cooldownLeft / 1000)} s).`, 429);

  if (hasFreshLocation(scanner, now) && hasFreshLocation(target, now)
    && distanceMeters(scanner.location!, target.location!) > KILL_MAX_DISTANCE_M) {
    throw new GameError("Target is too far away.", 409);
  }

  if (scanner.role === "runner" && target.role === "runner") {
    if (scanner.contacts.includes(targetId as string)) return { result: "already linked", name: target.name };
    scanner.contacts.push(targetId as string);
    target.contacts.push(scannerId);
    scanner.lastScanAt = now;
    return { result: "linked", name: target.name };
  }

  scanner.lastScanAt = now;
  if (scanner.role === "hunter" && target.role === "runner") {
    target.alive = false;
    target.diedAt = now;
    target.killedBy = scannerId;
    checkEnd(game, now);
    return { result: "caught", name: target.name };
  }
  return { result: "nothing", name: target.name };
}

// Leaving mid-round counts as being out.
export function removePlayer(game: GameState, userId: string, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player || !player.alive) return;
  player.alive = false;
  player.diedAt = now;
  checkEnd(game, now);
}

// Hunters win when every runner is out; runners win if they last until the timer runs out
// (or every hunter has left).
export function checkEnd(game: GameState, now = Date.now()): boolean {
  if (game.result) return false;
  const players = Array.from(game.players.values());
  const runnersAlive = players.some((p) => p.role === "runner" && p.alive);
  const huntersAlive = players.some((p) => p.role === "hunter" && p.alive);

  let result: Omit<GameResult, "endedAt"> | null = null;
  if (!runnersAlive) result = { winner: "hunter", reason: "The hunters caught every runner." };
  else if (!huntersAlive) result = { winner: "runner", reason: "Every hunter left the game." };
  else if (now >= game.endsAt) result = { winner: "runner", reason: "Time ran out – the runners survived." };

  if (!result) return false;
  game.result = { ...result, endedAt: now };
  return true;
}

// ---------- sonar ----------

// Should this phone run its sonar? Only while another living player is close on GPS.
// Role-blind on purpose: a phone switching on must not reveal who is near.
export function sonarGate(game: GameState, userId: string, now = Date.now()): boolean {
  const player = game.players.get(userId);
  if (!player || !player.alive || game.result) return false;

  let close = !hasFreshLocation(player, now); // fail open without my GPS
  for (const [otherId, other] of game.players) {
    if (close) break;
    if (otherId === userId || !other.alive) continue;
    if (!hasFreshLocation(other, now)) { close = true; break; } // fail open without their GPS
    const meters = distanceMeters(player.location!, other.location!);
    const slack = Math.min(SONAR_GATE_SLACK_M, (player.location!.accuracy + other.location!.accuracy) / 2);
    if (meters <= SONAR_GATE_M + slack) close = true;
  }

  if (close) player.gateUntil = now + SONAR_GATE_HOLD_MS;
  return close || now < player.gateUntil;
}

// ---------- what one player may see ----------

// Never includes other players' roles (until the game is over) or live positions.
// Hunters get the runners' positions as a "clue" every CLUE_INTERVAL_MS (set by the lobby's clues).
export function serializeGame(
  game: GameState,
  userId: string,
  clues: keyof typeof CLUE_INTERVAL_MS,
  now = Date.now(),
) {
  const self = game.players.get(userId);
  if (!self) return null;

  const interval = CLUE_INTERVAL_MS[clues];
  if (!game.result && (!game.clue || now - game.clue.at >= interval)) {
    game.clue = {
      at: now,
      positions: Array.from(game.players, ([id, p]) => ({ id, p }))
        .filter(({ p }) => p.role === "runner" && p.alive && p.location && now - p.location.recordedAt <= LOCATION_MAX_AGE_MS)
        .map(({ id, p }) => ({ id, lat: p.location!.lat, lng: p.location!.lng })),
    };
  }

  const killer = self.killedBy ? game.players.get(self.killedBy) : undefined;

  return {
    phase: (game.result ? "ended" : "playing") as Phase,
    serverTime: now,
    endsAt: game.endsAt,
    zone: game.zone,
    self: {
      id: userId,
      name: self.name,
      role: self.role,
      slot: self.slot,
      alive: self.alive,
      killedByName: game.result && killer ? killer.name : null,
    },
    // Who is out is public; roles stay secret until the end.
    players: Array.from(game.players, ([id, p]) => ({
      id,
      name: p.name,
      slot: p.slot,
      alive: p.alive,
      role: game.result || id === userId ? p.role : null,
    })),
    sonar: SONAR,
    sonarOn: sonarGate(game, userId, now),
    scanCooldownUntil: self.lastScanAt !== null ? self.lastScanAt + SCAN_COOLDOWN_MS : null,
    // runners you exchanged data with: their live position
    contacts: self.contacts
      .map((id) => ({ id, p: game.players.get(id) }))
      .filter(({ p }) => p && p.alive && p.location && now - p.location.recordedAt <= LOCATION_MAX_AGE_MS)
      .map(({ id, p }) => ({ id, name: p!.name, lat: p!.location!.lat, lng: p!.location!.lng })),
    clue: self.role === "hunter" && game.clue && !game.result
      ? { ...game.clue, nextAt: game.clue.at + interval }
      : null,
    result: game.result,
  };
}

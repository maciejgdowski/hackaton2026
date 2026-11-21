// Game rules: roles, sonar slots, GPS, map pings, kills and win conditions.
// The lobby routes in app.ts call these; nothing in here knows about HTTP or sockets.

export type Role = "killer" | "seeker";
export type Status = "waiting" | "playing" | "finished";

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
  pingInterval: number; // seekers see everyone this often (ms), set by the map size
  ping: { at: number; positions: Map<string, Coordinates> } | null; // last snapshot the seekers got (UUID -> where)
  result: GameResult | null;
}

// ---------- tuning ----------

export const ROUND_DURATION_MS = 10 * 60_000;
export const SCAN_COOLDOWN_MS = 30_000; // after every scan, for hunters and runners alike
export const KILL_MAX_DISTANCE_M = 50; // the 2 m check is the sonar's job; GPS only rejects the impossible
export const LOCATION_MAX_AGE_MS = 30_000; // older fixes count as "no GPS"

export const ZONE_RADIUS_M = { small: 150, medium: 300, large: 600 } as const;

// How often seekers see everyone on the map (killers see everyone all the time).
export const PING_INTERVAL_MS = { small: 20_000, medium: 40_000, large: 60_000 } as const;
export const FIRST_PING_MS = 5_000; // the first ping waits until the role card is gone and phones have GPS

// Sonar: every player gets one slot = one tone (17.8–19.9 kHz for 8 slots).
// Phones only play and listen while another living player is this close on GPS.
// Phone GPS is often 5–15 m off, so the gate gets a little slack and fails open without GPS.
export const SONAR = { base: 17_800, spacing: 300, slots: 8 };
export const SONAR_GATE_M = 15;
export const SONAR_GATE_SLACK_M = 5; // + up to this much for reported GPS inaccuracy
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

// members: lobby members in join order (UUID -> username). Picks `hunters` random killers.
export function createGame(
  members: Map<string, string>,
  props: { radius: keyof typeof ZONE_RADIUS_M; center: Coordinates; hunters: number },
  now = Date.now(),
): GameState {
  const ids = Array.from(members.keys());
  if (ids.length < 2) throw new GameError("At least two players are required.", 409);
  if (ids.length > SONAR.slots) throw new GameError(`At most ${SONAR.slots} players can play.`, 409);
  if (props.hunters >= ids.length) throw new GameError("There must be at least one seeker.", 409);

  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const killerIds = new Set(shuffled.slice(0, props.hunters));

  const players = new Map<string, GamePlayer>();
  ids.forEach((id, slot) => {
    players.set(id, {
      name: members.get(id) ?? "Player",
      role: killerIds.has(id) ? "killer" : "seeker",
      slot,
      alive: true,
      location: null,
      diedAt: null,
      killedBy: null,
      gateUntil: 0,
      lastScanAt: null,
    });
  });

  return {
    startedAt: now,
    endsAt: now + ROUND_DURATION_MS,
    zone: { center: props.center, radius: ZONE_RADIUS_M[props.radius] },
    players,
    pingInterval: PING_INTERVAL_MS[props.radius],
    ping: null,
    result: null,
  };
}

// location is already checked by isLocation() in app.ts
export function updateLocation(game: GameState, userId: string, location: { lat: number; lng: number; accuracy: number }, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player) return;
  player.location = { lat: location.lat, lng: location.lng, accuracy: location.accuracy, recordedAt: now };
}

// Everyone has the same "Scan" button, so nobody can tell roles apart by looking at a screen.
// The phone only allows a scan once the sonar says the target is within ~2 m; the server checks the rest.
//   killer -> seeker: caught (out of the game)
//   seeker -> seeker: data transfer (see transferData, empty for now)
//   anything else:    nothing happens (still costs the cooldown)
export type ScanResult = "caught" | "transfer" | "nothing";

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

  scanner.lastScanAt = now;
  if (scanner.role === "seeker" && target.role === "seeker") {
    transferData(game, scannerId, targetId as string);
    return { result: "transfer", name: target.name };
  }
  if (scanner.role === "killer" && target.role === "seeker") {
    target.alive = false;
    target.diedAt = now;
    target.killedBy = scannerId;
    checkEnd(game, now);
    return { result: "caught", name: target.name };
  }
  return { result: "nothing", name: target.name };
}

// Two seekers met and scanned: exchange data. Coming later – nothing happens yet.
export function transferData(_game: GameState, _fromId: string, _toId: string) {
  // TODO: what seekers exchange (and what it unlocks) is not decided yet
}

// Leaving mid-round counts as being out.
export function removePlayer(game: GameState, userId: string, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player || !player.alive) return;
  player.alive = false;
  player.diedAt = now;
  checkEnd(game, now);
}

// Killers win when every seeker is out; seekers win if they last until the timer runs out
// (or every killer has left).
export function checkEnd(game: GameState, now = Date.now()): boolean {
  if (game.result) return false;
  const players = Array.from(game.players.values());
  const seekersAlive = players.some((p) => p.role === "seeker" && p.alive);
  const killersAlive = players.some((p) => p.role === "killer" && p.alive);

  let result: Omit<GameResult, "endedAt"> | null = null;
  if (!seekersAlive) result = { winner: "killer", reason: "The killers caught every seeker." };
  else if (!killersAlive) result = { winner: "seeker", reason: "Every killer left the game." };
  else if (now >= game.endsAt) result = { winner: "seeker", reason: "Time ran out – the seekers survived." };

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

// ---------- map ----------

// Where the other living players are right now (GPS fixes older than 30 s are left out).
// No ids, names or roles: just dots.
function livePositions(game: GameState, userId: string, now: number): Coordinates[] {
  const positions: Coordinates[] = [];
  for (const [id, p] of game.players) {
    if (id === userId || !p.alive || !hasFreshLocation(p, now)) continue;
    positions.push({ lat: p.location!.lat, lng: p.location!.lng });
  }
  return positions;
}

// Killers (and players who are out) see everyone live.
// Seekers see one shared snapshot of everyone, refreshed every pingInterval.
// Both get the same at / nextAt, so both screens fade and count down the same way.
function mapFor(game: GameState, userId: string, self: GamePlayer, now: number) {
  if (game.result) return null;

  const pingDue = game.ping
    ? now - game.ping.at >= game.pingInterval
    : now - game.startedAt >= FIRST_PING_MS;
  if (pingDue) {
    game.ping = { at: now, positions: new Map() };
    for (const [id, p] of game.players) {
      if (p.alive && hasFreshLocation(p, now)) {
        game.ping.positions.set(id, { lat: p.location!.lat, lng: p.location!.lng });
      }
    }
  }

  const at = game.ping ? game.ping.at : game.startedAt;
  const nextAt = game.ping ? game.ping.at + game.pingInterval : game.startedAt + FIRST_PING_MS;

  let positions: Coordinates[];
  if (self.role === "killer" || !self.alive) {
    positions = livePositions(game, userId, now);
  } else if (!game.ping) {
    positions = [];
  } else {
    positions = [];
    for (const [id, position] of game.ping.positions) {
      if (id !== userId) positions.push(position); // my own dot comes from my phone
    }
  }

  return { at, nextAt, positions };
}

// ---------- what one player may see ----------

// Never includes other players' roles (until the game is over).
export function serializeGame(game: GameState, userId: string, now = Date.now()) {
  const self = game.players.get(userId);
  if (!self) return null;

  const killer = self.killedBy ? game.players.get(self.killedBy) : undefined;

  return {
    status: (game.result ? "finished" : "playing") as Status,
    serverTime: now,
    startedAt: game.startedAt,
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
    seekersLeft: Array.from(game.players.values()).filter((p) => p.role === "seeker" && p.alive).length,
    sonar: SONAR,
    sonarOn: sonarGate(game, userId, now),
    scanCooldownUntil: self.lastScanAt !== null ? self.lastScanAt + SCAN_COOLDOWN_MS : null,
    map: mapFor(game, userId, self, now),
    result: game.result,
  };
}

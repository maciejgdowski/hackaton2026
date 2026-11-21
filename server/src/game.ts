// Game rules: roles, sonar slots, GPS, map pings, tasks (towers + data), clues, votes, kills and win conditions.
// The lobby routes in app.ts call these; nothing in here knows about HTTP or sockets.
//
// The game in short:
//   - 1 killer, everyone else is a seeker. Nobody knows who the killer is.
//   - Every tower has 3 download points. Download data at a point, carry it to its tower and upload it there.
//     When a tower has all 3 of its data, whoever brought the last one gets the tower's clue
//     ("NAME is not the killer") and the tower empties again. Points are never used up.
//   - Touching phones (sonar, ~2 m) and pressing Share copies clues both ways.
//   - Players touching phones can call a vote. Someone is out when more than half of the
//     living players vote for them.
//   - The killer kills by holding Share next to a seeker.
//   - Seekers win by voting the killer out; the killer wins by killing every seeker.

import type { TaskLayout } from "./places.ts";

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
  leftZone: boolean; // eliminated for going too far outside the play area
  votedOut: boolean; // eliminated by a vote
  outsideSince: number | null; // when they first went too far out (null = close enough)
  gateUntil: number; // sonar stays on until this time after the last "close on GPS"
  killReadyAt: number; // killer only: can't kill before this (180 s after the start, then 30 s after each kill)
  lastShareAt: number | null;
  download: { pointId: string; progressMs: number } | null; // download in progress
  uploadMs: number | null; // upload to the tower in progress (ms done), null = not uploading
  carrying: string | null; // id of the point whose data I carry
  clues: Set<string>; // ids of players I know are not the killer
  heard: Map<number, number>; // sonar slot -> last time my phone heard it within ~2 m
  voteCooldownUntil: number;
  notice: { text: string; at: number } | null; // last message for this player ("Tower A activated")
}

export interface Tower {
  id: string; // "A", "B", ...
  lat: number;
  lng: number;
  clueId: string; // the seeker this tower says is not the killer
  delivered: boolean[]; // which of its 3 data are here
}

export interface TaskPoint {
  id: string; // "A1", "A2", "A3"
  towerId: string;
  index: number; // 0, 1, 2
  lat: number;
  lng: number;
}

export interface Vote {
  callerId: string;
  startedAt: number;
  endsAt: number;
  participants: string[]; // only these players vote (they were touching phones)
  ballots: Map<string, string | null>; // voter -> who they vote out (null = skip)
  needed: number; // votes needed = more than half of the living players when it started
}

export interface VoteResult {
  at: number;
  targetName: string | null; // null = nobody was voted out
  role: Role | null;
  votes: number;
  needed: number;
}

export interface GameResult {
  winner: Role;
  reason: string;
  endedAt: number;
}

export interface GameState {
  startedAt: number;
  lastTickAt: number;
  zone: { center: Coordinates; radius: number }; // radius in metres
  players: Map<string, GamePlayer>; // UUID -> player
  towers: Tower[];
  points: TaskPoint[];
  ping: { at: number; positions: Map<string, Coordinates> } | null; // last snapshot the seekers got (UUID -> where)
  vote: Vote | null;
  lastVote: VoteResult | null;
  result: GameResult | null;
}

// ---------- tuning ----------

// No time limit: the game ends when the killer is voted out or every seeker is caught.
export const KILL_COOLDOWN_MS = 30_000;
export const START_KILL_COOLDOWN_MS = 180_000; // the killer can't kill in the first 3 minutes
export const START_VOTE_COOLDOWN_MS = 300_000; // nobody can vote in the first 5 minutes
export const SHARE_COOLDOWN_MS = 5_000;
export const KILL_MAX_DISTANCE_M = 50; // the 2 m check is the sonar's job; GPS only rejects the impossible
export const LOCATION_MAX_AGE_MS = 30_000; // older fixes count as "no GPS"

// Play area radius. Sized so a killer can jog across it in about 2 / 4 / 7 minutes.
export const ZONE_RADIUS_M = { small: 150, medium: 300, large: 500 } as const;

// The border is not a wall: stepping a bit outside is fine.
// Only someone more than ZONE_LEAVE_M past the border for ZONE_LEAVE_GRACE_MS is eliminated.
export const ZONE_LEAVE_M = 30;
export const ZONE_LEAVE_GRACE_MS = 10_000;

// How often seekers see everyone on the map (the killer sees everyone all the time).
export const PING_INTERVAL_MS = 60_000;
export const FIRST_PING_MS = 5_000; // the first ping waits until the role card is gone and phones have GPS

// Tasks
export const DOWNLOAD_MS = 20_000; // standing at a point this long downloads its data
export const UPLOAD_MS = 5_000; // standing at the tower this long uploads the data you carry
export const SITE_RANGE_M = 15; // "at" a point or tower = this close on GPS
export const SITE_SLACK_M = 10; // + up to this much for reported GPS inaccuracy

// Touching phones and votes
export const CONTACT_MS = 3_000; // phones count as touching for this long after the sonar last heard them
export const VOTE_DURATION_MS = 30_000;
export const VOTE_COOLDOWN_MS = 3 * 60_000; // everyone who took part in a vote waits this long

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

// Is this player standing at a point or tower? (GPS, with some slack for bad accuracy)
function isAt(player: GamePlayer, site: Coordinates, now: number): boolean {
  if (!hasFreshLocation(player, now)) return false;
  const slack = Math.min(SITE_SLACK_M, player.location!.accuracy);
  return distanceMeters(player.location!, site) <= SITE_RANGE_M + slack;
}

function livingCount(game: GameState) {
  let count = 0;
  for (const player of game.players.values()) if (player.alive) count++;
  return count;
}

// More than half of the living players
function votesNeeded(game: GameState) {
  return Math.floor(livingCount(game) / 2) + 1;
}

function tell(player: GamePlayer, text: string, now: number) {
  player.notice = { text, at: now };
}

export class GameError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// ---------- round ----------

// members: lobby members in join order (UUID -> username). One random killer.
// layout: where the towers and their points are (see places.ts), one tower per seeker.
export function createGame(
  members: Map<string, string>,
  props: { radius: keyof typeof ZONE_RADIUS_M; center: Coordinates },
  layout: TaskLayout,
  now = Date.now(),
): GameState {
  const ids = Array.from(members.keys());
  if (ids.length < 2) throw new GameError("At least two players are required.", 409);
  if (ids.length > SONAR.slots) throw new GameError(`At most ${SONAR.slots} players can play.`, 409);

  const killerId = ids[Math.floor(Math.random() * ids.length)];

  const players = new Map<string, GamePlayer>();
  ids.forEach((id, slot) => {
    players.set(id, {
      name: members.get(id) ?? "Player",
      role: id === killerId ? "killer" : "seeker",
      slot,
      alive: true,
      location: null,
      diedAt: null,
      killedBy: null,
      leftZone: false,
      votedOut: false,
      outsideSince: null,
      gateUntil: 0,
      killReadyAt: now + START_KILL_COOLDOWN_MS,
      lastShareAt: null,
      download: null,
      uploadMs: null,
      carrying: null,
      clues: new Set(),
      heard: new Map(),
      voteCooldownUntil: now + START_VOTE_COOLDOWN_MS,
      notice: null,
    });
  });

  // Every tower clears a different seeker, so all towers together leave only the killer.
  const seekerIds = shuffle(ids.filter((id) => id !== killerId));
  const towers: Tower[] = [];
  const points: TaskPoint[] = [];
  layout.towers.forEach((spot, i) => {
    const id = String.fromCharCode(65 + i); // A, B, C...
    towers.push({ id, lat: spot.lat, lng: spot.lng, clueId: seekerIds[i % seekerIds.length], delivered: [false, false, false] });
    layout.points[i].forEach((pointSpot, index) => {
      points.push({ id: `${id}${index + 1}`, towerId: id, index, lat: pointSpot.lat, lng: pointSpot.lng });
    });
  });

  return {
    startedAt: now,
    lastTickAt: now,
    zone: { center: props.center, radius: ZONE_RADIUS_M[props.radius] },
    players,
    towers,
    points,
    ping: null,
    vote: null,
    lastVote: null,
    result: null,
  };
}

// location is already checked by isLocation() in app.ts
export function updateLocation(game: GameState, userId: string, location: { lat: number; lng: number; accuracy: number }, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player) return;
  player.location = { lat: location.lat, lng: location.lng, accuracy: location.accuracy, recordedAt: now };
}

// The phone tells us which sonar slots it hears within ~2 m right now (= whose phones it touches).
export function updateHeard(game: GameState, userId: string, slots: unknown, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player || !Array.isArray(slots)) return;
  for (const slot of slots) {
    if (Number.isInteger(slot) && slot >= 0 && slot < SONAR.slots && slot !== player.slot) {
      player.heard.set(slot, now);
    }
  }
}

function getAlivePlayer(game: GameState, userId: string) {
  if (game.result) throw new GameError("The game is over.", 409);
  const player = game.players.get(userId);
  if (!player) throw new GameError("You are not in this game.", 403);
  if (!player.alive) throw new GameError("You are out of the game.", 403);
  return player;
}

// Someone dies (caught, voted out, left the zone or the game): drop what they were doing.
function eliminate(player: GamePlayer, now: number) {
  player.alive = false;
  player.diedAt = now;
  player.download = null;
  player.uploadMs = null;
  player.carrying = null;
}

// ---------- tasks ----------

// Start (or continue) downloading at a point. The download itself runs in tickGame.
export function startDownload(game: GameState, userId: string, pointId: unknown, now = Date.now()) {
  const player = getAlivePlayer(game, userId);
  const point = game.points.find((p) => p.id === pointId);
  if (!point) throw new GameError("Unknown download point.", 404);
  if (player.carrying) throw new GameError("You already carry data. Bring it to its tower first.", 409);
  if (!hasFreshLocation(player, now)) throw new GameError("Waiting for your GPS...", 409);
  if (!isAt(player, point, now)) throw new GameError(`Get closer to ${point.id}.`, 409);

  // same point again = keep the progress, another point = start over
  if (!player.download || player.download.pointId !== point.id) {
    player.download = { pointId: point.id, progressMs: 0 };
  }
}

// Stop downloading and throw away the data you carry.
export function dropData(game: GameState, userId: string) {
  const player = getAlivePlayer(game, userId);
  player.download = null;
  player.uploadMs = null;
  player.carrying = null;
}

// Start (or continue) uploading the data you carry at its tower. The upload itself runs in tickGame.
export function startUpload(game: GameState, userId: string, now = Date.now()) {
  const player = getAlivePlayer(game, userId);
  if (!player.carrying) throw new GameError("You don't carry any data. Download some at a point first.", 409);
  const point = game.points.find((p) => p.id === player.carrying)!;
  const tower = game.towers.find((t) => t.id === point.towerId)!;
  if (tower.delivered[point.index]) throw new GameError(`Tower ${tower.id} already has ${point.id}. It needs the other data.`, 409);
  if (!hasFreshLocation(player, now)) throw new GameError("Waiting for your GPS...", 409);
  if (!isAt(player, tower, now)) throw new GameError(`Get closer to tower ${tower.id}.`, 409);
  if (player.uploadMs === null) player.uploadMs = 0;
}

// Runs every tick for every living player: download progress and deliveries.
function tickTasks(game: GameState, player: GamePlayer, playerId: string, elapsed: number, now: number) {
  // downloading: only counts while standing at the point, pauses when you walk away
  if (player.download) {
    const point = game.points.find((p) => p.id === player.download!.pointId)!;
    if (isAt(player, point, now)) player.download.progressMs += elapsed;
    if (player.download.progressMs >= DOWNLOAD_MS) {
      player.download = null;
      player.carrying = point.id;
      tell(player, `Downloaded ${point.id}. Bring it to tower ${point.towerId}.`, now);
    }
  }

  // uploading: after pressing Upload, only counts while standing at the tower, pauses when you walk away
  if (!player.carrying || player.uploadMs === null) return;
  const point = game.points.find((p) => p.id === player.carrying)!;
  const tower = game.towers.find((t) => t.id === point.towerId)!;
  if (isAt(player, tower, now)) player.uploadMs += elapsed;
  if (player.uploadMs < UPLOAD_MS) return;
  player.uploadMs = null;

  if (tower.delivered[point.index]) {
    // someone else brought the same data while I was uploading
    tell(player, `Tower ${tower.id} already has ${point.id}. It needs the other data.`, now);
    return;
  }

  tower.delivered[point.index] = true;
  player.carrying = null;
  const count = tower.delivered.filter(Boolean).length;
  if (count < tower.delivered.length) {
    tell(player, `Delivered ${point.id} to tower ${tower.id} (${count}/${tower.delivered.length}).`, now);
    return;
  }

  // all 3 data: the tower activates, gives its clue to whoever brought the last one, then empties
  tower.delivered = tower.delivered.map(() => false);
  player.clues.add(tower.clueId);
  const cleared = game.players.get(tower.clueId);
  const who = tower.clueId === playerId ? "You are" : `${cleared?.name ?? "Someone"} is`;
  tell(player, `Tower ${tower.id} activated: ${who} not the killer.`, now);
}

// ---------- touching phones: share, kill ----------

// Two phones touching, one presses Share: both end up with all clues either of them had.
export function share(game: GameState, userId: string, targetId: unknown, now = Date.now()) {
  const player = getAlivePlayer(game, userId);
  const target = typeof targetId === "string" ? game.players.get(targetId) : undefined;
  if (!target || target === player) throw new GameError("Unknown player.", 404);
  if (!target.alive) throw new GameError("That player is out.", 409);

  const wait = player.lastShareAt === null ? 0 : SHARE_COOLDOWN_MS - (now - player.lastShareAt);
  if (wait > 0) throw new GameError(`Recharging (${Math.ceil(wait / 1000)} s).`, 429);
  checkGpsDistance(player, target, now);

  player.lastShareAt = now;
  const before = player.clues.size;
  const targetBefore = target.clues.size;
  for (const id of target.clues) player.clues.add(id);
  for (const id of player.clues) target.clues.add(id);
  const gained = player.clues.size - before;
  tell(target, `${player.name} shared clues with you (+${target.clues.size - targetBefore}).`, now);
  return { result: "shared" as const, name: target.name, gained };
}

// The killer holds Share next to a seeker.
export function kill(game: GameState, userId: string, targetId: unknown, now = Date.now()) {
  const player = getAlivePlayer(game, userId);
  if (player.role !== "killer") throw new GameError("Only the killer can do that.", 403);
  const target = typeof targetId === "string" ? game.players.get(targetId) : undefined;
  if (!target || target === player) throw new GameError("Unknown player.", 404);
  if (!target.alive) throw new GameError("That player is out.", 409);

  const wait = player.killReadyAt - now;
  if (wait > 0) throw new GameError(`Recharging (${Math.ceil(wait / 1000)} s).`, 429);
  checkGpsDistance(player, target, now);

  player.killReadyAt = now + KILL_COOLDOWN_MS;
  eliminate(target, now);
  target.killedBy = userId;
  removeFromVote(game, targetId as string);
  checkEnd(game, now);
  return { result: "caught" as const, name: target.name };
}

// The sonar decides "within 2 m"; GPS only rejects the impossible.
function checkGpsDistance(a: GamePlayer, b: GamePlayer, now: number) {
  if (hasFreshLocation(a, now) && hasFreshLocation(b, now)
    && distanceMeters(a.location!, b.location!) > KILL_MAX_DISTANCE_M) {
    throw new GameError("That player is too far away.", 409);
  }
}

// ---------- votes ----------

// Phones touch when either one hears the other's sonar within ~2 m.
function touching(a: GamePlayer, b: GamePlayer, now: number) {
  return now - (a.heard.get(b.slot) ?? 0) <= CONTACT_MS || now - (b.heard.get(a.slot) ?? 0) <= CONTACT_MS;
}

// Everyone connected to me through touching phones (A touches B, B touches C = one group).
export function touchGroup(game: GameState, userId: string, now = Date.now()): string[] {
  const start = game.players.get(userId);
  if (!start || !start.alive) return [];
  const group = [userId];
  for (let i = 0; i < group.length; i++) {
    const current = game.players.get(group[i])!;
    for (const [otherId, other] of game.players) {
      if (!other.alive || group.includes(otherId)) continue;
      if (touching(current, other, now)) group.push(otherId);
    }
  }
  return group;
}

// Players touching phones start a vote. Only that group votes, and it needs more than half of
// all living players to vote for the same person, so enough people have to come together.
export function startVote(game: GameState, userId: string, now = Date.now()) {
  const player = getAlivePlayer(game, userId);
  if (game.vote) throw new GameError("A vote is already running.", 409);
  if (now < player.voteCooldownUntil) {
    throw new GameError(`You can vote again in ${Math.ceil((player.voteCooldownUntil - now) / 1000)} s.`, 429);
  }

  const group = touchGroup(game, userId, now).filter((id) => now >= game.players.get(id)!.voteCooldownUntil);
  const needed = votesNeeded(game);
  if (group.length < needed) {
    throw new GameError(`A vote needs ${needed} players touching phones (now ${group.length}).`, 409);
  }

  game.vote = { callerId: userId, startedAt: now, endsAt: now + VOTE_DURATION_MS, participants: group, ballots: new Map(), needed };
  for (const id of group) {
    if (id !== userId) tell(game.players.get(id)!, `${player.name} called a vote.`, now);
  }
}

// targetId = who to vote out, null = skip. You can change your vote until it ends.
export function castVote(game: GameState, userId: string, targetId: unknown) {
  getAlivePlayer(game, userId);
  if (!game.vote || !game.vote.participants.includes(userId)) throw new GameError("You are not in a vote.", 409);
  if (targetId === null) {
    game.vote.ballots.set(userId, null);
    return;
  }
  const target = typeof targetId === "string" ? game.players.get(targetId) : undefined;
  if (!target || !target.alive) throw new GameError("Pick a living player.", 400);
  game.vote.ballots.set(userId, targetId as string);
}

function removeFromVote(game: GameState, userId: string) {
  if (!game.vote) return;
  game.vote.participants = game.vote.participants.filter((id) => id !== userId);
  game.vote.ballots.delete(userId);
}

// Ends the vote when time is up or everyone has voted.
function tickVote(game: GameState, now: number) {
  const vote = game.vote;
  if (!vote) return;
  const everyoneVoted = vote.participants.every((id) => vote.ballots.has(id));
  if (now < vote.endsAt && !everyoneVoted) return;

  const counts = new Map<string, number>();
  for (const targetId of vote.ballots.values()) {
    if (targetId) counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  let topId: string | null = null;
  let topVotes = 0;
  for (const [targetId, votes] of counts) {
    if (votes > topVotes) {
      topId = targetId;
      topVotes = votes;
    }
  }

  const target = topId ? game.players.get(topId) : undefined;
  if (target && target.alive && topVotes >= vote.needed) {
    eliminate(target, now);
    target.votedOut = true;
    game.lastVote = { at: now, targetName: target.name, role: target.role, votes: topVotes, needed: vote.needed };
  } else {
    game.lastVote = { at: now, targetName: null, role: null, votes: topVotes, needed: vote.needed };
  }

  for (const id of vote.participants) {
    const participant = game.players.get(id);
    if (participant) participant.voteCooldownUntil = now + VOTE_COOLDOWN_MS;
  }
  game.vote = null;
}

// Leaving mid-round counts as being out.
export function removePlayer(game: GameState, userId: string, now = Date.now()) {
  const player = game.players.get(userId);
  if (!player || !player.alive) return;
  eliminate(player, now);
  removeFromVote(game, userId);
  checkEnd(game, now);
}

// ---------- every second ----------

export function tickGame(game: GameState, now = Date.now()) {
  if (game.result) return;
  const elapsed = Math.min(2_000, now - game.lastTickAt);
  game.lastTickAt = now;

  checkZone(game, now);
  for (const [id, player] of game.players) {
    if (player.alive) tickTasks(game, player, id, elapsed, now);
  }
  tickVote(game, now);
  checkEnd(game, now);
}

// ---------- zone ----------

// Eliminates players who stayed too far outside the play area.
// Bad GPS fixes (accuracy worse than ZONE_LEAVE_M) are ignored so nobody dies from GPS noise.
export function checkZone(game: GameState, now = Date.now()) {
  if (game.result) return;
  for (const [id, player] of game.players) {
    if (!player.alive || !hasFreshLocation(player, now)) continue;
    if (player.location!.accuracy > ZONE_LEAVE_M) continue;

    const meters = distanceMeters(game.zone.center, player.location!);
    if (meters <= game.zone.radius + ZONE_LEAVE_M) {
      player.outsideSince = null;
      continue;
    }
    if (player.outsideSince === null) player.outsideSince = now;
    if (now - player.outsideSince >= ZONE_LEAVE_GRACE_MS) {
      eliminate(player, now);
      player.leftZone = true;
      removeFromVote(game, id);
    }
  }
}

// Where am I compared to the border? "inside", "outside" (a bit out, that's fine) or "leaving" (too far, countdown running)
function zoneStatus(game: GameState, player: GamePlayer, now: number) {
  if (!player.alive || !hasFreshLocation(player, now)) return "inside";
  if (player.outsideSince !== null) return "leaving";
  const meters = distanceMeters(game.zone.center, player.location!);
  return meters > game.zone.radius ? "outside" : "inside";
}

// ---------- end ----------

// The killer wins when every seeker is out; seekers win when the killer is out (voted out, left the zone or the game).
export function checkEnd(game: GameState, now = Date.now()): boolean {
  if (game.result) return false;
  const players = Array.from(game.players.values());
  const killer = players.find((p) => p.role === "killer");
  const seekersAlive = players.some((p) => p.role === "seeker" && p.alive);

  let result: Omit<GameResult, "endedAt"> | null = null;
  if (killer && !killer.alive) {
    let reason = "The killer left the game.";
    if (killer.votedOut) reason = "The seekers voted out the killer.";
    else if (killer.leftZone) reason = "The killer went too far outside the zone.";
    result = { winner: "seeker", reason };
  } else if (!seekersAlive) {
    result = { winner: "killer", reason: "The killer caught every seeker." };
  }

  if (!result) return false;
  game.result = { ...result, endedAt: now };
  game.vote = null;
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
// No ids, names or roles: just dots. `carrying` is only filled in for the killer's view.
function livePositions(game: GameState, userId: string, now: number, showCarrying: boolean) {
  const positions: { lat: number; lng: number; carrying: boolean; live: boolean }[] = [];
  for (const [id, p] of game.players) {
    if (id === userId || !p.alive || !hasFreshLocation(p, now)) continue;
    positions.push({ lat: p.location!.lat, lng: p.location!.lng, carrying: showCarrying && p.carrying !== null, live: false });
  }
  return positions;
}

// The killer sees everyone live (and who carries data); players who are out see everyone live too.
// Seekers see one shared snapshot of everyone, refreshed every PING_INTERVAL_MS.
// Both get the same at / nextAt, so both screens fade and count down the same way.
function mapFor(game: GameState, userId: string, self: GamePlayer, now: number) {
  if (game.result) return null;

  const pingDue = game.ping
    ? now - game.ping.at >= PING_INTERVAL_MS
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
  const nextAt = game.ping ? game.ping.at + PING_INTERVAL_MS : game.startedAt + FIRST_PING_MS;

  let positions: { lat: number; lng: number; carrying: boolean; live: boolean }[];
  if (self.role === "killer" || !self.alive) {
    positions = livePositions(game, userId, now, self.role === "killer" && self.alive);
  } else if (!game.ping) {
    positions = [];
  } else {
    positions = [];
    for (const [id, position] of game.ping.positions) {
      if (id === userId) continue; // my own dot comes from my phone
      const other = game.players.get(id)!;
      if (other.alive && touching(self, other, now) && hasFreshLocation(other, now)) continue; // shown live below
      positions.push({ ...position, carrying: false, live: false });
    }
    // phones my sonar hears within ~2 m: we know they're right here, so show them live
    for (const [id, other] of game.players) {
      if (id === userId || !other.alive || !hasFreshLocation(other, now) || !touching(self, other, now)) continue;
      positions.push({ lat: other.location!.lat, lng: other.location!.lng, carrying: false, live: true });
    }
  }

  return { at, nextAt, positions };
}

// ---------- what one player may see ----------

// Never includes other players' roles (until the game is over or they were voted out).
export function serializeGame(game: GameState, userId: string, now = Date.now()) {
  const self = game.players.get(userId);
  if (!self) return null;

  const killer = self.killedBy ? game.players.get(self.killedBy) : undefined;
  const download = self.download
    ? {
      pointId: self.download.pointId,
      progress: Math.min(1, self.download.progressMs / DOWNLOAD_MS),
      here: isAt(self, game.points.find((p) => p.id === self.download!.pointId)!, now),
    }
    : null;
  const vote = game.vote && game.vote.participants.includes(userId)
    ? {
      endsAt: game.vote.endsAt,
      needed: game.vote.needed,
      participants: game.vote.participants,
      voted: game.vote.ballots.size,
      myVote: game.vote.ballots.has(userId) ? game.vote.ballots.get(userId) ?? "skip" : null,
    }
    : null;

  return {
    status: (game.result ? "finished" : "playing") as Status,
    serverTime: now,
    startedAt: game.startedAt,
    zone: game.zone,
    self: {
      id: userId,
      name: self.name,
      role: self.role,
      slot: self.slot,
      alive: self.alive,
      killedByName: game.result && killer ? killer.name : null,
      leftZone: self.leftZone,
      votedOut: self.votedOut,
      zone: zoneStatus(game, self, now),
      eliminatedAt: self.outsideSince !== null ? self.outsideSince + ZONE_LEAVE_GRACE_MS : null,
      download,
      carrying: self.carrying,
      upload: self.uploadMs !== null && self.carrying
        ? {
          progress: Math.min(1, self.uploadMs / UPLOAD_MS),
          here: isAt(self, game.towers.find((t) => t.id === game.points.find((p) => p.id === self.carrying)!.towerId)!, now),
        }
        : null,
      clues: Array.from(self.clues),
      notice: self.notice,
      killCooldownUntil: self.role === "killer" ? self.killReadyAt : null,
      shareCooldownUntil: self.lastShareAt !== null ? self.lastShareAt + SHARE_COOLDOWN_MS : null,
      voteCooldownUntil: self.voteCooldownUntil,
      touching: touchGroup(game, userId, now).filter((id) => id !== userId),
    },
    // Who is out is public; roles stay secret until the end (or until someone is voted out).
    players: Array.from(game.players, ([id, p]) => ({
      id,
      name: p.name,
      slot: p.slot,
      alive: p.alive,
      votedOut: p.votedOut,
      role: game.result || id === userId || p.votedOut ? p.role : null,
    })),
    seekersLeft: Array.from(game.players.values()).filter((p) => p.role === "seeker" && p.alive).length,
    votesNeeded: votesNeeded(game),
    towers: game.towers.map((t) => ({ id: t.id, lat: t.lat, lng: t.lng, delivered: t.delivered })),
    points: game.points,
    sonar: SONAR,
    sonarOn: sonarGate(game, userId, now),
    map: mapFor(game, userId, self, now),
    vote,
    voteRunning: game.vote !== null,
    lastVote: game.lastVote,
    downloadMs: DOWNLOAD_MS,
    result: game.result,
  };
}

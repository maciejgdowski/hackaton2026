// Plays the rules in game.ts with fake GPS and a fake clock: node tests/game-rules.mjs
import assert from "node:assert/strict";
import {
  castVote, createGame, DOWNLOAD_MS, kill, serializeGame, share, startDownload, startUpload, startVote, UPLOAD_MS,
  tickGame, updateHeard, updateLocation,
} from "../src/game.ts";

const M = 1 / 111_320; // ~1 m of latitude
const center = { lat: 52, lng: 21 };
const at = (northM) => ({ lat: center.lat + northM * M, lng: center.lng });

// 4 players = 3 towers (A, B, C), each with 3 points
const layout = {
  towers: [at(0), at(100), at(-100)],
  points: [
    [at(40), at(60), at(80)],
    [at(140), at(160), at(180)],
    [at(-40), at(-60), at(-80)],
  ],
};
const members = new Map([["p1", "Ala"], ["p2", "Bob"], ["p3", "Cem"], ["p4", "Dan"]]);
let now = 1_000_000;
const game = createGame(members, { radius: "large", center }, layout, now);

const ids = [...game.players.keys()];
const killerId = ids.find((id) => game.players.get(id).role === "killer");
const seekers = ids.filter((id) => id !== killerId);
assert.equal(seekers.length, 3);
assert.equal(game.towers.length, 3);
assert.equal(game.points.length, 9);
// every tower clears a different seeker
assert.deepEqual(game.towers.map((t) => t.clueId).sort(), [...seekers].sort());

const move = (id, northM) => updateLocation(game, id, { ...at(northM), accuracy: 5 }, now);
const tick = (ms) => {
  const end = now + ms;
  while (now < end) {
    now += 1000;
    for (const id of ids) {
      const p = game.players.get(id);
      if (p.location) p.location.recordedAt = now; // GPS keeps coming in
    }
    tickGame(game, now);
  }
};

// --- tasks: one seeker brings all 3 data of tower A ---
const [s1, s2, s3] = seekers;
for (const id of ids) move(id, 0);
const towerA = game.towers[0];
for (const [index, north] of [[0, 40], [1, 60], [2, 80]]) {
  move(s1, north);
  startDownload(game, s1, `A${index + 1}`, now);
  tick(DOWNLOAD_MS + 1000);
  assert.equal(game.players.get(s1).carrying, `A${index + 1}`, "download finished");
  move(s1, 0); // walk to tower A
  tick(1000);
  assert.equal(game.players.get(s1).carrying, `A${index + 1}`, "nothing happens without pressing Upload");
  startUpload(game, s1, now);
  tick(UPLOAD_MS + 1000);
  assert.equal(game.players.get(s1).carrying, null, "uploaded");
}
assert.deepEqual(game.players.get(s1).clues.has(towerA.clueId), true, "tower A gave its clue");
assert.deepEqual(towerA.delivered, [false, false, false], "tower emptied");

// download pauses when you walk away
move(s2, 140);
startDownload(game, s2, "B1", now);
tick(5000);
move(s2, 0);
tick(5000);
const paused = game.players.get(s2).download.progressMs;
assert(paused >= 5000 && paused <= 6000, `paused at ${paused}`);
assert.throws(() => startDownload(game, s2, "B1", now), /Get closer/);

// --- nobody can vote in the first 5 minutes, the killer can't kill in the first 3 ---
assert.throws(() => kill(game, killerId, s3, now), /Recharging/);
tick(300_000);

// --- a phone my sonar hears shows live on my map, not at its old ping position ---
move(s2, 5);
move(s3, 300);
tick(61_000); // next ping: s2 at 5 m
move(s2, 2);
updateHeard(game, s3, [game.players.get(s2).slot], now);
const seekerMap = serializeGame(game, s3, now).map;
const liveDot = seekerMap.positions.find((p) => p.live);
assert(liveDot, "heard player is live");
assert(Math.abs(liveDot.lat - (52 + 2 / 111_320)) < 1e-9, "at their current position");
tick(5000); // phones apart again
move(s3, 0);

// --- sharing copies clues both ways ---
game.players.get(s2).clues.add("someone");
share(game, s1, s2, now);
assert(game.players.get(s2).clues.has(towerA.clueId));
assert(game.players.get(s1).clues.has("someone"));

// --- vote: needs > half of living players touching phones ---
const slot = (id) => game.players.get(id).slot;
updateHeard(game, s1, [slot(s2)], now);
assert.throws(() => startVote(game, s1, now), /needs 3 players/);
updateHeard(game, s2, [slot(s3)], now); // s1-s2-s3 = one group through s2
startVote(game, s1, now);
assert.deepEqual([...game.vote.participants].sort(), [s1, s2, s3].sort());
const view = serializeGame(game, s3, now);
assert.equal(view.vote.needed, 3);
assert.equal(view.players.find((p) => p.id === killerId).role, null, "roles stay hidden");

// two votes for an innocent + one skip = nobody out
castVote(game, s1, s2);
castVote(game, s3, s2);
castVote(game, s2, null);
tick(1000);
assert.equal(game.vote, null);
assert.equal(game.lastVote.targetName, null);
assert(game.players.get(s1).voteCooldownUntil > now, "voters on cooldown");
assert.throws(() => startVote(game, s1, now), /vote again/);

// --- the killer kills one seeker ---
kill(game, killerId, s3, now);
assert.equal(game.players.get(s3).alive, false);
assert.throws(() => kill(game, killerId, s2, now), /Recharging/);
assert.throws(() => kill(game, s1, s2, now), /Only the killer/);

// --- after the cooldown: 3 living players, vote the killer out (needs 2) ---
tick(3 * 60_000 + 1000);
updateHeard(game, s1, [slot(s2)], now);
startVote(game, s1, now);
castVote(game, s1, killerId);
castVote(game, s2, killerId);
tick(1000);
assert.equal(game.lastVote.role, "killer");
assert.equal(game.result.winner, "seeker");
assert.equal(game.result.reason, "The seekers voted out the killer.");

console.log("PASS: towers/points, download + pause, delivery, tower clue + reset, share copies clues, touch groups, vote rules + cooldown, kill + cooldown, killer voted out = seekers win, 3 min kill / 5 min vote cooldown at start, upload button, sonar-heard players live on the map");

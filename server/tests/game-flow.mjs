import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import WebSocket from "ws";

const port = 14000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["src/app.ts"], {
  cwd: new URL("../", import.meta.url), env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const sockets = [];
function message(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off("message", listener); reject(new Error(`Missing ${type}`)); }, 5000);
    function listener(raw) {
      const data = JSON.parse(raw.toString());
      if (data.type !== type) return;
      clearTimeout(timeout); socket.off("message", listener); resolve(data);
    }
    socket.on("message", listener);
  });
}
function connect(path) {
  const socket = new WebSocket(`ws://localhost:${port}${path}`);
  sockets.push(socket); return socket;
}
async function request(path, method = "POST", body) {
  return fetch(`http://localhost:${port}${path}`, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 10000);
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on("data", data => {
      if (data.toString().includes("Backend API listening")) { clearTimeout(timeout); resolve(); }
    });
    child.stderr.on("data", data => process.stderr.write(data));
  });
  const response = await request("/lobby/create?userId=host", "POST", {
    radius: "small", center: { lat: 52, lng: 21 }, players: 4, hunters: 2, clues: "easy", username: "Host",
  });
  assert.equal(response.status, 201);
  const { lobbyId } = await response.json();
  const base = `/lobby/${lobbyId}`;
  assert.equal((await request(`${base}/start?userId=host`)).status, 409);
  for (const id of ["guest", "third"]) {
    assert.equal((await request(`${base}/join?userId=${id}`, "POST", { username: id })).status, 200);
  }
  const waiting = connect(`${base}?userId=guest`);
  await message(waiting, "lobby:update");
  assert.equal((await request(`${base}/start?userId=guest`)).status, 403);
  const started = message(waiting, "game:started");
  assert.equal((await request(`${base}/start?userId=host`)).status, 200);
  await started;
  assert.equal((await request(`${base}/start?userId=host`)).status, 409);
  assert.equal((await request(`${base}/join?userId=late`, "POST", { username: "Late" })).status, 409);
  const clients = [];
  for (const id of ["host", "guest", "third"]) {
    const socket = connect(`/game/${lobbyId}?userId=${id}`);
    const [update] = await Promise.all([message(socket, "game:update"), message(socket, "location:start")]);
    clients.push({ id, socket, role: update.game.self.role });
    assert.deepEqual(update.game.zone.center, { lat: 52, lng: 21 });
    assert(update.game.players.every(p => p.id === id || p.role === null));
  }
  assert.equal(clients.filter(c => c.role === "killer").length, 2);
  assert.equal(clients.filter(c => c.role === "seeker").length, 1);
  const publicLobby = await (await request(base, "GET")).json();
  assert.equal(publicLobby.game, undefined);
  clients.forEach(({ socket }, index) => socket.send(JSON.stringify({ type: "player:location",
    location: { lat: 52 + index * 0.0001, lng: 21, accuracy: 5, timestamp: Date.now() } })));
  const killer = clients.find(c => c.role === "killer");
  const seeker = clients.find(c => c.role === "seeker");
  let killerView;
  do { killerView = (await message(killer.socket, "game:update")).game; } while (killerView.map.positions.length !== 2);
  assert(killerView.map.positions.every(p => p.id === undefined && p.name === undefined));
  const seekerView = (await message(seeker.socket, "game:update")).game;
  assert.equal(seekerView.map.positions.length, 0); // first ping comes 5 s after start
  let pinged;
  do { pinged = (await message(seeker.socket, "game:update")).game; } while (pinged.map.positions.length === 0);
  assert.equal(pinged.map.positions.length, 2);
  assert.equal(pinged.map.nextAt - pinged.map.at, 20_000);
  killer.socket.send("not json");
  killer.socket.send(JSON.stringify({ type: "player:location", location: { lat: 999 } }));
  killer.socket.close(); await once(killer.socket, "close");
  const refreshed = connect(`/game/${lobbyId}?userId=${killer.id}`);
  assert.equal((await message(refreshed, "game:update")).game.self.role, "killer");
  const closed = once(refreshed, "close");
  assert.equal((await request(`${base}?userId=host`, "DELETE")).status, 204);
  await closed;
  console.log("PASS: host-only start, minimum players, killer count from lobby, private stable roles, live map for killers, 5 s first ping for seekers, location validation/broadcast, refresh and disband cleanup");
} finally {
  for (const socket of sockets) socket.terminate();
  child.kill();
}

import { spawn } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
import WebSocket from "ws";

const port = 14000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ["--import", "tsx", "src/app.ts"], {
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
    const [state] = await Promise.all([message(socket, "game:state"), message(socket, "location:start")]);
    clients.push({ id, socket, role: state.role });
    assert.deepEqual(state.center, { lat: 52, lng: 21 });
    assert.equal(state.roles, undefined);
  }
  assert.equal(clients.filter(c => c.role === "impostor").length, 1);
  assert.equal(clients.filter(c => c.role === "crewmate").length, 2);
  const publicLobby = await (await request(base, "GET")).json();
  assert.equal(publicLobby.roles, undefined);
  for (const { socket } of clients) socket.send(JSON.stringify({ type: "player:location",
    location: { id: "forged", lat: 52, lng: 21, accuracy: 5, timestamp: Date.now() } }));
  let snapshot;
  do { snapshot = await message(clients[0].socket, "game:locations"); } while (snapshot.players.length !== 3);
  assert.deepEqual(snapshot.players.map(p => p.id).sort(), ["guest", "host", "third"]);
  assert(snapshot.players.every(p => p.role === undefined));
  clients[0].socket.send("not json");
  clients[0].socket.send(JSON.stringify({ type: "player:location", location: { lat: 999 } }));
  assert.equal((await message(clients[1].socket, "game:locations")).players.find(p => p.id === "host").lat, 52);
  clients[0].socket.close(); await once(clients[0].socket, "close");
  const refreshed = connect(`/game/${lobbyId}?userId=host`);
  assert.equal((await message(refreshed, "game:state")).role, clients[0].role);
  const closed = once(refreshed, "close");
  assert.equal((await request(`${base}?userId=host`, "DELETE")).status, 204);
  await closed;
  console.log("PASS: host-only start, minimum players, single impostor, private stable roles, location validation/broadcast, refresh and disband cleanup");
} finally {
  for (const socket of sockets) socket.terminate();
  child.kill();
}

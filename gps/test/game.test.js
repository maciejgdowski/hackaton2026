import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, slotFreq, GATE_HOLD_MS, KILL_FIX_MAX_AGE_MS, KILL_COOLDOWN_MS, GAME_DURATION_MS } from '../game.js';

function setup() {
  let time = 1000000;
  const game = new Game({ now: () => time, choose: () => 1 });
  const hostToken = game.join('Host');
  const guestToken = game.join('Guest');
  const host = game.authenticate(hostToken);
  const guest = game.authenticate(guestToken);
  const location = { latitude: 52.2, longitude: 21.1, accuracy: 5 };
  game.updateLocation(host, location);
  game.updateLocation(guest, location);
  return { game, host, guest, hostToken, guestToken, location, advance: ms => { time += ms; } };
}

test('only the first player can start, with two players and a fresh location', () => {
  const game = new Game();
  const host = game.authenticate(game.join('First'));
  assert.throws(() => game.start(host), /two players/);
  const guest = game.authenticate(game.join('Second'));
  assert.throws(() => game.start(guest), /Only the host/);
  assert.throws(() => game.start(host), /fresh location/);
  const fixture = setup();
  fixture.advance(15001);
  assert.throws(() => fixture.game.start(fixture.host), /fresh location/);
});

test('one impostor, private roles, frozen 100 m zone and closed roster', () => {
  const { game, host, guest, location } = setup();
  game.start(host);
  assert.equal([...game.players.values()].filter(p => p.role === 'impostor').length, 1);
  assert.equal(game.state(guest).self.role, 'impostor');
  const state = game.state(host);
  assert.equal(state.self.role, 'regular');
  assert.equal(state.updateInterval, 15);
  assert.equal(game.state(guest).updateInterval, 1);
  assert.deepEqual(state.zone, { latitude: location.latitude, longitude: location.longitude, radius: 100 });
  assert.ok(state.players.every(p => !('role' in p) && !('location' in p)));
  assert.ok(state.positions.every(p => !('role' in p)));
  game.updateLocation(host, { ...location, latitude: 51 });
  assert.equal(game.state(host).zone.latitude, location.latitude);
  assert.throws(() => game.join('Late'), /already started/);
  assert.throws(() => game.start(host), /already started/);
});

test('impostor sees positions live (1 s); regular players only every 15 s', () => {
  const { game, host, guest, hostToken, location, advance } = setup();
  game.start(host);
  const initial = game.state(host).positions;
  advance(999);
  game.updateLocation(guest, { ...location, latitude: 53 });
  assert.deepEqual(game.state(guest).positions, initial);
  assert.deepEqual(game.state(game.authenticate(hostToken)).positions, initial);
  advance(1);
  assert.equal(game.state(guest).positions[1].location.latitude, 53);
  assert.deepEqual(game.state(host).positions, initial);
  advance(13999);
  game.updateLocation(guest, { ...location, latitude: 54 });
  assert.deepEqual(game.state(host).positions, initial);
  advance(1);
  assert.equal(game.state(host).positions[1].location.latitude, 54);
  assert.equal(game.state(host).nextUpdateAt - game.now(), 15000);
});

test('lobby hides coordinates and expired GPS is marked unavailable', () => {
  const { game, host, advance } = setup();
  assert.deepEqual(game.state(host).positions, []);
  game.start(host);
  advance(120000);
  assert.ok(game.state(host).positions.every(p => p.location === null));
});

test('validation, authentication, and host succession', () => {
  const { game, host, guest, hostToken } = setup();
  for (const location of [null, {}, { latitude: 91, longitude: 0, accuracy: 1 }, { latitude: 1, longitude: '2', accuracy: 1 }, { latitude: 0, longitude: 0, accuracy: -1 }]) {
    assert.throws(() => game.updateLocation(host, location), /Invalid/);
  }
  assert.throws(() => game.join(' host '), /already taken/);
  assert.throws(() => game.authenticate('forged'), /Join/);
  game.leave(host);
  assert.equal(game.hostId, guest.id);
  assert.throws(() => game.authenticate(hostToken), /Join/);
});

test('HTTP API authenticates every private route and ignores forged role and player IDs', async t => {
  const { createServer } = await import('../server.js');
  const fixture = setup();
  const { game, host, guest, hostToken, guestToken, location, advance } = fixture;
  const server = createServer(game);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, token, body) => fetch(`${base}/gps/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  assert.equal((await request('state')).status, 401);
  assert.equal((await request('location', undefined, location)).status, 401);
  assert.equal((await request('start', guestToken, {})).status, 403);
  assert.equal((await request('start', hostToken, {})).status, 200);
  const initial = await (await request('state', hostToken)).json();
  advance(10000);
  await request('location', guestToken, { ...location, latitude: 54, playerId: host.id });
  assert.equal(host.location.latitude, location.latitude);
  assert.equal(guest.location.latitude, 54);
  const forged = await (await request(`state?role=impostor&playerId=${guest.id}`, hostToken)).json();
  assert.deepEqual(forged.positions, initial.positions);
  assert.equal(forged.self.role, 'regular');
  const fast = await (await request('state', guestToken)).json();
  assert.equal(fast.positions[1].location.latitude, 54);
  assert.equal((await fetch(`${base}/game.js`)).status, 404);
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/gps`, { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(`${base}/gps/`)).status, 200);
  assert.equal((await fetch(`${base}/gps/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/gps/api/state`)).status, 401);
  const prefixed = await fetch(`${base}/gps/api/state`, { headers: { Authorization: `Bearer ${hostToken}` } });
  assert.deepEqual((await prefixed.json()).positions, initial.positions);
  assert.equal((await request('location', hostToken, null)).status, 400);
  const crossOrigin = await fetch(`${base}/gps/api/start`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', Authorization: `Bearer ${hostToken}` }, body: '{}' });
  assert.equal(crossOrigin.status, 403);
  const invalidJson = await fetch(`${base}/gps/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error, 'Invalid JSON.');
  const oversized = await request('join', undefined, { name: 'x'.repeat(5000) });
  assert.equal(oversized.status, 413);
  assert.equal((await fetch(`${base}/gps/game.js`)).status, 404);
  assert.equal((await fetch(`${base}/gps/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/state`)).status, 404);
});

function setup3() {
  let time = 1000000;
  const game = new Game({ now: () => time, choose: () => 0 });   // host (first) is the impostor
  const [imp, a, b] = ['Imp', 'Ann', 'Bob'].map(n => game.authenticate(game.join(n)));
  const at = (p, dLat = 0) => game.updateLocation(p, { latitude: 52.2 + dLat, longitude: 21.1, accuracy: 5 });
  [imp, a, b].forEach(p => at(p));
  game.start(imp);
  return { game, imp, a, b, at, advance: ms => { time += ms; } };
}

test('only the living impostor can kill a nearby living regular, with a cooldown', () => {
  const { game, imp, a, b, at, advance } = setup3();
  assert.throws(() => game.kill(a, b.id), /Only the impostor/);
  assert.throws(() => game.kill(imp, imp.id), /Unknown target/);
  assert.throws(() => game.kill(imp, 'nope'), /Unknown target/);
  at(b, 0.001);                                           // ~111 m away
  assert.throws(() => game.kill(imp, b.id), /too far/);
  advance(KILL_FIX_MAX_AGE_MS + 1);                       // stale GPS: sonar decides, server allows
  game.kill(imp, a.id);
  assert.equal(game.state(a).self.alive, false);
  assert.equal(game.state(b).players.find(p => p.id === a.id).alive, false);
});

test('impostor wins when one regular is left; crew wins on time; host resets to lobby', () => {
  const { game, imp, a, b } = setup3();
  game.kill(imp, a.id);
  const end = game.state(b);
  assert.equal(end.phase, 'ended');
  assert.equal(end.result.winner, 'impostor');
  assert.equal(end.result.impostorName, 'Imp');
  assert.equal(game.state(a).result.killedByName, 'Imp');
  assert.throws(() => game.kill(imp, b.id), /not running/);
  assert.throws(() => game.reset(a), /Only the host/);
  game.reset(imp);
  const lobby = game.state(a);
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.self.alive, true);
  assert.equal(lobby.self.role, null);
  assert.deepEqual(lobby.positions, []);

  const t = setup3();
  t.advance(GAME_DURATION_MS - 1);
  assert.equal(t.game.state(t.a).phase, 'playing');
  t.advance(1);
  assert.equal(t.game.state(t.a).result.winner, 'regular');
});

test('cooldown between kills and dead players vanish from the map', () => {
  let time = 1000000;
  const game = new Game({ now: () => time, choose: () => 0 });
  const ps = ['Imp', 'A', 'B', 'C'].map(n => game.authenticate(game.join(n)));
  ps.forEach(p => game.updateLocation(p, { latitude: 52.2, longitude: 21.1, accuracy: 5 }));
  game.start(ps[0]);
  game.kill(ps[0], ps[1].id);
  assert.equal(game.state(ps[2]).phase, 'playing');
  assert.equal(game.state(ps[1]).result, null);              // who killed stays secret while playing
  assert.throws(() => game.kill(ps[0], ps[2].id), /cooling down/);
  time += KILL_COOLDOWN_MS;
  assert.ok(game.state(ps[0]).positions.every(p => p.id !== ps[1].id));   // dead vanish from the map
  ps.forEach(p => game.updateLocation(p, { latitude: 52.2, longitude: 21.1, accuracy: 5 }));
  game.kill(ps[0], ps[2].id);
  assert.equal(game.state(ps[3]).phase, 'ended');
});

test('each player gets the lowest free sonar slot; max 8 players', () => {
  const game = new Game();
  const ps = ['A', 'B', 'C'].map(n => game.authenticate(game.join(n)));
  assert.deepEqual(ps.map(p => p.slot), [0, 1, 2]);
  game.leave(ps[1]);
  assert.equal(game.authenticate(game.join('D')).slot, 1);
  for (const n of ['E', 'F', 'G', 'H', 'I']) game.join(n);
  assert.throws(() => game.join('J'), /full/);
  const st = game.state(ps[0]);
  assert.equal(st.self.slot, 0);
  assert.ok(st.players.every(p => Number.isInteger(p.slot)));
  assert.equal(slotFreq(7), 19900);
});

test('quitting: crewmate counts as out, impostor quitting hands the crew the win, host passes on', () => {
  let time = 1000000;
  const game = new Game({ now: () => time, choose: () => 1 });     // 2nd player is the impostor
  const toks = ['Host', 'Imp', 'A', 'B', 'C'].map(n => game.join(n));
  const [host, imp, a, b, c] = toks.map(t => game.authenticate(t));
  [host, imp, a, b, c].forEach(p => game.updateLocation(p, { latitude: 52.2, longitude: 21.1, accuracy: 5 }));
  game.start(host);
  game.quit(a);
  assert.throws(() => game.authenticate(toks[2]), /Join/);
  assert.equal(game.state(b).players.find(p => p.id === a.id).alive, false);
  assert.equal(game.state(b).phase, 'playing');
  game.quit(host);
  assert.equal(game.hostId, imp.id);
  game.quit(imp);
  const end = game.state(b);
  assert.equal(end.phase, 'ended');
  assert.equal(end.result.winner, 'regular');
  assert.equal(end.result.reason, 'The impostor quit.');
  // B and C are still connected; reset drops the quitters
  assert.equal(game.hostId, b.id);                     // host passed on again (A quit too)
  game.reset(b);
  assert.deepEqual(game.state(b).players.map(p => p.name), ['B', 'C']);
});

test('sonar gate: on only while someone is within ~15 m on GPS, holds 10 s, fails open without GPS', () => {
  let time = 1000000;
  const game = new Game({ now: () => time, choose: () => 0 });
  const [a, b] = ['A', 'B'].map(n => game.authenticate(game.join(n)));
  const put = (p, dLat) => game.updateLocation(p, { latitude: 52.2 + dLat, longitude: 21.1, accuracy: 4 });
  put(a, 0); put(b, 0);
  assert.equal(game.state(a).sonarOn, false);                 // lobby: off
  game.start(a);
  assert.equal(game.state(a).sonarOn, true);                  // same spot
  put(b, 0.0005);                                             // ~56 m away
  assert.equal(game.state(a).sonarOn, true);                  // still held
  time += GATE_HOLD_MS;
  put(a, 0); put(b, 0.0005);
  assert.equal(game.state(a).sonarOn, false);
  assert.equal(game.state(b).sonarOn, false);
  put(b, 0.00015);                                            // ~17 m: within 15 m + slack
  assert.equal(game.state(a).sonarOn, true);
  time += GATE_HOLD_MS + 30001;                               // all GPS stale -> fail open
  assert.equal(game.state(b).sonarOn, true);
});

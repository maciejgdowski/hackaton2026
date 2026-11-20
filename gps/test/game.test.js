import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../game.js';

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
  assert.equal(state.updateInterval, 120);
  assert.equal(game.state(guest).updateInterval, 10);
  assert.deepEqual(state.zone, { latitude: location.latitude, longitude: location.longitude, radius: 100 });
  assert.ok(state.players.every(p => !('role' in p) && !('location' in p)));
  assert.ok(state.positions.every(p => !('role' in p)));
  game.updateLocation(host, { ...location, latitude: 51 });
  assert.equal(game.state(host).zone.latitude, location.latitude);
  assert.throws(() => game.join('Late'), /already started/);
  assert.throws(() => game.start(host), /already started/);
});

test('server withholds changed coordinates until exactly 10 / 120 seconds', () => {
  const { game, host, guest, hostToken, location, advance } = setup();
  game.start(host);
  const initial = game.state(host).positions;
  advance(9999);
  game.updateLocation(guest, { ...location, latitude: 53 });
  assert.deepEqual(game.state(guest).positions, initial);
  assert.deepEqual(game.state(game.authenticate(hostToken)).positions, initial);
  advance(1);
  assert.equal(game.state(guest).positions[1].location.latitude, 53);
  assert.deepEqual(game.state(host).positions, initial);
  advance(109999);
  game.updateLocation(guest, { ...location, latitude: 54 });
  assert.deepEqual(game.state(host).positions, initial);
  advance(1);
  assert.equal(game.state(host).positions[1].location.latitude, 54);
  assert.equal(game.state(host).nextUpdateAt - game.now(), 120000);
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

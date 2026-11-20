import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class Game {
  constructor({ now = Date.now, choose = randomInt } = {}) {
    this.now = now;
    this.choose = choose;
    this.players = new Map();
    this.sessions = new Map();
    this.phase = 'lobby';
    this.hostId = null;
    this.zone = null;
  }

  join(name) {
    if (this.phase !== 'lobby') throw new GameError('This game has already started.', 409);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 24)
      throw new GameError('Choose a name between 1 and 24 characters.');
    if (this.players.size >= 30) throw new GameError('The lobby is full.', 409);
    if ([...this.players.values()].some(p => p.name.toLowerCase() === name.trim().toLowerCase()))
      throw new GameError('That name is already taken.', 409);
    const token = randomBytes(32).toString('hex');
    const player = { id: randomUUID(), name: name.trim(), role: null, location: null, snapshot: null, nextUpdateAt: null };
    this.players.set(player.id, player);
    this.sessions.set(token, player.id);
    this.hostId ??= player.id;
    return token;
  }

  authenticate(token) {
    const player = this.players.get(this.sessions.get(token));
    if (!player) throw new GameError('Join the game to continue.', 401);
    return player;
  }

  updateLocation(player, location) {
    const { latitude, longitude, accuracy } = location ?? {};
    if (![latitude, longitude, accuracy].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100000)
      throw new GameError('Invalid coordinates or accuracy.');
    player.location = { latitude, longitude, accuracy, recordedAt: this.now() };
  }

  start(player) {
    if (player.id !== this.hostId) throw new GameError('Only the host can start the game.', 403);
    if (this.phase !== 'lobby') throw new GameError('The game has already started.', 409);
    if (this.players.size < 2) throw new GameError('At least two players are required.', 409);
    if (!player.location || this.now() - player.location.recordedAt > 15000)
      throw new GameError('Get a fresh location before starting.', 409);
    this.zone = { latitude: player.location.latitude, longitude: player.location.longitude, radius: 100 };
    const players = [...this.players.values()];
    const impostor = this.choose(players.length);
    this.phase = 'playing';
    this.startedAt = this.now();
    players.forEach((p, i) => {
      p.role = i === impostor ? 'impostor' : 'regular';
      this.release(p);
    });
  }

  release(player) {
    const now = this.now();
    player.snapshot = [...this.players.values()].map(p => ({
      id: p.id, name: p.name,
      location: p.location && now - p.location.recordedAt <= 30000 ? { ...p.location } : null
    }));
    player.snapshotAt = now;
    player.nextUpdateAt = now + (player.role === 'impostor' ? 10000 : 120000);
  }

  state(player) {
    // The cache belongs to the authenticated player, never the request/connection.
    // Polling faster, reconnecting, or supplying a different role cannot bypass it.
    if (this.phase === 'playing' && this.now() >= player.nextUpdateAt) this.release(player);
    return {
      phase: this.phase, serverTime: this.now(), hostId: this.hostId,
      self: { id: player.id, name: player.name, role: player.role },
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name })),
      zone: this.zone, startedAt: this.startedAt ?? null,
      positions: player.snapshot ?? [], snapshotAt: player.snapshotAt ?? null,
      nextUpdateAt: player.nextUpdateAt,
      updateInterval: this.phase === 'playing' ? (player.role === 'impostor' ? 10 : 120) : null
    };
  }

  leave(player) {
    if (this.phase !== 'lobby') throw new GameError('Players cannot leave the roster after the game starts.', 409);
    this.players.delete(player.id);
    for (const [token, id] of this.sessions) if (id === player.id) this.sessions.delete(token);
    if (this.hostId === player.id) this.hostId = this.players.keys().next().value ?? null;
  }
}

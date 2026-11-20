import { randomInt } from 'node:crypto';
import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, MAX_LOBBIES, SONAR, ZONE_RADIUS_M } from './config.js';
import { GameError } from './errors.js';
import { Game, validateName } from './game.js';

const randomCode = () =>
  Array.from({ length: LOBBY_CODE_LENGTH }, () => LOBBY_CODE_ALPHABET[randomInt(LOBBY_CODE_ALPHABET.length)]).join('');

// All running games, each behind a short lobby code.
// A lobby disappears once everyone in it has left (see Game.maintain and sweep below).
export class Lobbies {
  constructor() {
    this.games = new Map(); // code → Game
  }

  // Forget lobbies that have emptied out.
  sweep() {
    for (const [code, game] of this.games) {
      game.maintain();
      if (game.players.size === 0) this.games.delete(code);
    }
  }

  newCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const code = randomCode();
      if (!this.games.has(code)) return code;
    }
    throw new GameError('Could not create a lobby. Try again.', 503);
  }

  create(name, { radius = ZONE_RADIUS_M.default, maxPlayers = SONAR.slots } = {}) {
    validateName(name);
    if (!Number.isInteger(radius) || radius < ZONE_RADIUS_M.min || radius > ZONE_RADIUS_M.max)
      throw new GameError(`Zone radius must be ${ZONE_RADIUS_M.min}–${ZONE_RADIUS_M.max} m.`);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > SONAR.slots)
      throw new GameError(`Players must be 2–${SONAR.slots}.`);

    this.sweep();
    if (this.games.size >= MAX_LOBBIES) throw new GameError('Too many lobbies right now. Try again later.', 503);

    const game = new Game({ code: this.newCode(), radius, maxPlayers });
    const token = game.join(name);
    this.games.set(game.code, game);
    return { token, code: game.code };
  }

  join(name, code) {
    this.sweep();
    const normalized = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const game = this.games.get(normalized);
    if (!game) throw new GameError(normalized ? `No lobby with code ${normalized}.` : 'Enter a lobby code.', 404);
    return { token: game.join(name), code: game.code };
  }

  // Finds the game a session token belongs to.
  authenticate(token) {
    if (typeof token === 'string' && token) {
      for (const game of this.games.values())
        if (game.sessions.has(token)) return { game, player: game.authenticate(token) };
    }
    throw new GameError('Join the game to continue.', 401);
  }
}

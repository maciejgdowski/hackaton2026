import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { GameError } from './errors.ts';
import type { Game, Player } from './game.ts';
import type { Lobbies } from './lobbies.ts';

// The built React app (npm run build → client/dist).
const CLIENT_DIR = fileURLToPath(new URL('../../client/dist/', import.meta.url));

interface Session {
  game: Game;
  player: Player;
}

// Rejects cross-origin calls and anything that isn't a JSON object.
function guardRequests(req: Request, _res: Response, next: NextFunction) {
  if (req.headers.origin) {
    let origin: URL;
    try { origin = new URL(req.headers.origin); } catch { throw new GameError('Invalid origin.', 403); }
    if (origin.host !== req.headers.host) throw new GameError('Cross-origin requests are not allowed.', 403);
  }
  if (req.method === 'POST' && !req.is('application/json')) throw new GameError('Expected JSON.', 415);
  next();
}

function requireJsonObject(req: Request, _res: Response, next: NextFunction) {
  const body: unknown = req.body;
  if (req.method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body)))
    throw new GameError('Expected a JSON object.');
  next();
}

function handleErrors(error: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (error instanceof GameError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Server error.' });
}

function createApi(lobbies: Lobbies) {
  const api = express.Router();
  api.use(guardRequests, express.json({ limit: '4kb' }), requireJsonObject);

  api.post('/create', (req, res) => {
    const { name, radius, maxPlayers } = req.body;
    res.status(201).json(lobbies.create(name, { radius, maxPlayers }));
  });
  api.post('/join', (req, res) => {
    res.status(201).json(lobbies.join(req.body.name, req.body.code));
  });

  // Everything below needs a session: "Authorization: Bearer <token>".
  api.use((req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    res.locals.session = lobbies.authenticate(token);
    next();
  });

  // Runs an action on the player's game, then replies with their view (or { ok: true }).
  type Action = (game: Game, player: Player, body: Record<string, unknown>) => void;
  const route = (action: Action, reply: 'view' | 'ok' = 'view') => (req: Request, res: Response) => {
    const { game, player } = res.locals.session as Session;
    action(game, player, req.body);
    res.json(reply === 'view' ? game.view(player) : { ok: true });
  };

  api.get('/state', (req, res) => {
    const { game, player } = res.locals.session as Session;
    res.json(game.view(player, { debug: req.headers['x-debug'] === '1' }));
  });
  api.post('/sound', route((game, player, body) => game.setSound(player, body.ready), 'ok'));
  api.post('/location', route((game, player, body) => game.updateLocation(player, body), 'ok'));
  api.post('/start', route((game, player) => game.start(player)));
  api.post('/kill', route((game, player, body) => game.kill(player, body.targetId)));
  api.post('/reset', route((game, player) => game.reset(player)));
  api.post('/quit', route((game, player) => game.quit(player), 'ok'));
  api.post('/leave', route((game, player) => game.leave(player), 'ok'));
  return api;
}

// basePath: URL prefix the game lives under ('' = site root, '/play' = example.com/play/).
export function createApp(lobbies: Lobbies, { basePath = '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('strict routing', true);

  app.use((_req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self)'
    });
    next();
  });

  if (basePath) {
    app.get('/', (_req, res) => res.redirect(308, `${basePath}/`));
    app.get(basePath, (_req, res) => res.redirect(308, `${basePath}/`));
  }

  app.use(`${basePath}/api`, createApi(lobbies));
  app.use(basePath || '/', express.static(CLIENT_DIR, { dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(handleErrors);
  return app;
}

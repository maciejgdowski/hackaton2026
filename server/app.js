import express from 'express';
import { fileURLToPath } from 'node:url';
import { GameError } from './errors.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// Rejects cross-origin calls and anything that isn't a JSON object.
function guardRequests(req, res, next) {
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw new GameError('Invalid origin.', 403); }
    if (origin.host !== req.headers.host) throw new GameError('Cross-origin requests are not allowed.', 403);
  }
  if (req.method === 'POST' && !req.is('application/json')) throw new GameError('Expected JSON.', 415);
  next();
}

function requireJsonObject(req, res, next) {
  const body = req.body;
  if (req.method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body)))
    throw new GameError('Expected a JSON object.');
  next();
}

function handleErrors(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (error instanceof GameError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: 'Server error.' });
}

function createApi(lobbies) {
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
    Object.assign(res.locals, lobbies.authenticate(token)); // → res.locals.game, res.locals.player
    next();
  });

  // Small helper: run an action on the player's game, then reply.
  const route = (action, reply = 'view') => (req, res) => {
    const { game, player } = res.locals;
    action(game, player, req.body);
    res.json(reply === 'view' ? game.view(player) : { ok: true });
  };

  api.get('/state', (req, res) => {
    const { game, player } = res.locals;
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
export function createApp(lobbies, { basePath = '' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');

  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'geolocation=(self)'
    });
    next();
  });

  if (basePath) {
    app.get('/', (req, res) => res.redirect(308, `${basePath}/`));
    app.get(basePath, (req, res) => res.redirect(308, `${basePath}/`));
  }

  app.use(`${basePath}/api`, createApi(lobbies));
  app.use(basePath || '/', express.static(PUBLIC_DIR, { dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false }));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use(handleErrors);
  return app;
}

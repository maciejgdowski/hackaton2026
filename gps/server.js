import express from 'express';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Game, GameError } from './game.js';

// URL prefix the app lives under (outofsignal.pl/gps or /app). Set BASE_PATH to change it.
const BASE = '/' + (process.env.BASE_PATH || '/gps').replace(/^\/+|\/+$/g, '');

export function createApp(game = new Game()) {
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
  app.get('/', (req, res) => res.redirect(308, `${BASE}/`));
  app.get(BASE, (req, res) => res.redirect(308, `${BASE}/`));

  const api = express.Router();
  api.use((req, res, next) => {
    if (req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); }
      catch { throw new GameError('Invalid origin.', 403); }
      if (origin.host !== req.headers.host)
        throw new GameError('Cross-origin requests are not allowed.', 403);
    }
    if (req.method === 'POST' && !req.is('application/json'))
      throw new GameError('Expected JSON.', 415);
    next();
  });
  api.use(express.json({ limit: '4kb' }));
  api.use((req, res, next) => {
    if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)))
      throw new GameError('Expected a JSON object.');
    next();
  });
  api.post('/join', (req, res) => res.status(201).json({ token: game.join(req.body.name) }));
  api.use((req, res, next) => {
    res.locals.player = game.authenticate(req.headers.authorization?.replace(/^Bearer /, ''));
    next();
  });
  api.get('/state', (req, res) => res.json(game.state(res.locals.player)));
  api.post('/sound', (req, res) => {
    game.setSound(res.locals.player, req.body.ready);
    res.json({ ok: true });
  });
  api.post('/location', (req, res) => {
    game.updateLocation(res.locals.player, req.body);
    res.json({ ok: true });
  });
  api.post('/start', (req, res) => {
    game.start(res.locals.player);
    res.json(game.state(res.locals.player));
  });
  api.post('/kill', (req, res) => {
    game.kill(res.locals.player, req.body.targetId);
    res.json(game.state(res.locals.player));
  });
  api.post('/reset', (req, res) => {
    game.reset(res.locals.player);
    res.json(game.state(res.locals.player));
  });
  api.post('/quit', (req, res) => {
    game.quit(res.locals.player);
    res.json({ ok: true });
  });
  api.post('/leave', (req, res) => {
    game.leave(res.locals.player);
    res.json({ ok: true });
  });
  app.use(`${BASE}/api`, api);
  app.use(BASE, express.static(fileURLToPath(new URL('./public/', import.meta.url)), {
    dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false
  }));
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (error instanceof GameError) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Server error.' });
  });
  return app;
}

export function createServer(game = new Game()) {
  return http.createServer(createApp(game));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Out of Signal: http://localhost:${port}${BASE}/`);
  });
}

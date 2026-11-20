// Entry point: `npm start`.
//   PORT       (default 3000)
//   HOST       (default 0.0.0.0)
//   BASE_PATH  URL prefix, e.g. /play (default: site root)
import http from 'node:http';
import { createApp } from './app.js';
import { Lobbies } from './lobbies.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const basePath = (process.env.BASE_PATH || '').replace(/^\/+|\/+$/g, '');
const prefix = basePath ? `/${basePath}` : '';

const lobbies = new Lobbies();
setInterval(() => lobbies.sweep(), 30_000).unref(); // forget lobbies everyone has left

http.createServer(createApp(lobbies, { basePath: prefix })).listen(port, host, () => {
  console.log(`Out of Signal: http://localhost:${port}${prefix}/`);
});

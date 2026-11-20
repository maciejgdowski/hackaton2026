import { Sonar } from './sonar.js';

const SESSION_KEY = 'oos-session';

let token = sessionStorage.getItem(SESSION_KEY);
let onSessionLost = () => {};

export const session = {
  get active() { return !!token; },
  start(newToken) {
    token = newToken;
    sessionStorage.setItem(SESSION_KEY, token);
  },
  end() {
    token = null;
    sessionStorage.removeItem(SESSION_KEY);
  },
  onLost(callback) { onSessionLost = callback; }
};

// GET when body is undefined, POST (JSON) otherwise. Throws Error(message from the server).
export async function api(path, body) {
  const isPost = body !== undefined;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (Sonar.debug) headers['X-Debug'] = '1';
  if (isPost) headers['Content-Type'] = 'application/json';

  const response = await fetch(`./api/${path}`, {
    method: isPost ? 'POST' : 'GET',
    headers,
    body: isPost ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      session.end();
      onSessionLost();
    }
    throw new Error(data.error);
  }
  return data;
}

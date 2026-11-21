// Fetch wrapper for /api + the session token (kept per browser tab).

const SESSION_KEY = 'oos-session';
const debug = new URLSearchParams(location.search).has('debug');

let token = sessionStorage.getItem(SESSION_KEY);
let onSessionLost = () => {};

export const session = {
  get active() {
    return token !== null;
  },
  start(newToken: string) {
    token = newToken;
    sessionStorage.setItem(SESSION_KEY, newToken);
  },
  end() {
    token = null;
    sessionStorage.removeItem(SESSION_KEY);
  },
  /** Called when the server no longer knows our token (401). */
  onLost(callback: () => void) {
    onSessionLost = callback;
  }
};

/** GET when body is undefined, POST (JSON) otherwise. Throws Error(message from the server). */
export async function api<T = { ok: true }>(path: string, body?: object): Promise<T> {
  const isPost = body !== undefined;
  const sentToken = token;
  const headers: Record<string, string> = {};
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;
  if (debug) headers['X-Debug'] = '1';
  if (isPost) headers['Content-Type'] = 'application/json';

  const response = await fetch(`./api/${path}`, {
    method: isPost ? 'POST' : 'GET',
    headers,
    body: isPost ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    // Only if it's still our session (a poll still in flight after Leave also gets a 401).
    if (response.status === 401 && sentToken !== null && sentToken === token) {
      session.end();
      onSessionLost();
    }
    throw new Error(data.error ?? 'Request failed.');
  }
  return data as T;
}

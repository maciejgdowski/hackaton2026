import { api, session } from './api.js';
import { store } from './store.js';
import { World } from './world.js';

const UPLOAD_EVERY_MS = 3000;   // at most this often from watchPosition
const REFRESH_EVERY_MS = 5000;  // plus a fresh fix this often (watchPosition can go quiet when standing still)
const OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

export const gps = {
  fix: null,       // { latitude, longitude, accuracy }
  uploadedAt: 0
};
let watchId;

export function getLocation() {
  if (!window.isSecureContext) return Promise.reject(new Error('Location needs HTTPS.'));
  if (!navigator.geolocation) return Promise.reject(new Error('This browser has no location support.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, OPTIONS));
}

// Keeps the fix locally and moves the lobby map (before the round the map shows only you).
export function rememberFix(position) {
  const { latitude, longitude, accuracy } = position.coords;
  gps.fix = { latitude, longitude, accuracy };
  if (store.state?.phase !== 'playing') {
    World.home(latitude, longitude);
    World.me(latitude, longitude);
  }
}

export async function upload(position) {
  rememberFix(position);
  await api('location', gps.fix);
  gps.uploadedAt = Date.now();
}

export const hasRecentUpload = () => !!gps.fix && Date.now() - gps.uploadedAt < 30_000;

export async function startTracking() {
  await upload(await getLocation());
  if (watchId !== undefined) return;
  watchId = navigator.geolocation.watchPosition(position => {
    if (Date.now() - gps.uploadedAt >= UPLOAD_EVERY_MS) upload(position).catch(() => {});
  }, () => {}, OPTIONS);
}

export function stopTracking() {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
}

setInterval(() => {
  if (session.active && watchId !== undefined) getLocation().then(upload).catch(() => {});
}, REFRESH_EVERY_MS);

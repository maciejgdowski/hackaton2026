// GPS: one-off fixes, continuous tracking and uploads to the server.
// React components read the latest fix with useLocation().
import type { LocationFix } from '@oos/shared';
import { useSyncExternalStore } from 'react';
import { api, session } from './api.ts';

const UPLOAD_EVERY_MS = 3000;   // at most this often from watchPosition
const REFRESH_EVERY_MS = 5000;  // plus a fresh fix this often (watchPosition goes quiet when standing still)
const OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 };

interface LocationState {
  fix: LocationFix | null;
  uploadedAt: number;
}

let state: LocationState = { fix: null, uploadedAt: 0 };
let watchId: number | undefined;
const listeners = new Set<() => void>();

function update(next: Partial<LocationState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

export function useLocation(): LocationState {
  return useSyncExternalStore(listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => state);
}

export const getLocationState = () => state;

export function getLocation(): Promise<GeolocationPosition> {
  if (!window.isSecureContext) return Promise.reject(new Error('Location needs HTTPS.'));
  if (!navigator.geolocation) return Promise.reject(new Error('This browser has no location support.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, OPTIONS));
}

/** Keeps the fix locally (the lobby map follows it) without sending it. */
export function rememberFix(position: GeolocationPosition) {
  const { latitude, longitude, accuracy } = position.coords;
  update({ fix: { latitude, longitude, accuracy } });
}

export async function upload(position: GeolocationPosition) {
  rememberFix(position);
  await api('location', state.fix!);
  update({ uploadedAt: Date.now() });
}

export const hasRecentUpload = () => state.fix !== null && Date.now() - state.uploadedAt < 30_000;

export async function startTracking() {
  await upload(await getLocation());
  if (watchId !== undefined) return;
  watchId = navigator.geolocation.watchPosition(position => {
    if (Date.now() - state.uploadedAt >= UPLOAD_EVERY_MS) upload(position).catch(() => {});
  }, () => {}, OPTIONS);
}

/** Stop tracking and forget the position (back to the menu). */
export function stopTracking() {
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  update({ fix: null, uploadedAt: 0 });
}

setInterval(() => {
  if (session.active && watchId !== undefined) getLocation().then(upload).catch(() => {});
}, REFRESH_EVERY_MS);

// Server clock: the server's timestamps (round end, cooldowns) are compared against this.
let serverOffset = 0;

export function syncServerClock(serverTime: number) {
  serverOffset = serverTime - Date.now();
}

export const serverNow = () => Date.now() + serverOffset;

/** Whole seconds until a server timestamp (never negative). */
export const secondsUntil = (time: number | null) => (time === null ? 0 : Math.max(0, Math.ceil((time - serverNow()) / 1000)));

/** 125 → "2:05" */
export const formatClock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

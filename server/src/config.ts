import type { SonarConfig } from '@oos/shared';

// Every gameplay number in one place.

// Round
export const ROUND_DURATION_MS = 10 * 60_000;
export const KILL_COOLDOWN_MS = 30_000;

// Map updates: the impostor tracks everyone live, the crew only gets a snapshot now and then.
export const IMPOSTOR_MAP_INTERVAL_MS = 1_000;
export const CREW_MAP_INTERVAL_MS = 15_000; // testing value

// GPS
export const LOCATION_MAX_AGE_MS = 30_000;       // older fixes count as "no GPS"
export const START_LOCATION_MAX_AGE_MS = 15_000; // the host needs a fresh fix to place the zone
export const KILL_MAX_DISTANCE_M = 50;           // the 2 m check is the sonar's job; GPS only rejects the impossible

// Sonar gate: phones only play and listen while another living player is this close on GPS.
// Phone-to-phone GPS is often 15–30 m off, so the gate is generous and fails open without GPS.
export const SONAR_GATE_M = 30;
export const SONAR_GATE_SLACK_M = 10;     // + up to this much for reported GPS inaccuracy
export const SONAR_GATE_HOLD_MS = 10_000; // stay on this long after the last "close"

// Sonar frequencies: every player gets one slot = one tone (17.8–19.9 kHz).
export const SONAR: SonarConfig = { base: 17_800, spacing: 300, slots: 8 };

// Lobbies
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O: easy to read out loud
export const LOBBY_CODE_LENGTH = 4;
export const MAX_LOBBIES = 200;
export const ZONE_RADIUS_M = { min: 25, max: 1000, default: 100 };
export const NAME_MAX_LENGTH = 24;

// Self-healing. Phones poll every second, so a player not seen for a while has closed the app.
export const PLAYER_GONE_MS = 45_000;            // counts as gone (host passes on, empty rounds are wiped)
export const LOBBY_IDLE_DROP_MS = 120_000;       // removed from a lobby (long enough for a screen lock)
export const ENDED_RETURN_TO_LOBBY_MS = 90_000;  // a finished round reopens the lobby by itself

// The three things the game asks the phone for: microphone (sonar), location (map) and motion (compass + gyro map).
// iPhone Safari only lets ONE tap ask for ONE permission, so every permission gets its own Allow button.

import { isSonarReady, startSonar } from "./Sonar";
import { requestLocation, savePlaceName } from "./Location";

export type PermissionState = "allowed" | "denied" | "ask" | "unsupported";

export interface PermissionsStatus {
  microphone: PermissionState;
  location: PermissionState;
  motion: PermissionState;
}

// ---------- checking (never shows a prompt) ----------

// Asks the browser what it remembers, without a prompt. Returns null if the browser can't tell us.
async function browserRemembers(name: string): Promise<PermissionState | null> {
  try {
    const result = await navigator.permissions.query({ name: name as PermissionName });
    if (result.state === "granted") return "allowed";
    if (result.state === "denied") return "denied";
    return "ask";
  } catch {
    return null; // older Safari doesn't know this permission name
  }
}

export async function checkPermissions(): Promise<PermissionsStatus> {
  // Microphone: "allowed" only when the sonar actually runs (the mic stops on every reload)
  let microphone: PermissionState = "ask";
  if (isSonarReady()) microphone = "allowed";
  else if ((await browserRemembers("microphone")) === "denied") microphone = "denied";

  let location: PermissionState = (await browserRemembers("geolocation")) ?? "ask";
  if (location === "ask" && localStorage.getItem("locationAllowed") === "yes") location = "allowed";

  return { microphone, location, motion: motionState };
}

// ---------- asking (each one must be called straight from a tap) ----------

export async function askMicrophone(): Promise<PermissionState> {
  try {
    await startSonar();
    return "allowed";
  } catch {
    return "denied";
  }
}

export async function askLocation(): Promise<PermissionState> {
  try {
    const coords = await requestLocation();
    localStorage.setItem("locationAllowed", "yes");
    await savePlaceName(coords);
    return "allowed";
  } catch {
    localStorage.removeItem("locationAllowed");
    return "denied";
  }
}

// Motion: iPhone needs DeviceOrientationEvent.requestPermission(), Android and desktop don't ask.
type OrientationWithPermission = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };

let motionState: PermissionState = startingMotionState();

function startingMotionState(): PermissionState {
  const orientation = window.DeviceOrientationEvent as OrientationWithPermission | undefined;
  if (!orientation) return "unsupported";
  if (!orientation.requestPermission) return "allowed"; // no prompt needed on this phone
  return "ask";
}

export async function askMotion(): Promise<PermissionState> {
  const orientation = window.DeviceOrientationEvent as OrientationWithPermission | undefined;
  if (!orientation?.requestPermission) return motionState;
  try {
    const answer = await orientation.requestPermission(); // must be the first thing after the tap
    motionState = answer === "granted" ? "allowed" : "denied";
  } catch {
    motionState = "denied";
  }
  if (motionState === "allowed") localStorage.setItem("motionAllowed", "yes");
  else localStorage.removeItem("motionAllowed");
  return motionState;
}

// After a reload iPhone forgets motion, but if it was allowed before it says yes again without a prompt.
// Only called from a tap, and only when we know it was allowed, so it never adds a second prompt.
export function askMotionAgainIfAllowedBefore() {
  if (motionState === "ask" && localStorage.getItem("motionAllowed") === "yes") askMotion();
}

// What to tell the player when something is blocked (the page can't ask again after "Don't Allow")
export const BLOCKED_HELP =
  "Blocked. iPhone: tap aA in the address bar > Website Settings, set it to Allow and reload (motion: Settings > Apps > Safari > Motion & Orientation Access). Android: tap the icon next to the address.";

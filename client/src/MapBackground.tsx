import { useEffect, useRef } from "react";
import { getSavedLocation } from "./Location";

const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const CUSTOM_STYLE = "mapbox/dark-v11";

// New York until the player shares their location on the welcome page
const DEFAULT_LON = -73.9712;
const DEFAULT_LAT = 40.7831;
const ZOOM = 11.5;

// ---------- tilt (gyro) ----------
// Tilting the phone slides the map the other way, so it looks like it floats under the screen.
// Without a tilt sensor (desktop) the map keeps its slow drifting animation from Style.css.

const MAX_TILT_DEG = 25; // tilting further than this doesn't move the map any more
const MAX_SHIFT_PERCENT = 5; // how far the map slides at full tilt
const SMOOTHING = 0.08; // 0..1 per frame: lower = floatier
const RECENTER = 0.004; // slowly treat the way you hold the phone as "level"

let tiltX = 0; // -1..1 (left / right)
let tiltY = 0; // -1..1 (towards you / away)
let hasTilt = false;
let levelBeta: number | null = null;
let levelGamma: number | null = null;

function onOrientation(event: DeviceOrientationEvent) {
  if (event.beta === null || event.gamma === null) return;
  hasTilt = true;
  // the first reading is "level"; after that, level slowly follows how the phone is held
  if (levelBeta === null || levelGamma === null) {
    levelBeta = event.beta;
    levelGamma = event.gamma;
  }
  levelBeta += (event.beta - levelBeta) * RECENTER;
  levelGamma += (event.gamma - levelGamma) * RECENTER;
  tiltX = Math.max(-1, Math.min(1, (event.gamma - levelGamma) / MAX_TILT_DEG));
  tiltY = Math.max(-1, Math.min(1, (event.beta - levelBeta) / MAX_TILT_DEG));
}

window.addEventListener("deviceorientation", onOrientation);

// iPhone: the tilt sensor needs permission, which can only be asked from a tap.
// The first tap anywhere in the app asks once (usually the Enter button on the welcome page).
type OrientationWithPermission = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
function askTiltPermission() {
  document.removeEventListener("click", askTiltPermission, true);
  const orientation = window.DeviceOrientationEvent as OrientationWithPermission | undefined;
  orientation?.requestPermission?.().catch(() => {});
}
document.addEventListener("click", askTiltPermission, true); // "click": Safari only allows asking on a finished tap

export default function MapBackground() {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const saved = getSavedLocation();
  const lon = saved ? saved.lng.toFixed(4) : DEFAULT_LON;
  const lat = saved ? saved.lat.toFixed(4) : DEFAULT_LAT;
  const MAP_STATIC_URL = `https://api.mapbox.com/styles/v1/${CUSTOM_STYLE}/static/${lon},${lat},${ZOOM},0,0/500x1000@2x.png?access_token=${TOKEN}`;

  // Move the map every frame towards where the tilt says it should be (smoothly, so it floats)
  useEffect(() => {
    let frame = 0;
    let x = 0;
    let y = 0;
    function animate() {
      const image = imageRef.current;
      if (image && hasTilt) {
        x += (-tiltX * MAX_SHIFT_PERCENT - x) * SMOOTHING;
        y += (-tiltY * MAX_SHIFT_PERCENT - y) * SMOOTHING;
        image.style.animation = "none"; // the tilt takes over from the drifting animation
        image.style.transform = `translate3d(${x.toFixed(2)}%, ${y.toFixed(2)}%, 0) scale(1.14)`;
      }
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      className="background-map"
      style={{
        overflow: "hidden",
        backgroundColor: "#09090a",
      }}
    >
      <img
        ref={imageRef}
        src={MAP_STATIC_URL}
        alt="Map background"
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
    </div>
  );
}

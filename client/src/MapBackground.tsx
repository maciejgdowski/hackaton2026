import { getSavedLocation } from "./Location";

const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const CUSTOM_STYLE = "mapbox/dark-v11";

// New York until the player shares their location on the welcome page
const DEFAULT_LON = -73.9712;
const DEFAULT_LAT = 40.7831;
const ZOOM = 11.5;

export default function MapBackground() {
  const saved = getSavedLocation();
  const lon = saved ? saved.lng.toFixed(4) : DEFAULT_LON;
  const lat = saved ? saved.lat.toFixed(4) : DEFAULT_LAT;
  const MAP_STATIC_URL = `https://api.mapbox.com/styles/v1/${CUSTOM_STYLE}/static/${lon},${lat},${ZOOM},0,0/500x1000@2x.png?access_token=${TOKEN}`;

  return (
    <div
      className="background-map"
      style={{
        overflow: "hidden",
        backgroundColor: "#09090a",
      }}
    >
      <img
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
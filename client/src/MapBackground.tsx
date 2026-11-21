const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const CUSTOM_STYLE = "mapbox/dark-v11";

const LON = -73.9712;
const LAT = 40.7831;
const ZOOM = 11.5;

const MAP_STATIC_URL = `https://api.mapbox.com/styles/v1/${CUSTOM_STYLE}/static/${LON},${LAT},${ZOOM},0,0/500x1000@2x.png?access_token=${TOKEN}`;

export default function MapBackground() {
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
import { MapContainer, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

type GameBackgroundMapProps = {
  center?: [number, number];
  zoom?: number;
  minZoom?: number;
  maxZoom?: number;
  maxBounds?: [[number, number], [number, number]];
  children?: React.ReactNode;
};

const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const STYLE = "mapbox/dark-v11";

// Without a Mapbox token fall back to free dark tiles (same as LocationPickerMap)
const TILE_URL = TOKEN
  ? `https://api.mapbox.com/styles/v1/${STYLE}/tiles/512/{z}/{x}/{y}@2x.png?access_token=${TOKEN}`
  : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

export default function GameBackgroundMap({
  center = [40.7831, -73.9712],
  zoom = 13,
  minZoom = 11,
  maxZoom = 17,
  maxBounds = [
    [40.68, -74.06],
    [40.89, -73.88],
  ],
  children,
}: GameBackgroundMapProps) {
  return (
    <div className="game-map-layer">
      <MapContainer
        center={center}
        zoom={zoom}
        minZoom={minZoom}
        maxZoom={maxZoom}
        maxBounds={maxBounds}
        maxBoundsViscosity={1.0}
        zoomControl={false} // keeps top-left clear for game HUD
        style={{ height: "100%", width: "100%", zIndex: "-10"}}
      >
        <TileLayer
          url={TILE_URL}
          tileSize={TOKEN ? 512 : 256}
          zoomOffset={TOKEN ? -1 : 0}
          attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        {children}
      </MapContainer>
    </div>
  );
}
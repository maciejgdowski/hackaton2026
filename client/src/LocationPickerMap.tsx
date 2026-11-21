import L from "leaflet";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
import { useEffect } from "react";
import "leaflet/dist/leaflet.css";

export type Coordinates = {
  lat: number;
  lng: number;
};

type LocationPickerMapProps = {
  value: Coordinates | null;
  onChange: (coords: Coordinates) => void;
  defaultCenter?: Coordinates;
  zoom?: number;
};

const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const STYLE = "mapbox/dark-v11";

const TILE_URL = TOKEN
  ? `https://api.mapbox.com/styles/v1/${STYLE}/tiles/512/{z}/{x}/{y}@2x.png?access_token=${TOKEN}`
  : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

const pinIcon = L.divIcon({
  className: "location-pin-wrapper",
  html: `<div class="location-pin"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

function ClickHandler({ onSelect }: { onSelect: (coords: Coordinates) => void }) {
  useMapEvents({
    click(e) {
      onSelect({
        lat: Number(e.latlng.lat.toFixed(6)),
        lng: Number(e.latlng.lng.toFixed(6)),
      });
    },
  });

  return null;
}

// MapContainer's initial center does not follow later GPS results.
function CenterOnSelection({ value }: { value: Coordinates | null }) {
  const map = useMap();
  useEffect(() => {
    if (value) map.panTo([value.lat, value.lng]);
  }, [map, value]);
  return null;
}

export default function LocationPickerMap({value, onChange, defaultCenter = { lat: 40.7831, lng: -73.9712 }, zoom = 12}: LocationPickerMapProps) {
  const center = value ?? defaultCenter;

  return (
    <>
      <div
        style={{
          marginLeft: "8.5vw",
          width: "50vw",
          height: "50vw",
          borderRadius: "4px",
          overflow: "hidden",
          border: "1px solid #36363c",
          backgroundColor: "#09090a",
        }}
      >
        <MapContainer
          center={[center.lat, center.lng]}
          zoom={zoom}
          style={{ height: "50vh", width: "50vw" }}
        >
          <TileLayer
            url={TILE_URL}
            tileSize={TOKEN ? 512 : 256}
            zoomOffset={TOKEN ? -1 : 0}
            attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          <ClickHandler onSelect={onChange} />
          <CenterOnSelection value={value} />
          {value && (
            <Marker position={[value.lat, value.lng]} icon={pinIcon} />
          )}
        </MapContainer>
      </div>

      <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", opacity: 0.8 }}>
        {value
          ? `Selected: ${value.lat}, ${value.lng}`
          : "Tap or click on the map to set a location."}
      </p>
    </>
  );
}

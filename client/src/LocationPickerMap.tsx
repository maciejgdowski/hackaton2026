import L from "leaflet";
import { Circle, CircleMarker, MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";
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
  radius?: number; // play area in metres, drawn around the pin
  myLocation?: Coordinates | null; // where I am right now (white dot, same as in the game)
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
// With a radius, zoom so the whole play area fits.
function CenterOnSelection({ value, radius }: { value: Coordinates | null; radius?: number }) {
  const map = useMap();
  useEffect(() => {
    if (!value) return;
    if (radius) {
      map.fitBounds(L.latLng(value.lat, value.lng).toBounds(radius * 2.4));
    } else {
      map.panTo([value.lat, value.lng]);
    }
  }, [map, value, radius]);
  return null;
}

export default function LocationPickerMap({value, onChange, defaultCenter = { lat: 40.7831, lng: -73.9712 }, zoom = 12, radius, myLocation}: LocationPickerMapProps) {
  const center = value ?? defaultCenter;

  return (
    <>
      <div
        style={{
          margin: "0 auto",
          width: "78cqw",
          height: "32cqh",
          borderRadius: "4px",
          overflow: "hidden",
          border: "1px solid #36363c",
          backgroundColor: "#09090a",
        }}
      >
        <MapContainer
          center={[center.lat, center.lng]}
          zoom={zoom}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer
            url={TILE_URL}
            tileSize={TOKEN ? 512 : 256}
            zoomOffset={TOKEN ? -1 : 0}
            attribution='&copy; <a href="https://www.mapbox.com/">Mapbox</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          <ClickHandler onSelect={onChange} />
          <CenterOnSelection value={value} radius={radius} />
          {value && radius && (
            <Circle
              center={[value.lat, value.lng]}
              radius={radius}
              pathOptions={{ color: "#f2f2f0", weight: 2, fillOpacity: 0.05 }}
            />
          )}
          {value && (
            <Marker position={[value.lat, value.lng]} icon={pinIcon} />
          )}
          {myLocation && (
            <CircleMarker
              center={[myLocation.lat, myLocation.lng]}
              radius={6}
              pathOptions={{ color: "#09090a", weight: 2, fillColor: "#34d399", fillOpacity: 1 }}
            />
          )}
        </MapContainer>
      </div>

      <p style={{ margin: "0.5cqh 0 0", fontSize: "0.7rem", opacity: 0.8 }}>
        {value
          ? `Selected: ${value.lat}, ${value.lng}`
          : "Tap or click on the map to set a location."}
      </p>
    </>
  );
}

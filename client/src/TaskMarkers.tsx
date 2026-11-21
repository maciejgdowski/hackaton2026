import L from "leaflet";
import { Circle, Marker, Polyline } from "react-leaflet";

// Towers and download points on the game map.
// Tower = antenna icon with its letter and 3 pips (which of its data it already has).
// Point = small diamond with its name (A1, A2, A3), linked to its tower by a faint dashed line.

export interface Tower {
  id: string;
  lat: number;
  lng: number;
  delivered: boolean[];
}

export interface TaskPoint {
  id: string;
  towerId: string;
  index: number;
  lat: number;
  lng: number;
}

interface TaskMarkersProps {
  towers: Tower[];
  points: TaskPoint[];
  carrying: string | null; // point whose data I carry
  downloading: string | null; // point I'm downloading at
  rangeM: number; // how close you have to be (drawn around the active point / tower)
}

const ANTENNA_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
  <path d="M12 9 7.5 21M12 9l4.5 12M9.2 16.5h5.6"/>
  <circle cx="12" cy="7.5" r="1.5" fill="currentColor"/>
  <path d="M8.6 4.2a5 5 0 0 0 0 6.6M15.4 4.2a5 5 0 0 1 0 6.6"/>
</svg>`;

function towerIcon(tower: Tower, isTarget: boolean) {
  const pips = tower.delivered
    .map((done) => `<span class="task-pip${done ? " is-done" : ""}"></span>`)
    .join("");
  return L.divIcon({
    className: "task-icon",
    html: `<div class="task-tower${isTarget ? " is-target" : ""}">${ANTENNA_SVG}<span class="task-label">${tower.id}</span><span class="task-pips">${pips}</span></div>`,
    iconSize: [44, 58],
    iconAnchor: [22, 29],
  });
}

function pointIcon(point: TaskPoint, state: "" | "is-downloading" | "is-carried") {
  return L.divIcon({
    className: "task-icon",
    html: `<div class="task-point ${state}"><span class="task-diamond"></span><span class="task-label">${point.id}</span></div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 11],
  });
}

export default function TaskMarkers({ towers, points, carrying, downloading, rangeM }: TaskMarkersProps) {
  const carriedPoint = points.find((point) => point.id === carrying);
  const targetTower = carriedPoint ? towers.find((tower) => tower.id === carriedPoint.towerId) : undefined;
  const downloadPoint = points.find((point) => point.id === downloading);

  return (
    <>
      {points.map((point) => {
        const tower = towers.find((t) => t.id === point.towerId);
        if (!tower) return null;
        return (
          <Polyline
            key={`line-${point.id}`}
            positions={[[point.lat, point.lng], [tower.lat, tower.lng]]}
            pathOptions={{ color: "#6e6e75", weight: 1, opacity: 0.5, dashArray: "3 5" }}
          />
        );
      })}

      {/* how close you have to stand: around the point you download at / the tower you deliver to */}
      {downloadPoint && (
        <Circle
          center={[downloadPoint.lat, downloadPoint.lng]}
          radius={rangeM}
          pathOptions={{ color: "#f2f2f0", weight: 1, dashArray: "2 4", fillOpacity: 0.06 }}
        />
      )}
      {targetTower && (
        <Circle
          center={[targetTower.lat, targetTower.lng]}
          radius={rangeM}
          pathOptions={{ color: "#f2f2f0", weight: 1, dashArray: "2 4", fillOpacity: 0.06 }}
        />
      )}

      {points.map((point) => {
        let state: "" | "is-downloading" | "is-carried" = "";
        if (point.id === carrying) state = "is-carried";
        else if (point.id === downloading) state = "is-downloading";
        return <Marker key={point.id} position={[point.lat, point.lng]} icon={pointIcon(point, state)} />;
      })}

      {towers.map((tower) => (
        <Marker
          key={tower.id}
          position={[tower.lat, tower.lng]}
          icon={towerIcon(tower, tower.id === targetTower?.id)}
          zIndexOffset={500}
        />
      ))}
    </>
  );
}

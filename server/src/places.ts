// Where the towers and download points go.
// Every spot is checked with Mapbox: not in water, not inside a building, and next to a road or path
// you can walk on. Without a token (or if Mapbox doesn't answer) spots are just random inside the zone.
//
// Checking takes ~15 s (Mapbox only allows a few requests a second), so app.ts runs checkArea
// in the background as soon as a lobby is created, and placeTasks uses its result at Start.

import { distanceMeters, type Coordinates } from "./game.ts";
import { env } from "./env.ts";

export interface TaskLayout {
  towers: Coordinates[];
  points: Coordinates[][]; // 3 download points for every tower
}

const POINTS_PER_TOWER = 3;
const EDGE_MARGIN_M = 10; // keep spots this far inside the border
const POINT_MIN_FROM_TOWER_M = 30; // so delivering data means walking
const SPOT_SPACING_M = 15; // no two spots closer than this
const PATH_MAX_DISTANCE_M = 15; // a walkable road or path must be this close
const CANDIDATES = 100; // random spots checked with Mapbox, the layout is picked from the good ones
const PARALLEL_REQUESTS = 4; // Mapbox answers 429 (too many requests) if we ask much faster
const PAUSE_MS = 500; // between batches: 4 requests per half second

// Road classes in mapbox-streets-v8 you can't (or shouldn't) walk along
const NOT_WALKABLE = ["motorway", "motorway_link", "trunk", "trunk_link", "major_rail", "minor_rail", "service_rail", "aerialway", "ferry"];

// A random spot between minM and maxM metres from center (spread evenly over the area).
function randomSpot(center: Coordinates, minM: number, maxM: number): Coordinates {
  const meters = Math.sqrt(Math.random() * (maxM * maxM - minM * minM) + minM * minM);
  const angle = Math.random() * 2 * Math.PI;
  const north = meters * Math.cos(angle);
  const east = meters * Math.sin(angle);
  return {
    lat: center.lat + north / 111_320,
    lng: center.lng + east / (111_320 * Math.cos((center.lat * Math.PI) / 180)),
  };
}

// Asks Mapbox what is at this spot. true = fine to put a task here.
async function isWalkable(spot: Coordinates): Promise<boolean> {
  const url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${spot.lng},${spot.lat}.json`
    + `?radius=${PATH_MAX_DISTANCE_M}&limit=20&layers=water,building,road&access_token=${env.MAPBOX_TOKEN}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Mapbox tilequery ${response.status}`);
  const data = await response.json() as {
    features?: { properties: { class?: string; tilequery: { layer: string; distance: number } } }[];
  };

  let nearPath = false;
  for (const feature of data.features ?? []) {
    const { layer, distance } = feature.properties.tilequery;
    if ((layer === "water" || layer === "building") && distance === 0) return false; // standing in it
    if (layer === "road" && !NOT_WALKABLE.includes(feature.properties.class ?? "")) nearPath = true;
  }
  return nearPath;
}

// Checks many spots (PARALLEL_REQUESTS at a time). Returns only the good ones.
// A spot Mapbox didn't answer for is just skipped; if Mapbox keeps failing we stop asking.
async function checkSpots(spots: Coordinates[]): Promise<Coordinates[]> {
  const good: Coordinates[] = [];
  let failures = 0;
  for (let i = 0; i < spots.length && failures < 10; i += PARALLEL_REQUESTS) {
    const batch = spots.slice(i, i + PARALLEL_REQUESTS);
    const results = await Promise.all(batch.map((spot) => isWalkable(spot).catch(() => null)));
    for (let j = 0; j < batch.length; j++) {
      if (results[j] === null) failures++;
      else if (results[j]) good.push(batch[j]);
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  if (failures > 0) console.error(`Mapbox did not answer for ${failures} spots`);
  return good;
}

function farFromAll(spot: Coordinates, taken: Coordinates[], spacing: number) {
  return taken.every((other) => distanceMeters(spot, other) >= spacing);
}

// Picks a spot from `pool` that passes `fits`, trying looser spacing if needed.
// Falls back to an unchecked random spot so the game can always start.
function pick(
  pool: Coordinates[],
  taken: Coordinates[],
  spacing: number,
  fits: (spot: Coordinates) => boolean,
  fallback: () => Coordinates,
): Coordinates {
  for (const tryspacing of [spacing, spacing / 2, 0]) {
    const index = pool.findIndex((spot) => fits(spot) && farFromAll(spot, taken, tryspacing));
    if (index >= 0) {
      const [spot] = pool.splice(index, 1);
      taken.push(spot);
      return spot;
    }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const spot = fallback();
    if (fits(spot) && farFromAll(spot, taken, spacing / 2)) {
      taken.push(spot);
      return spot;
    }
  }
  const spot = fallback();
  taken.push(spot);
  return spot;
}

// Random spots inside the zone that Mapbox says are fine. Empty without a token.
export async function checkArea(center: Coordinates, radius: number): Promise<Coordinates[]> {
  if (!env.MAPBOX_TOKEN) return [];
  const candidates: Coordinates[] = [];
  for (let i = 0; i < CANDIDATES; i++) candidates.push(randomSpot(center, 0, radius - EDGE_MARGIN_M));
  return checkSpots(candidates);
}

// Picks the towers and their points from the checked spots (goodSpots from checkArea).
export function placeTasks(center: Coordinates, radius: number, towerCount: number, goodSpots: Coordinates[]): TaskLayout {
  const usable = radius - EDGE_MARGIN_M;
  const pool = [...goodSpots];
  const insideZone = (spot: Coordinates) => distanceMeters(center, spot) <= usable;
  const taken: Coordinates[] = [];

  // Towers: spread out over the inner part of the zone
  const towerSpacing = Math.max(30, radius * 0.4);
  const towers: Coordinates[] = [];
  for (let i = 0; i < towerCount; i++) {
    towers.push(pick(
      pool,
      taken,
      towerSpacing,
      (spot) => distanceMeters(center, spot) <= usable * 0.8,
      () => randomSpot(center, 0, usable * 0.8),
    ));
  }

  // Points: around their tower, but at least POINT_MIN_FROM_TOWER_M away from it
  const pointMax = Math.max(POINT_MIN_FROM_TOWER_M + 20, radius * 0.6);
  const points = towers.map((tower) => {
    const set: Coordinates[] = [];
    for (let i = 0; i < POINTS_PER_TOWER; i++) {
      set.push(pick(
        pool,
        taken,
        SPOT_SPACING_M,
        (spot) => {
          const fromTower = distanceMeters(tower, spot);
          return insideZone(spot) && fromTower >= POINT_MIN_FROM_TOWER_M && fromTower <= pointMax;
        },
        () => randomSpot(tower, POINT_MIN_FROM_TOWER_M, pointMax),
      ));
    }
    return set;
  });

  return { towers, points };
}

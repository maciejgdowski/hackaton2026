// The player's last known location, saved on the welcome page.
// The background map is centered on it and the pages show its place name ("Poland - Warsaw").

const TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const DEFAULT_PLACE = "United States - New York";

export interface SavedLocation {
  lat: number;
  lng: number;
}

export function getSavedLocation(): SavedLocation | null {
  try {
    const saved = JSON.parse(localStorage.getItem("lastLocation") ?? "null");
    if (saved && Number.isFinite(saved.lat) && Number.isFinite(saved.lng)) return saved;
  } catch {
    // broken value in storage
  }
  return null;
}

export function getPlaceName() {
  return localStorage.getItem("placeName") ?? DEFAULT_PLACE;
}

// Asks for location access (the browser shows the prompt) and saves where we are.
export function requestLocation(): Promise<SavedLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not support location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const location = { lat: position.coords.latitude, lng: position.coords.longitude };
        localStorage.setItem("lastLocation", JSON.stringify(location));
        resolve(location);
      },
      (error) => reject(new Error(`Location: ${error.message}`)),
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 10_000 }
    );
  });
}

// Looks up "Country - City" for a location and saves it.
export async function savePlaceName(location: SavedLocation) {
  if (!TOKEN) return;
  try {
    const response = await fetch(
      `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${location.lng}&latitude=${location.lat}&types=place&language=en&access_token=${TOKEN}`
    );
    if (!response.ok) return;
    const data = await response.json();
    const properties = data.features?.[0]?.properties;
    if (!properties) return;
    const city = properties.name;
    const country = properties.context?.country?.name;
    localStorage.setItem("placeName", country ? `${country} - ${city}` : city);
  } catch {
    // keep the old name
  }
}

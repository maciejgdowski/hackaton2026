// World: one MapLibre map behind every screen.
//   menu  → dark 3D globe, slowly spinning
//   lobby → camera flies down to a 1 km × 1 km view around you; only your dot, with a radar pulse
//   game  → interactive map with the zone circle and player dots
// Map data: OpenFreeMap "dark" style (free, no key), tweaked to pure monochrome.

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const SPIN_DEG_PER_S = 3;
const LOBBY_VIEW_M = 1000;
const PULSE_MS = 2600;
const METERS_PER_PIXEL_AT_ZOOM_0 = 78_271.517; // 512 px tiles, at the equator

const EMPTY = { type: 'FeatureCollection', features: [] };

let map = null;
let loaded = false;
let mode = 'menu';
let spinning = true;
let homed = false;      // camera has flown down to the player
let me = null;          // { lat, lon }
let zoneKey = '';
let zoneFeature = null;
let lastLobbyPadding = '';
let lastFrame = 0;

const pending = [];     // calls made before the style finished loading
const whenLoaded = fn => (loaded ? fn() : pending.push(fn));

// ---------- geometry ----------

function circlePolygon(lat, lon, radiusM, points = 72) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} };
}

const point = (lon, lat, properties = {}) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties });

// ---------- style ----------

function monochrome(style) {
  style.projection = { type: 'globe' };
  // Faint white rim around the globe that fades out as we zoom in.
  style.sky = {
    'sky-color': '#000000', 'horizon-color': '#3a3a3a', 'fog-color': '#000000',
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 8, 0]
  };
  for (const layer of style.layers) {
    if (layer.id === 'background') layer.paint['background-color'] = '#141414'; // land
    if (layer.id === 'water') layer.paint['fill-color'] = '#030303';
    if (layer.id === 'waterway') layer.paint['line-color'] = '#030303';
    if (/^place_(country|state)/.test(layer.id)) layer.minzoom = 4;           // clean globe: no country names
  }
  return style;
}

// ---------- layout ----------

const isWide = () => window.innerWidth >= 900;
const spaceZoom = () => (isWide() ? 1.75 : 1.15);

// Menu: globe above the title on phones, to the right of the panel on wide screens.
const menuPadding = () => (isWide()
  ? { top: 0, bottom: 0, right: 0, left: Math.round(window.innerWidth * 0.42) }
  : { top: 0, left: 0, right: 0, bottom: Math.round(window.innerHeight * 0.38) });

// Lobby: keep the 1 km view clear of the panel (bottom sheet on phones, left panel on desktop).
function lobbyPadding() {
  if (isWide()) return { top: 40, bottom: 40, right: 40, left: Math.round(Math.max(48, window.innerWidth * 0.06) + 520) };
  const sheet = document.getElementById('lobby');
  const sheetHeight = sheet && !sheet.hidden ? sheet.offsetHeight : Math.round(window.innerHeight * 0.55);
  return { top: 30, left: 16, right: 16, bottom: Math.min(sheetHeight, window.innerHeight - 220) + 10 };
}

// Camera that fits LOBBY_VIEW_M metres into the free part of the screen.
function lobbyCamera(lat, lon) {
  const padding = lobbyPadding();
  lastLobbyPadding = JSON.stringify(padding);
  const freePx = Math.max(120, Math.min(
    window.innerWidth - padding.left - padding.right,
    window.innerHeight - padding.top - padding.bottom));
  const metersPerPixel = LOBBY_VIEW_M / freePx;
  const zoom = Math.log2((METERS_PER_PIXEL_AT_ZOOM_0 * Math.cos((lat * Math.PI) / 180)) / metersPerPixel);
  return { center: [lon, lat], zoom, bearing: 0, padding };
}

// The lobby sheet grows as players join → keep the view centred in the free area.
function refitLobby() {
  if (!loaded || mode !== 'lobby' || !homed || !me || map.isMoving()) return;
  if (JSON.stringify(lobbyPadding()) !== lastLobbyPadding) map.easeTo({ ...lobbyCamera(me.lat, me.lon), duration: 700 });
}

function setInteractive(on) {
  for (const handler of ['dragPan', 'scrollZoom', 'touchZoomRotate', 'doubleClickZoom', 'keyboard', 'boxZoom'])
    on ? map[handler].enable() : map[handler].disable();
  map.dragRotate.disable();
  map.touchPitch.disable();
  if (on) map.touchZoomRotate.disableRotation();
}

// ---------- animation ----------

function spin(t) {
  if (map && spinning && !map.isMoving()) {
    const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
    const center = map.getCenter();
    map.jumpTo({ center: [((center.lng + SPIN_DEG_PER_S * dt + 540) % 360) - 180, center.lat] });
  }
  lastFrame = t;
  requestAnimationFrame(spin);
}

// Radar pulse around your dot: two rings half a cycle apart, each fading out before it restarts.
function pulse(t) {
  if (loaded && mode === 'lobby' && me) {
    ['me-pulse', 'me-pulse2'].forEach((id, i) => {
      const k = ((t + (i * PULSE_MS) / 2) % PULSE_MS) / PULSE_MS;
      map.setPaintProperty(id, 'circle-radius', 8 + 46 * k);
      map.setPaintProperty(id, 'circle-stroke-opacity', 0.7 * Math.min(1, k / 0.15) * (1 - k) ** 1.5);
    });
  }
  requestAnimationFrame(pulse);
}

function drawMe() {
  if (!loaded) return;
  const visible = me && mode === 'lobby';
  map.getSource('me').setData(visible ? { type: 'FeatureCollection', features: [point(me.lon, me.lat)] } : EMPTY);
}

function clearGameLayers() {
  map.getSource('zone').setData(EMPTY);
  map.getSource('dots').setData(EMPTY);
}

function fitZone() {
  const ring = zoneFeature?.geometry.coordinates[0];
  if (!ring) return;
  const lons = ring.map(p => p[0]);
  const lats = ring.map(p => p[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, duration: 1500 });
}

function addLayers() {
  map.addSource('zone', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.04 } });
  map.addLayer({ id: 'zone-line', type: 'line', source: 'zone',
    paint: { 'line-color': '#ffffff', 'line-opacity': 0.7, 'line-width': 1.2, 'line-dasharray': [3, 3] } });

  map.addSource('dots', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'dots', type: 'circle', source: 'dots', paint: {
    'circle-radius': ['case', ['get', 'self'], 7, 6],
    'circle-color': ['case', ['get', 'self'], '#ffffff', '#9a9a9a'],
    'circle-stroke-color': '#000000', 'circle-stroke-width': 2
  } });

  map.addSource('me', { type: 'geojson', data: EMPTY });
  for (const id of ['me-pulse', 'me-pulse2']) {
    map.addLayer({ id, type: 'circle', source: 'me', paint: {
      'circle-radius': 8, 'circle-opacity': 0,
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0
    } });
  }
  map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: {
    'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#000000', 'circle-stroke-width': 2
  } });
}

// ---------- public API ----------

async function init(containerId) {
  if (!window.maplibregl) return;
  let style;
  try {
    style = monochrome(await (await fetch(STYLE_URL)).json());
  } catch {
    return; // no map: the screens still work on black
  }

  map = new maplibregl.Map({
    container: containerId, style, center: [19, 35], zoom: spaceZoom(), padding: menuPadding(),
    attributionControl: { compact: true }, maxPitch: 0, renderWorldCopies: false, fadeDuration: 300
  });
  setInteractive(false);

  map.on('load', () => {
    if (mode !== 'game' && !homed) map.setPadding(menuPadding());
    addLayers();
    loaded = true;
    pending.splice(0).forEach(fn => fn());
    requestAnimationFrame(pulse);
    document.documentElement.classList.add('world-ready');
  });
  requestAnimationFrame(spin);

  window.addEventListener('resize', () => { if (loaded && spinning) map.setPadding(menuPadding()); });
  const sheet = document.getElementById('lobby');
  if (sheet && window.ResizeObserver) new ResizeObserver(refitLobby).observe(sheet);
  map.on('moveend', refitLobby);
}

export const World = {
  init,

  // Fly down to a 1 km view around a position (only the first time, unless forced).
  home(lat, lon, { force = false } = {}) {
    me = { lat, lon };
    whenLoaded(() => {
      drawMe();
      if (homed && !force) return;
      homed = true;
      spinning = false;
      map.flyTo({ ...lobbyCamera(lat, lon), duration: 4500, curve: 1.6, essential: true });
    });
  },

  // Your latest position (the lobby shows only you).
  me(lat, lon) {
    me = { lat, lon };
    whenLoaded(drawMe);
  },

  // Back out to the spinning globe.
  space() {
    homed = false;
    zoneKey = '';
    zoneFeature = null;
    me = null;
    whenLoaded(() => {
      clearGameLayers();
      setInteractive(false);
      map.flyTo({ center: [map.getCenter().lng, 35], zoom: spaceZoom(), duration: 3000, essential: true, padding: menuPadding() });
      map.once('moveend', () => { spinning = true; });
    });
  },

  setMode(next) {
    if (next === mode) return;
    mode = next;
    whenLoaded(() => setInteractive(next === 'game'));
    if (next !== 'game') {
      zoneKey = '';
      whenLoaded(clearGameLayers);
    }
    if (next === 'lobby' && homed && me) whenLoaded(() => map.flyTo({ ...lobbyCamera(me.lat, me.lon), duration: 2000, essential: true }));
    if (next === 'game') whenLoaded(() => map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }));
    whenLoaded(drawMe);
  },

  // In game: draw the zone (fit to it the first time) and the player dots.
  show(zone, dots) {
    whenLoaded(() => {
      const key = `${zone.latitude},${zone.longitude},${zone.radius}`;
      if (key !== zoneKey) {
        zoneKey = key;
        spinning = false;
        homed = true;
        zoneFeature = circlePolygon(zone.latitude, zone.longitude, zone.radius);
        map.getSource('zone').setData(zoneFeature);
        fitZone();
      }
      map.getSource('dots').setData({ type: 'FeatureCollection', features: dots.map(d => point(d.lon, d.lat, { self: !!d.self })) });
    });
  },

  fitZone: () => whenLoaded(fitZone)
};

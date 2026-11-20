// World: one MapLibre map behind every screen.
//   menu  -> dark 3D globe, slowly spinning
//   join  -> camera flies from space down to your GPS position (lobby fades in on top)
//   game  -> same map, interactive, with the 100 m zone and player dots
// Map data: OpenFreeMap "dark" vector style (free, no key), tweaked to pure monochrome.
'use strict';
window.World = (() => {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
  const HOME_ZOOM = 16.5, SPIN_DEG_PER_S = 3;
  let map = null, loaded = false, spinning = true, lastFrame = 0, mode = 'menu', homed = false, zoneKey = '', zoneFeature = null;
  const pending = [];                                   // calls made before the style loaded
  const whenLoaded = fn => (loaded ? fn() : pending.push(fn));

  const circle = (lat, lon, r, n = 72) => {             // GeoJSON polygon approximating a circle
    const pts = [], dLat = r / 111320, dLon = r / (111320 * Math.cos(lat * Math.PI / 180));
    for (let i = 0; i <= n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  };
  const empty = { type: 'FeatureCollection', features: [] };

  function monochrome(style) {
    style.projection = { type: 'globe' };
    // Faint white rim around the globe, fading out as we zoom in.
    style.sky = { 'sky-color': '#000000', 'horizon-color': '#3a3a3a', 'fog-color': '#000000',
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 0.9, 5, 0.6, 8, 0] };
    for (const l of style.layers) {
      if (l.id === 'background') l.paint['background-color'] = '#141414';          // land
      if (l.id === 'water') l.paint['fill-color'] = '#030303';                     // sea: darker than land
      if (l.id === 'waterway') l.paint['line-color'] = '#030303';
      if (/^place_(country|state)/.test(l.id)) l.minzoom = 4;                     // clean globe: no country names
    }
    return style;
  }

  // In the menu the globe sits in the upper part of the screen, above the title.
  // Wide screens: globe on the right half, the panel sits on the left.
  const wide = () => window.innerWidth >= 900;
  const spaceZoom = () => (wide() ? 1.75 : 1.15);
  const menuPadding = () => wide()
    ? { top: 0, bottom: 0, right: 0, left: Math.round(window.innerWidth * 0.42) }
    : { top: 0, left: 0, right: 0, bottom: Math.round(window.innerHeight * 0.38) };

  function setInteractive(on) {
    for (const h of ['dragPan', 'scrollZoom', 'touchZoomRotate', 'doubleClickZoom', 'keyboard', 'boxZoom'])
      on ? map[h].enable() : map[h].disable();
    map.dragRotate.disable(); map.touchPitch.disable();
    if (on) map.touchZoomRotate.disableRotation();
  }

  function spin(t) {
    if (map && spinning && !map.isMoving()) {
      const dt = lastFrame ? Math.min(0.1, (t - lastFrame) / 1000) : 0;
      const c = map.getCenter();
      map.jumpTo({ center: [((c.lng + SPIN_DEG_PER_S * dt + 540) % 360) - 180, c.lat] });
    }
    lastFrame = t;
    requestAnimationFrame(spin);
  }

  async function init(container) {
    if (!window.maplibregl) return;
    let style;
    try { style = monochrome(await (await fetch(STYLE_URL)).json()); }
    catch { return; }                                   // no map: the screens still work on black
    map = new maplibregl.Map({ container, style, center: [19, 35], zoom: spaceZoom(), padding: menuPadding(), attributionControl: { compact: true },
      maxPitch: 0, renderWorldCopies: false, fadeDuration: 300 });
    setInteractive(false);
    map.on('load', () => {
      if (mode !== 'game' && !homed) map.setPadding(menuPadding());
      map.addSource('zone', { type: 'geojson', data: empty });
      map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.04 } });
      map.addLayer({ id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': '#ffffff', 'line-opacity': 0.7, 'line-width': 1.2, 'line-dasharray': [3, 3] } });
      map.addSource('dots', { type: 'geojson', data: empty });
      map.addLayer({ id: 'dots', type: 'circle', source: 'dots', paint: {
        'circle-radius': ['case', ['get', 'self'], 7, 6], 'circle-color': ['case', ['get', 'self'], '#ffffff', '#9a9a9a'],
        'circle-stroke-color': '#000000', 'circle-stroke-width': 2 } });
      loaded = true;
      pending.splice(0).forEach(fn => fn());
      document.documentElement.classList.add('world-ready');
    });
    requestAnimationFrame(spin);
    window.addEventListener('resize', () => { if (loaded && spinning) map.setPadding(menuPadding()); });
  }

  function fitZone() {
    const ring = zoneFeature?.geometry.coordinates[0];
    if (!ring) return;
    const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, duration: 1500 });
  }

  return {
    init,
    // Fly from wherever we are down to a position (once per session unless forced).
    home(lat, lon, { force = false } = {}) {
      whenLoaded(() => {
        if (homed && !force) return;
        homed = true; spinning = false;
        map.flyTo({ center: [lon, lat], zoom: HOME_ZOOM, duration: 4500, curve: 1.6, essential: true, padding: { top: 0, bottom: 0, left: 0, right: 0 } });
      });
    },
    // Back out to the spinning globe (quit / left the lobby).
    space() {
      homed = false; zoneKey = ''; zoneFeature = null;
      whenLoaded(() => {
        map.getSource('zone').setData(empty); map.getSource('dots').setData(empty);
        setInteractive(false);
        map.flyTo({ center: [map.getCenter().lng, 35], zoom: spaceZoom(), duration: 3000, essential: true, padding: menuPadding() });
        map.once('moveend', () => { spinning = true; });
      });
    },
    setMode(m) {
      if (m === mode) return;
      mode = m;
      whenLoaded(() => setInteractive(m === 'game'));
      if (m !== 'game') { zoneKey = ''; whenLoaded(() => { map.getSource('zone').setData(empty); map.getSource('dots').setData(empty); }); }
    },
    // In game: draw the zone (fit to it the first time) and the dots.
    show(zone, dots) {
      whenLoaded(() => {
        const key = `${zone.latitude},${zone.longitude},${zone.radius}`;
        if (key !== zoneKey) {
          zoneKey = key; spinning = false; homed = true;
          zoneFeature = circle(zone.latitude, zone.longitude, zone.radius);
          map.getSource('zone').setData(zoneFeature);
          fitZone();
        }
        map.getSource('dots').setData({ type: 'FeatureCollection', features: dots.map(d => (
          { type: 'Feature', geometry: { type: 'Point', coordinates: [d.lon, d.lat] }, properties: { self: !!d.self } })) });
      });
    },
    fitZone: () => whenLoaded(fitZone),
  };
})();

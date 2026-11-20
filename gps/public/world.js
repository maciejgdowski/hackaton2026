// World: one MapLibre map behind every screen.
//   menu  -> dark 3D globe, slowly spinning
//   join  -> camera flies from space down to a 1 km × 1 km view of your area (lobby on top),
//            only your own position is shown, with a slow radar pulse
//   game  -> same map, interactive, with the 100 m zone and player dots
// Map data: OpenFreeMap "dark" vector style (free, no key), tweaked to pure monochrome.
'use strict';
window.World = (() => {
  const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
  const SPIN_DEG_PER_S = 3, LOBBY_VIEW_M = 1000, PULSE_MS = 2600;
  let me = null, lastPad = '', map = null, loaded = false, spinning = true, lastFrame = 0, mode = 'menu', homed = false, zoneKey = '', zoneFeature = null;
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

  // Lobby: keep the 1 km box clear of the panel (bottom sheet on phones, left panel on desktop).
  function lobbyPadding() {
    const sheet = document.getElementById('lobby');
    if (wide()) return { top: 40, bottom: 40, right: 40, left: Math.round(Math.max(48, window.innerWidth * 0.06) + 520) };
    const h = sheet && !sheet.hidden ? sheet.offsetHeight : Math.round(window.innerHeight * 0.55);
    return { top: 30, left: 16, right: 16, bottom: Math.min(h, window.innerHeight - 220) + 10 };
  }
  // Camera that fits LOBBY_VIEW_M metres into the free part of the screen (not under the panel).
  function lobbyCamera(lat, lon) {
    const pad = lobbyPadding();
    lastPad = JSON.stringify(pad);
    const freePx = Math.max(120, Math.min(window.innerWidth - pad.left - pad.right, window.innerHeight - pad.top - pad.bottom));
    const metresPerPx = LOBBY_VIEW_M / freePx;
    const zoom = Math.log2(78271.517 * Math.cos(lat * Math.PI / 180) / metresPerPx);   // 512 px tiles
    return { center: [lon, lat], zoom, bearing: 0, padding: pad };
  }

  // Radar pulse around your own dot in the lobby: two rings half a cycle apart. Each ring fades in
  // as it leaves the dot and fades fully out before it restarts, so there is no visible snap back.
  function pulse(t) {
    if (loaded && mode === 'lobby' && me) {
      ['me-pulse', 'me-pulse2'].forEach((id, i) => {
        const k = ((t + i * PULSE_MS / 2) % PULSE_MS) / PULSE_MS;
        map.setPaintProperty(id, 'circle-radius', 8 + 46 * k);
        map.setPaintProperty(id, 'circle-stroke-opacity', 0.7 * Math.min(1, k / 0.15) * (1 - k) ** 1.5);
      });
    }
    requestAnimationFrame(pulse);
  }
  function showMe() {
    if (!loaded) return;
    const fc = me && mode === 'lobby' ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [me.lon, me.lat] }, properties: { self: true } }] } : empty;
    map.getSource('me').setData(fc);
  }

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
      map.addSource('me', { type: 'geojson', data: empty });
      for (const id of ['me-pulse', 'me-pulse2'])
        map.addLayer({ id, type: 'circle', source: 'me', paint: { 'circle-radius': 8, 'circle-color': '#ffffff', 'circle-opacity': 0,
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0 } });
      map.addLayer({ id: 'me-dot', type: 'circle', source: 'me', paint: { 'circle-radius': 7, 'circle-color': '#ffffff', 'circle-stroke-color': '#000000', 'circle-stroke-width': 2 } });
      loaded = true;
      pending.splice(0).forEach(fn => fn());
      requestAnimationFrame(pulse);
      document.documentElement.classList.add('world-ready');
    });
    requestAnimationFrame(spin);
    window.addEventListener('resize', () => { if (loaded && spinning) map.setPadding(menuPadding()); });
    // Lobby sheet grows/shrinks as players join -> keep your 1 km view centred in the free area.
    // Checked when the sheet resizes and whenever a camera move ends (it may have grown mid-flight).
    const sheet = document.getElementById('lobby');
    const refit = () => {
      if (!loaded || mode !== 'lobby' || !homed || !me || map.isMoving()) return;
      const pad = JSON.stringify(lobbyPadding());
      if (pad !== lastPad) map.easeTo({ ...lobbyCamera(me.lat, me.lon), duration: 700 });
    };
    if (sheet && window.ResizeObserver) new ResizeObserver(refit).observe(sheet);
    map.on('moveend', refit);
  }

  function fitZone() {
    const ring = zoneFeature?.geometry.coordinates[0];
    if (!ring) return;
    const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 40, duration: 1500 });
  }

  return {
    init,
    // Fly from wherever we are down to a 1 km × 1 km view around a position (once unless forced).
    home(lat, lon, { force = false } = {}) {
      me = { lat, lon };
      whenLoaded(() => {
        showMe();
        if (homed && !force) return;
        homed = true; spinning = false;
        map.flyTo({ ...lobbyCamera(lat, lon), duration: 4500, curve: 1.6, essential: true });
      });
    },
    // Your latest position (lobby shows only you).
    me(lat, lon) { me = { lat, lon }; whenLoaded(showMe); },
    // Back out to the spinning globe (quit / left the lobby).
    space() {
      homed = false; zoneKey = ''; zoneFeature = null; me = null;
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
      // Back in the lobby after a round: re-frame the 1 km view around you.
      if (m === 'lobby' && homed && me) whenLoaded(() => map.flyTo({ ...lobbyCamera(me.lat, me.lon), duration: 2000, essential: true }));
      if (m === 'game') whenLoaded(() => map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }));   // full-screen map
      whenLoaded(showMe);
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

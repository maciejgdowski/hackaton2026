const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('fieldwork-session');
let state, map, zone, markers, watchId, polling = false, lastUpload = 0, serverOffset = 0;
const showError = message => { $('error').textContent = message; $('error').hidden = !message; };

async function api(path, body) {
  const response = await fetch(`./api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) resetSession();
    throw new Error(data.error);
  }
  return data;
}

function resetSession() {
  token = null; state = null;
  sessionStorage.removeItem('fieldwork-session');
  if (watchId !== undefined) navigator.geolocation.clearWatch(watchId);
  watchId = undefined;
  if (map) map.remove();
  map = null; zone = null;
  $('map').style.display = 'none';
  $('map-placeholder').hidden = false;
  $('recenter').hidden = true;
  $('entry').hidden = false;
  $('session').hidden = true;
  $('update-status').textContent = 'Waiting for the game to begin';
  $('map-title').textContent = 'Your surroundings become the game.';
}

function render(data) {
  state = data;
  serverOffset = data.serverTime - Date.now();
  $('entry').hidden = true; $('session').hidden = false;
  const playing = data.phase === 'playing';
  const host = data.self.id === data.hostId;
  $('phase').textContent = playing ? 'In the field' : 'Game lobby';
  $('count').textContent = `${data.players.length} players`;
  $('players').replaceChildren(...data.players.map(p => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = p.name;
    const badge = document.createElement('span'); badge.textContent = [p.id === data.self.id && 'You', p.id === data.hostId && 'Host'].filter(Boolean).join(' · ');
    li.append(name, badge); return li;
  }));
  $('start').hidden = playing || !host;
  $('start').disabled = data.players.length < 2;
  $('leave').hidden = playing;
  $('waiting').textContent = playing ? `Position updates every ${data.updateInterval} seconds. Other players’ roles are hidden.` : host ? 'Start with at least 2 players. Your location at start sets the zone.' : 'Waiting for the host to start the game.';
  $('role').hidden = !playing;
  if (!playing) return;
  $('role').className = `role ${data.self.role}`;
  $('role').textContent = data.self.role === 'impostor' ? 'Your role: Impostor' : 'Your role: Regular player';
  $('map-title').textContent = 'Stay inside the zone.';
  if (!window.L) { showError('The map library could not load. Check your connection and reload.'); return; }
  if (!map) {
    $('map-placeholder').hidden = true; $('map').style.display = 'block'; $('recenter').hidden = false;
    map = L.map('map').setView([data.zone.latitude, data.zone.longitude], 18);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
    zone = L.circle([data.zone.latitude, data.zone.longitude], { radius: data.zone.radius, color: '#658a31', fillColor: '#aad767', fillOpacity: .16, weight: 3 }).addTo(map);
    markers = L.layerGroup().addTo(map);
    map.fitBounds(zone.getBounds().pad(.3));
  }
  markers.clearLayers();
  for (const p of data.positions) {
    if (!p.location) continue;
    const label = document.createElement('span');
    label.textContent = `${p.name}${p.id === data.self.id ? ' (you)' : ''} · ±${Math.round(p.location.accuracy)} m · ${new Date(p.location.recordedAt).toLocaleTimeString()}`;
    L.circleMarker([p.location.latitude, p.location.longitude], { radius: 8, color: '#fff', weight: 2, fillColor: p.id === data.self.id ? '#327cf3' : '#242f28', fillOpacity: 1 }).bindTooltip(label).addTo(markers);
  }
  countdown();
}

async function poll() {
  if (!token || polling) return;
  polling = true;
  try { render(await api('state')); } catch (error) { showError(error.message || 'Connection lost. Retrying…'); }
  finally { polling = false; }
}

async function upload(position) {
  const { latitude, longitude, accuracy } = position.coords;
  await api('location', { latitude, longitude, accuracy });
  lastUpload = Date.now();
  $('gps-status').textContent = `Location sharing active · accuracy ±${Math.round(accuracy)} m. Keep this page open.`;
  $('location').textContent = 'Refresh location';
}

function getLocation() {
  if (!window.isSecureContext) return Promise.reject(new Error('Location requires HTTPS or localhost. Open the game over HTTPS on phones.'));
  if (!navigator.geolocation) return Promise.reject(new Error('This browser does not support geolocation.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
}

async function enableLocation() {
  await upload(await getLocation());
  if (watchId === undefined) watchId = navigator.geolocation.watchPosition(position => {
    if (Date.now() - lastUpload >= 3000) upload(position).catch(error => showError(error.message));
  }, error => { $('gps-status').textContent = `Location unavailable: ${error.message}. Use Refresh location to retry.`; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

$('join-form').addEventListener('submit', async event => {
  event.preventDefault(); showError('');
  const button = event.submitter; button.disabled = true;
  try {
    const joined = await api('join', { name: $('name').value });
    token = joined.token; sessionStorage.setItem('fieldwork-session', token);
    await poll();
    try { await enableLocation(); } catch (error) { showError(error.message); }
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});
$('location').onclick = async () => { showError(''); try { await enableLocation(); } catch (error) { showError(error.message); } };
$('start').onclick = async () => {
  $('start').disabled = true; showError('');
  try { await upload(await getLocation()); render(await api('start', {})); }
  catch (error) { showError(error.message); }
  finally { if (state?.phase === 'lobby') $('start').disabled = state.players.length < 2; }
};
$('leave').onclick = async () => { try { await api('leave', {}); resetSession(); } catch (error) { showError(error.message); } };
$('recenter').onclick = () => map?.fitBounds(zone.getBounds().pad(.3));
function countdown() {
  if (state?.phase !== 'playing') return;
  const seconds = Math.max(0, Math.ceil((state.nextUpdateAt - Date.now() - serverOffset) / 1000));
  const missing = state.positions.filter(p => !p.location).length;
  $('update-status').textContent = `Next position update in ${seconds}s${missing ? ` · ${missing} without recent GPS` : ''}`;
}
setInterval(poll, 1000);
setInterval(countdown, 250);
// Refresh stationary devices too; watchPosition alone may not produce new fixes.
setInterval(() => { if (token && watchId !== undefined) getLocation().then(upload).catch(() => { $('gps-status').textContent = 'Unable to refresh GPS. Tap Refresh location to retry.'; }); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
poll();

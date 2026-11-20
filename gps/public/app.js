const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('fieldwork-session');
let state, map, zone, markers, watchId, polling = false, lastUpload = 0, serverOffset = 0, targetsKey = '', spectating = false;
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
  dropMap();
  $('map').style.display = 'none';
  $('map-placeholder').hidden = false;
  $('recenter').hidden = true;
  $('entry').hidden = false;
  $('session').hidden = true;
  $('update-status').textContent = 'Waiting for the game to begin';
  $('map-title').textContent = 'Your surroundings become the game.';
}

function dropMap() {
  if (map) map.remove();
  map = null; zone = null;
  $('map').style.display = 'none';
  $('map-placeholder').hidden = false;
  $('recenter').hidden = true;
}

// Impostor's kill list, driven by sonar. A row appears for every living player within 2 m;
// after HOLD_S s close it becomes a Kill button. Several close -> the impostor picks one.
// Rows are rebuilt only when the set of living targets changes, so taps aren't lost.
function renderTargets(data) {
  const show = data.phase === 'playing' && data.self.role === 'impostor' && data.self.alive;
  $('targets').hidden = !show;
  if (!show) { targetsKey = ''; return; }
  const targets = data.players.filter(p => p.alive && p.id !== data.self.id);
  const key = targets.map(p => p.id + ':' + p.slot).join();
  if (key === targetsKey) return;
  targetsKey = key;
  $('target-list').replaceChildren(...targets.map(p => {
    const li = document.createElement('li'); li.dataset.slot = p.slot; li.hidden = true;
    const name = document.createElement('span'); name.textContent = p.name;
    const btn = document.createElement('button'); btn.className = 'kill';
    btn.onclick = () => kill(p.id, p.name, btn);
    li.append(name, btn); return li;
  }));
}

// Runs 5× a second: updates which targets are close and how charged they are.
function targetsTick() {
  if (!state || $('targets').hidden) return;
  const now = Date.now() + serverOffset;
  const cool = state.killCooldownUntil ? Math.ceil((state.killCooldownUntil - now) / 1000) : 0;
  let close = 0;
  for (const li of $('target-list').children) {
    const n = Sonar.near(+li.dataset.slot), btn = li.querySelector('.kill');
    li.hidden = !n.near;
    if (!n.near) continue;
    close++;
    const charged = n.held >= Sonar.HOLD_S;
    if (!btn.dataset.busy) btn.disabled = !charged || cool > 0;
    btn.textContent = cool > 0 ? `Recharging ${cool} s` : charged ? 'Kill' : `Stay close ${(Sonar.HOLD_S - n.held).toFixed(1)} s`;
    li.classList.toggle('blip', n.blip);
  }
  $('kill-hint').textContent = !Sonar.ready ? 'Enable sound & mic to sense targets.'
    : cool > 0 ? `Kill recharging… ${cool} s` + (close ? '' : ' · nobody within 2 m')
    : close ? (close > 1 ? `${close} players within 2 m – pick one.` : 'Stay within 2 m to charge the kill.')
    : 'Nobody within 2 m. Get close to someone.';
}

async function kill(id, name, btn) {
  btn.dataset.busy = '1'; btn.disabled = true; showError('');
  try { render(await api('kill', { targetId: id })); if (navigator.vibrate) navigator.vibrate(120); }
  catch (error) { showError(error.message); }
  finally { delete btn.dataset.busy; }
}

function render(data) {
  state = data;
  serverOffset = data.serverTime - Date.now();
  const now = Date.now() + serverOffset;
  $('entry').hidden = true; $('session').hidden = false;
  const playing = data.phase === 'playing', ended = data.phase === 'ended', lobby = data.phase === 'lobby';
  const host = data.self.id === data.hostId;
  $('phase').textContent = playing ? 'In the field' : ended ? 'Round over' : 'Game lobby';
  const alive = data.players.filter(p => p.alive).length;
  $('count').textContent = lobby ? `${data.players.length} players` : `${alive}/${data.players.length} alive`;
  $('players').replaceChildren(...data.players.map(p => {
    const li = document.createElement('li');
    if (!lobby && !p.alive) li.className = 'out';
    const name = document.createElement('span'); name.textContent = p.name;
    const badge = document.createElement('span'); badge.textContent = [p.id === data.self.id && 'You', p.id === data.hostId && 'Host', lobby && (p.sound ? '🔊' : '🔇 no sound'), !lobby && !p.alive && 'signal lost'].filter(Boolean).join(' · ');
    li.append(name, badge); return li;
  }));
  $('start').hidden = !lobby || !host;
  $('start').disabled = data.players.length < 2;
  $('reset').hidden = !ended || !host;
  $('leave').hidden = !lobby;
  $('waiting').textContent = playing ? `Position updates every ${data.updateInterval} seconds. Other players’ roles are hidden.` : ended ? (host ? 'Start a new round when everyone is ready.' : 'Waiting for the host to start a new round.') : host ? 'Start with at least 2 players. Your location at start sets the zone.' : 'Waiting for the host to start the game.';
  $('role').hidden = !playing;
  $('timer').hidden = !playing;
  $('dead').hidden = !(playing && !data.self.alive) || spectating;
  if (data.self.alive) spectating = false;
  const r = data.result;
  $('result').hidden = !ended || !r;
  if (ended && r) {
    $('result').className = `result ${r.winner}`;
    $('result').innerHTML = '';
    const head = document.createElement('b'); head.textContent = r.winner === 'impostor' ? 'Impostor wins' : 'Crew wins';
    const lines = [r.reason, `The impostor was ${r.impostorName}.`, r.killedByName ? `${r.killedByName} took you out.` : ''].filter(Boolean);
    $('result').append(head, ...lines.map(t => { const d = document.createElement('div'); d.textContent = t; return d; }));
  }
  Sonar.configure(data.sonar, data.self.slot);
  Sonar.setEmitting(playing && data.self.alive);       // everyone alive broadcasts; the dead go silent
  if (Sonar.ready) $('sound-status').textContent = `Sound on · your frequency ${(Sonar.freq(data.self.slot) / 1000).toFixed(1)} kHz` + (Sonar.running ? '' : ' · ⚠ audio paused, tap the screen');
  $('sound').hidden = Sonar.ready;
  if (!lobby && !Sonar.ready && data.self.alive) $('sound-status').textContent = '⚠ Sound is off – tap “Enable sound & mic” or other phones can’t sense you.';
  renderTargets(data, now);
  if (lobby) { if (map) dropMap(); $('update-status').textContent = 'Waiting for the game to begin'; $('map-title').textContent = 'Your surroundings become the game.'; return; }
  if (ended) { $('update-status').textContent = 'Round over'; return; }
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
$('sound').onclick = async () => {
  showError('');
  try {
    if (state) Sonar.configure(state.sonar, state.self.slot);
    await Sonar.start();
    await api('sound', { ready: true });
    if (state) render(state);
    poll();
  } catch (error) { showError(error.message); }
};
setInterval(targetsTick, 200);
$('reset').onclick = async () => { $('reset').disabled = true; showError(''); try { render(await api('reset', {})); } catch (error) { showError(error.message); } finally { $('reset').disabled = false; } };
$('spectate').onclick = () => { spectating = true; $('dead').hidden = true; };
$('recenter').onclick = () => map?.fitBounds(zone.getBounds().pad(.3));
function countdown() {
  if (state?.phase !== 'playing') return;
  const seconds = Math.max(0, Math.ceil((state.nextUpdateAt - Date.now() - serverOffset) / 1000));
  const left = Math.max(0, Math.ceil((state.endsAt - Date.now() - serverOffset) / 1000));
  $('timer').textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
  const missing = state.positions.filter(p => !p.location).length;
  $('update-status').textContent = `Next position update in ${seconds}s${missing ? ` · ${missing} without recent GPS` : ''}`;
}
setInterval(poll, 1000);
setInterval(countdown, 250);
// Refresh stationary devices too; watchPosition alone may not produce new fixes.
setInterval(() => { if (token && watchId !== undefined) getLocation().then(upload).catch(() => { $('gps-status').textContent = 'Unable to refresh GPS. Tap Refresh location to retry.'; }); }, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
poll();

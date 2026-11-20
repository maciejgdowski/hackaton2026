const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('fieldwork-session');
let state = null, watchId, polling = false, lastUpload = 0, serverOffset = 0;
let lastFix = null, targetsKey = '', spectating = false, errorTimer = null;

function showError(message) {
  clearTimeout(errorTimer);
  $('error').textContent = message || ''; $('error').hidden = !message;
  if (message) errorTimer = setTimeout(() => { $('error').hidden = true; }, 5000);
}

async function api(path, body) {
  const response = await fetch(`./api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(Sonar.debug ? { 'X-Debug': '1' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
  World.space();
  show('join');
}

function show(screen) {
  for (const id of ['join', 'lobby', 'game', 'end']) $(id).hidden = id !== screen;
  document.body.dataset.screen = screen;                 // drives the veil over the world map
  World.setMode(screen === 'game' ? 'game' : screen === 'lobby' ? 'lobby' : 'menu');
}

const fmtTime = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const serverNow = () => Date.now() + serverOffset;

// ---------- lobby ----------
function renderLobby(data) {
  const host = data.self.id === data.hostId;
  $('lobby-code').textContent = data.lobby.code;
  $('count').textContent = `${data.players.length} / ${data.lobby.maxPlayers} · ${data.lobby.radius} m`;
  $('players').replaceChildren(...data.players.map(p => {
    const li = document.createElement('li');
    if (!p.sound) li.className = 'off';
    const name = document.createElement('span'); name.textContent = p.name;
    const tags = document.createElement('span'); tags.className = 'tags';
    tags.textContent = [p.id === data.self.id && 'you', p.id === data.hostId && 'host', p.sound ? 'ready' : 'no sound'].filter(Boolean).join(' · ');
    li.append(name, tags); return li;
  }));
  const soundOk = Sonar.ready, gpsOk = lastFix && Date.now() - lastUpload < 30000;
  $('sound-status').textContent = soundOk ? `on · ${(Sonar.freq(data.self.slot) / 1000).toFixed(1)} kHz` : 'off';
  $('sound-status').className = soundOk ? 'ok' : 'bad';
  $('gps-status').textContent = gpsOk ? `on · ±${Math.round(lastFix.accuracy)} m` : 'off';
  $('gps-status').className = gpsOk ? 'ok' : 'bad';
  $('ready').hidden = soundOk && gpsOk;
  $('start').hidden = !host;
  $('start').disabled = data.players.length < 2;
  $('waiting').textContent = host ? `Your position at start becomes the centre of the ${data.lobby.radius} m zone.` : 'Waiting for the host to start.';
}

// ---------- game: map (World = the MapLibre globe behind every screen) ----------
function renderMap(data) {
  const alive = new Set(data.players.filter(p => p.alive).map(p => p.id));
  const dots = data.positions.filter(p => p.location && p.id !== data.self.id && alive.has(p.id))
    .map(p => ({ lat: p.location.latitude, lon: p.location.longitude }));
  if (lastFix && data.self.alive) dots.push({ lat: lastFix.latitude, lon: lastFix.longitude, self: true });   // you: live fix
  World.show(data.zone, dots);
}

// ---------- impostor kill bar (sonar) ----------
// One button per living player; shown only while that player is within 2 m. Buttons are rebuilt
// only when the set of targets changes, so a tap is never lost to a re-render.
function buildKillbar(data) {
  const targets = data.players.filter(p => p.alive && p.id !== data.self.id);
  const key = targets.map(p => p.id + ':' + p.slot).join();
  if (key === targetsKey) return;
  targetsKey = key;
  const idle = document.createElement('button'); idle.id = 'kill-idle'; idle.className = 'idle'; idle.disabled = true;
  $('killbar').replaceChildren(idle, ...targets.map(p => {
    const b = document.createElement('button');
    b.dataset.slot = p.slot; b.hidden = true;
    b.append(document.createElement('i'), document.createElement('span'));
    b.onclick = () => kill(p.id, b);
    b.dataset.name = p.name;
    return b;
  }));
}

function killTick() {
  if (!state || $('killbar').hidden) return;
  const cool = state.killCooldownUntil ? Math.ceil((state.killCooldownUntil - serverNow()) / 1000) : 0;
  let close = 0;
  for (const b of $('killbar').querySelectorAll('button[data-slot]')) {
    const n = Sonar.near(+b.dataset.slot);
    b.hidden = !n.near || cool > 0;
    if (b.hidden) continue;
    close++;
    const charged = n.held >= Sonar.HOLD_S;
    b.className = charged ? '' : 'charging';
    b.querySelector('i').style.width = `${Math.min(100, n.held / Sonar.HOLD_S * 100)}%`;
    b.querySelector('span').textContent = charged ? `Kill ${b.dataset.name}` : `${b.dataset.name} · hold`;
    if (!b.dataset.busy) b.disabled = !charged;
  }
  const idle = $('kill-idle');
  idle.hidden = close > 0;
  idle.textContent = cool > 0 ? `Recharging ${cool}` : state.sonarOn ? 'No target in range' : 'Nobody within 15 m';
}

async function kill(id, btn) {
  btn.dataset.busy = '1'; btn.disabled = true;
  try { render(await api('kill', { targetId: id })); if (navigator.vibrate) navigator.vibrate(120); }
  catch (error) { showError(error.message); }
  finally { delete btn.dataset.busy; }
}

// ---------- end of round ----------
function renderEnd(data) {
  const r = data.result, host = data.self.id === data.hostId;
  $('winner').textContent = r.winner === 'impostor' ? 'Impostor wins' : 'Crew wins';
  $('reason').textContent = r.reason + (r.killedByName ? ` ${r.killedByName} took you out.` : '');
  $('reveal').replaceChildren(...data.players.map(p => {
    const li = document.createElement('li');
    li.className = [p.id === r.impostorId && 'imp', !p.alive && 'out'].filter(Boolean).join(' ');
    const name = document.createElement('span'); name.textContent = p.name;
    const tags = document.createElement('span'); tags.className = 'tags';
    tags.textContent = [p.id === r.impostorId ? 'impostor' : 'crew', !p.alive && 'lost', p.id === data.self.id && 'you'].filter(Boolean).join(' · ');
    li.append(name, tags); return li;
  }));
  $('reset').hidden = !host;
  $('end-wait').textContent = host ? '' : 'Waiting for the host to start a new round.';
}

// ---------- main render ----------
function render(data) {
  state = data;
  serverOffset = data.serverTime - Date.now();
  const playing = data.phase === 'playing';
  Sonar.configure(data.sonar, data.self.slot);
  // GPS gate: tones + listening only while the server says someone is within ~15 m.
  Sonar.setEmitting(playing && data.self.alive && data.sonarOn);
  Sonar.setListening(playing && data.self.alive && data.sonarOn);
  if (data.self.alive) spectating = false;
  $('dead').hidden = !(playing && !data.self.alive) || spectating;
  $('reconnect').hidden = !(playing && data.self.alive && !Sonar.ready);

  if (data.phase === 'lobby') { targetsKey = ''; show('lobby'); renderLobby(data); if (lastFix) World.home(lastFix.latitude, lastFix.longitude); return; }
  if (data.phase === 'ended') { show('end'); renderEnd(data); return; }

  show('game');
  const impostor = data.self.role === 'impostor';
  $('role').textContent = !data.self.alive ? 'Signal lost' : impostor ? 'Impostor' : 'Crew';
  $('killbar').hidden = !(impostor && data.self.alive);
  if (impostor && data.self.alive) buildKillbar(data);
  renderMap(data);
  tickHud();
}

function tickHud() {
  if (state?.phase !== 'playing') return;
  const left = Math.max(0, Math.ceil((state.endsAt - serverNow()) / 1000));
  let t = fmtTime(left);
  const crew = state.self.role !== 'impostor' && state.self.alive;
  $('refresh').hidden = !crew;
  if (crew) $('refresh').textContent = `Map ${Math.max(0, Math.ceil((state.nextUpdateAt - serverNow()) / 1000))}s`;
  $('debug').hidden = !Sonar.debug;
  if (Sonar.debug) {
    const g = state.gate || {}, f = x => x ? `±${x.acc} m, ${x.age}s old` : 'none';
    const local = lastFix ? `±${Math.round(lastFix.accuracy)} m, sent ${Math.round((Date.now() - lastUpload) / 1000)}s ago` : 'none';
    const db = state.players.filter(p => p.id !== state.self.id && p.alive)
      .map(p => { const n = Sonar.near(p.slot); return `${p.name.slice(0, 6)} ${Number.isFinite(n.db) ? n.db.toFixed(0) : '–'}${n.near ? `*${n.held.toFixed(1)}s` : ''}`; }).join('  ');
    $('debug').textContent = `SONAR ${state.sonarOn ? 'ON' : 'off'} (${g.why || '?'}) · kill ≥${Sonar.KILL_DB} dB\n`
      + `nearest on GPS: ${g.nearest ? `${g.nearest.m} m (them ${f(g.nearest)})` : '–'}\n`
      + `me on server: ${f(g.me)} · phone: ${local}\n`
      + `dB: ${db || '–'}`;
  }
  $('timer').textContent = t;
}

async function poll() {
  if (!token || polling) return;
  polling = true;
  try { render(await api('state')); } catch (error) { showError(error.message || 'Connection lost. Retrying…'); }
  finally { polling = false; }
}

// ---------- location ----------
async function upload(position) {
  const { latitude, longitude, accuracy } = position.coords;
  lastFix = { latitude, longitude, accuracy };
  if (state?.phase !== 'playing') { World.home(latitude, longitude); World.me(latitude, longitude); }
  await api('location', { latitude, longitude, accuracy });
  lastUpload = Date.now();
}

function getLocation() {
  if (!window.isSecureContext) return Promise.reject(new Error('Location needs HTTPS.'));
  if (!navigator.geolocation) return Promise.reject(new Error('This browser has no location support.'));
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }));
}

async function enableLocation() {
  await upload(await getLocation());
  if (watchId === undefined) watchId = navigator.geolocation.watchPosition(position => {
    if (Date.now() - lastUpload >= 3000) upload(position).catch(error => showError(error.message));
  }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
}

// Sound (needs this tap on iOS) + location in one go.
async function getReady() {
  showError('');
  try {
    if (state) Sonar.configure(state.sonar, state.self.slot);
    await Sonar.start();
    await api('sound', { ready: true });
  } catch (error) { showError(error.message); }
  try { await enableLocation(); } catch (error) { showError(`Location: ${error.message}`); }
  if (state) render(state);
  poll();
}

// ---------- wiring ----------
// Join screen: name, then either "Create lobby" (pick zone radius + players) or "Join" (enter code).
const form = $('join-form');
function joinMode(mode) {
  form.dataset.mode = mode; showError('');
  $('choose').hidden = !!mode; $('create-opts').hidden = mode !== 'create'; $('join-opts').hidden = mode !== 'join';
  if (mode === 'join') $('code').focus();
}
for (const group of [$('opt-radius'), $('opt-max')])
  group.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; for (const x of group.children) x.setAttribute('aria-pressed', x === b); });
const picked = group => +group.querySelector('[aria-pressed="true"]').dataset.v;
$('go-create').onclick = () => { if (form.reportValidity()) joinMode('create'); };
$('go-join').onclick = () => { if (form.reportValidity()) joinMode('join'); };
for (const b of form.querySelectorAll('.back')) b.onclick = () => joinMode('');
$('code').addEventListener('input', () => { $('code').value = $('code').value.toUpperCase().replace(/[^A-Z]/g, ''); });
$('name').value = localStorage.getItem('oos-name') || '';
const linkCode = new URLSearchParams(location.search).get('code');
if (linkCode) { $('code').value = linkCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4); joinMode('join'); }

form.addEventListener('submit', async event => {
  event.preventDefault(); showError('');
  const mode = form.dataset.mode;
  if (!mode) return;                                     // Enter on the name: wait for Create / Join
  const name = $('name').value;
  if (mode === 'join' && $('code').value.length !== 4) return showError('Enter the 4-letter lobby code.');
  const button = mode === 'create' ? $('do-create') : $('do-join'); button.disabled = true;
  // Start the fly-in as early as possible: ask for the position while joining.
  const fix = getLocation().then(p => { lastFix = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }; World.home(lastFix.latitude, lastFix.longitude); }).catch(() => {});
  try {
    const joined = mode === 'create'
      ? await api('create', { name, radius: picked($('opt-radius')), maxPlayers: picked($('opt-max')) })
      : await api('join', { name, code: $('code').value });
    token = joined.token; sessionStorage.setItem('fieldwork-session', token);
    localStorage.setItem('oos-name', name.trim());
    if (linkCode) history.replaceState(null, '', location.pathname);
    joinMode('');
    await poll();
    fix.then(() => enableLocation()).catch(() => {});
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});
$('lobby-code').onclick = async () => {
  const code = state?.lobby?.code; if (!code) return;
  const url = `${location.origin}${location.pathname}?code=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Out of Signal', text: `Join my Out of Signal lobby: ${code}`, url });
    else { await navigator.clipboard.writeText(url); showError(`Link copied · code ${code}`); }
  } catch {}
};
$('ready').onclick = getReady;
$('reconnect').onclick = getReady;
$('start').onclick = async () => {
  $('start').disabled = true; showError('');
  try { await upload(await getLocation()); render(await api('start', {})); }
  catch (error) { showError(error.message); }
  finally { if (state?.phase === 'lobby') $('start').disabled = state.players.length < 2; }
};
$('leave').onclick = async () => { try { await api('leave', {}); resetSession(); } catch (error) { showError(error.message); } };
$('reset').onclick = async () => { $('reset').disabled = true; try { render(await api('reset', {})); } catch (error) { showError(error.message); } finally { $('reset').disabled = false; } };
async function quitGame() {
  if (!confirm('Quit the game? You can’t rejoin this round.')) return;
  try { await api('quit', {}); } catch (error) { showError(error.message); return; }
  Sonar.setEmitting(false); $('dead').hidden = true; spectating = false;
  resetSession();
}
$('quit').onclick = quitGame;
$('quit-dead').onclick = quitGame;
$('spectate').onclick = () => { spectating = true; $('dead').hidden = true; };
$('recenter').onclick = () => World.fitZone();

setInterval(poll, 1000);
setInterval(killTick, 200);
setInterval(tickHud, 500);
// Refresh stationary devices too; watchPosition alone may not produce new fixes.
setInterval(() => { if (token && watchId !== undefined) getLocation().then(upload).catch(() => {}); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
World.init('world');
if (token) poll(); else show('join');

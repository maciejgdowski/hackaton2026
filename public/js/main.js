// Out of Signal: entry point. Polls the server every second and shows the matching screen.
import { api, session } from './api.js';
import { $, showError } from './dom.js';
import { gps, startTracking, stopTracking } from './location.js';
import { initEnd, renderEnd } from './screens/end.js';
import { initGame, leaveGameScreen, renderGame } from './screens/game.js';
import { initJoin } from './screens/join.js';
import { initLobby, renderLobby } from './screens/lobby.js';
import { Sonar } from './sonar.js';
import { store } from './store.js';
import { World } from './world.js';

const POLL_MS = 1000;
let polling = false;
let spectating = false;

function show(screen) { // 'join' | 'lobby' | 'game' | 'end'
  for (const id of ['join', 'lobby', 'game', 'end']) $(id).hidden = id !== screen;
  document.body.dataset.screen = screen; // drives the tint over the map
  World.setMode(screen === 'game' ? 'game' : screen === 'lobby' ? 'lobby' : 'menu');
}

function backToMenu() {
  store.state = null;
  stopTracking();
  World.space();
  show('join');
}

function render(data) {
  store.state = data;
  store.serverOffset = data.serverTime - Date.now();

  // Sonar: play and listen only in a round, while alive, and while GPS says someone is close.
  const playing = data.phase === 'playing';
  const sonarActive = playing && data.self.alive && data.sonarOn;
  Sonar.configure(data.sonar, data.self.slot);
  Sonar.setEmitting(sonarActive);
  Sonar.setListening(sonarActive);

  // Overlays
  if (data.self.alive) spectating = false;
  $('dead').hidden = !(playing && !data.self.alive) || spectating;
  $('reconnect').hidden = !(playing && data.self.alive && !Sonar.ready);

  if (data.phase === 'lobby') {
    leaveGameScreen();
    show('lobby');
    renderLobby(data);
    if (gps.fix) World.home(gps.fix.latitude, gps.fix.longitude);
  } else if (data.phase === 'ended') {
    show('end');
    renderEnd(data);
  } else {
    show('game');
    renderGame(data);
  }
}

async function poll() {
  if (!session.active || polling) return;
  polling = true;
  try {
    render(await api('state'));
  } catch (error) {
    showError(error.message || 'Connection lost. Retrying…');
  } finally {
    polling = false;
  }
}

// Sound + location in one tap (iOS only allows audio after a tap).
async function getReady() {
  showError('');
  try {
    if (store.state) Sonar.configure(store.state.sonar, store.state.self.slot);
    await Sonar.start();
    await api('sound', { ready: true });
  } catch (error) {
    showError(error.message);
  }
  try {
    await startTracking();
  } catch (error) {
    showError(`Location: ${error.message}`);
  }
  if (store.state) render(store.state);
  poll();
}

async function leave() {
  try {
    await api('leave', {});
    session.end();
    backToMenu();
  } catch (error) {
    showError(error.message);
  }
}

async function quit() {
  if (!confirm('Quit the game? You can’t rejoin this round.')) return;
  try {
    await api('quit', {});
  } catch (error) {
    showError(error.message);
    return;
  }
  Sonar.setEmitting(false);
  $('dead').hidden = true;
  spectating = false;
  session.end();
  backToMenu();
}

// ---------- boot ----------

session.onLost(backToMenu);
initJoin({ onJoined: poll });
initLobby({ render, getReady, leave });
initGame({ render, quit });
initEnd({ render });
$('reconnect').onclick = getReady;
$('spectate').onclick = () => { spectating = true; $('dead').hidden = true; };

setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

World.init('world');
if (session.active) poll();
else show('join');

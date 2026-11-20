// Lobby: code (tap to share), players, sound + location status, start / leave.
import { api } from '../api.js';
import { $, listRow, showError } from '../dom.js';
import { getLocation, gps, hasRecentUpload, upload } from '../location.js';
import { Sonar } from '../sonar.js';
import { store } from '../store.js';

export function renderLobby(data) {
  const isHost = data.self.id === data.hostId;

  $('lobby-code').textContent = data.lobby.code;
  $('count').textContent = `${data.players.length} / ${data.lobby.maxPlayers} · ${data.lobby.radius} m`;
  $('players').replaceChildren(...data.players.map(p => listRow(p.name, [
    p.id === data.self.id && 'you',
    p.id === data.hostId && 'host',
    p.sound ? 'ready' : 'no sound'
  ], p.sound ? '' : 'off')));

  const soundOk = Sonar.ready;
  const gpsOk = hasRecentUpload();
  $('sound-status').textContent = soundOk ? `on · ${(Sonar.frequencyOf(data.self.slot) / 1000).toFixed(1)} kHz` : 'off';
  $('sound-status').className = soundOk ? 'ok' : 'bad';
  $('gps-status').textContent = gpsOk ? `on · ±${Math.round(gps.fix.accuracy)} m` : 'off';
  $('gps-status').className = gpsOk ? 'ok' : 'bad';

  $('ready').hidden = soundOk && gpsOk;
  $('start').hidden = !isHost;
  $('start').disabled = data.players.length < 2;
  $('waiting').textContent = isHost
    ? `Your position at start becomes the centre of the ${data.lobby.radius} m zone.`
    : 'Waiting for the host to start.';
}

async function shareCode() {
  const code = store.state?.lobby?.code;
  if (!code) return;
  const url = `${location.origin}${location.pathname}?code=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Out of Signal', text: `Join my Out of Signal lobby: ${code}`, url });
    else {
      await navigator.clipboard.writeText(url);
      showError(`Link copied · code ${code}`);
    }
  } catch { /* share sheet dismissed */ }
}

export function initLobby({ render, getReady, leave }) {
  $('ready').onclick = getReady;
  $('lobby-code').onclick = shareCode;
  $('leave').onclick = leave;
  $('start').onclick = async () => {
    $('start').disabled = true;
    showError('');
    try {
      await upload(await getLocation()); // the zone is centred on a fresh fix
      render(await api('start', {}));
    } catch (error) {
      showError(error.message);
    } finally {
      if (store.state?.phase === 'lobby') $('start').disabled = store.state.players.length < 2;
    }
  };
}

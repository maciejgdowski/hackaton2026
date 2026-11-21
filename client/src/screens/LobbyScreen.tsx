// Lobby: code (tap to share), players, sound + location status, start / leave.
import type { GameView } from '@oos/shared';
import { useState } from 'react';
import { PlayerRow } from '../components/PlayerRow.tsx';
import { hasRecentUpload, useLocation } from '../lib/location.ts';
import { Sonar } from '../lib/sonar.ts';
import { showError } from '../lib/toast.ts';

interface Props {
  view: GameView;
  onReady: () => void;
  onStart: () => Promise<void>;
  onLeave: () => void;
}

async function shareCode(code: string) {
  const url = `${location.origin}${location.pathname}?code=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Out of Signal', text: `Join my Out of Signal lobby: ${code}`, url });
    else {
      await navigator.clipboard.writeText(url);
      showError(`Link copied · code ${code}`);
    }
  } catch { /* share sheet dismissed */ }
}

export function LobbyScreen({ view, onReady, onStart, onLeave }: Props) {
  const { fix } = useLocation();
  const [starting, setStarting] = useState(false);
  const { lobby, players, self } = view;
  const isHost = self.id === view.hostId;
  const soundOk = Sonar.ready;
  const gpsOk = hasRecentUpload();

  async function start() {
    setStarting(true);
    await onStart();
    setStarting(false);
  }

  return (
    <section id="lobby" className="screen">
      <div className="bar">
        <button id="lobby-code" className="code-button" title="Share lobby code" onClick={() => lobby.code && shareCode(lobby.code)}>
          {lobby.code}
        </button>
        <span id="count" className="label">{players.length} / {lobby.maxPlayers} · {lobby.radius} m</span>
      </div>

      <ul id="players" className="list">
        {players.map(p => (
          <PlayerRow key={p.id} name={p.name} className={p.sound ? '' : 'off'}
            tags={[p.id === self.id && 'you', p.id === view.hostId && 'host', p.sound ? 'ready' : 'no sound']} />
        ))}
      </ul>

      <div className="stack">
        <div className="checks">
          <div>
            <span className="label">Sound</span>
            <span id="sound-status" className={soundOk ? 'ok' : 'bad'}>
              {soundOk ? `on · ${(Sonar.frequencyOf(self.slot) / 1000).toFixed(1)} kHz` : 'off'}
            </span>
          </div>
          <div>
            <span className="label">Location</span>
            <span id="gps-status" className={gpsOk ? 'ok' : 'bad'}>
              {gpsOk && fix ? `on · ±${Math.round(fix.accuracy)} m` : 'off'}
            </span>
          </div>
        </div>

        {!(soundOk && gpsOk) && <button id="ready" onClick={onReady}>Enable sound + location</button>}
        {isHost && <button id="start" disabled={starting || players.length < 2} onClick={start}>Start</button>}
        <p id="waiting" className="fine">
          {isHost ? `Your position at start becomes the centre of the ${lobby.radius} m zone.` : 'Waiting for the host to start.'}
        </p>
        <button id="leave" className="ghost" onClick={onLeave}>Leave</button>
      </div>
    </section>
  );
}

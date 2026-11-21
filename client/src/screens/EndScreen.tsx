// End of round: winner, reason, everyone's role revealed; the host starts the next round.
import type { GameView } from '@oos/shared';
import { useState } from 'react';
import { PlayerRow } from '../components/PlayerRow.tsx';

export function EndScreen({ view, onReset }: { view: GameView; onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const result = view.result!;
  const isHost = view.self.id === view.hostId;

  async function reset() {
    setBusy(true);
    await onReset();
    setBusy(false);
  }

  return (
    <section id="end" className="screen">
      <div id="winner" className="mark">{result.winner === 'impostor' ? 'Impostor wins' : 'Crew wins'}</div>
      <p id="reason" className="fine">
        {result.reason}{result.killedByName ? ` ${result.killedByName} took you out.` : ''}
      </p>
      <ul id="reveal" className="list">
        {view.players.map(p => {
          const isImpostor = p.id === result.impostorId;
          return (
            <PlayerRow key={p.id} name={p.name}
              className={[isImpostor && 'imp', !p.alive && 'out'].filter(Boolean).join(' ')}
              tags={[isImpostor ? 'impostor' : 'crew', !p.alive && 'lost', p.id === view.self.id && 'you']} />
          );
        })}
      </ul>
      <div className="stack">
        {isHost
          ? <button id="reset" disabled={busy} onClick={reset}>New round</button>
          : <p id="end-wait" className="fine">Waiting for the host to start a new round.</p>}
      </div>
    </section>
  );
}

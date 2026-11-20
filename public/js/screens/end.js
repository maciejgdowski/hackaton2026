// End of round: winner, reason, everyone's role revealed; the host starts the next round.
import { api } from '../api.js';
import { $, listRow, showError } from '../dom.js';

export function renderEnd(data) {
  const result = data.result;
  const isHost = data.self.id === data.hostId;

  $('winner').textContent = result.winner === 'impostor' ? 'Impostor wins' : 'Crew wins';
  $('reason').textContent = result.reason + (result.killedByName ? ` ${result.killedByName} took you out.` : '');
  $('reveal').replaceChildren(...data.players.map(p => {
    const isImpostor = p.id === result.impostorId;
    const classes = [isImpostor && 'imp', !p.alive && 'out'].filter(Boolean).join(' ');
    return listRow(p.name, [isImpostor ? 'impostor' : 'crew', !p.alive && 'lost', p.id === data.self.id && 'you'], classes);
  }));
  $('reset').hidden = !isHost;
  $('end-wait').textContent = isHost ? '' : 'Waiting for the host to start a new round.';
}

export function initEnd({ render }) {
  $('reset').onclick = async () => {
    $('reset').disabled = true;
    try {
      render(await api('reset', {}));
    } catch (error) {
      showError(error.message);
    } finally {
      $('reset').disabled = false;
    }
  };
}

// Picks the screen from the game phase; the map, overlays and toast sit around it.
import { useEffect, useState } from 'react';
import { ErrorToast } from './components/ErrorToast.tsx';
import { DeadOverlay, ReconnectOverlay } from './components/Overlays.tsx';
import { WorldMap } from './components/WorldMap.tsx';
import { useGame } from './hooks/useGame.ts';
import { useLocation } from './lib/location.ts';
import { Sonar } from './lib/sonar.ts';
import { EndScreen } from './screens/EndScreen.tsx';
import { GameScreen } from './screens/GameScreen.tsx';
import { JoinScreen } from './screens/JoinScreen.tsx';
import { LobbyScreen } from './screens/LobbyScreen.tsx';

type Screen = 'join' | 'lobby' | 'game' | 'end';

export function App() {
  const game = useGame();
  const { view, inSession } = game;
  const { fix } = useLocation();
  const [spectating, setSpectating] = useState(false);

  const screen: Screen = !inSession || !view ? 'join'
    : view.phase === 'lobby' ? 'lobby'
    : view.phase === 'ended' ? 'end'
    : 'game';
  const playing = view?.phase === 'playing';
  const alive = view?.self.alive ?? true;

  useEffect(() => { document.body.dataset.screen = screen; }, [screen]); // drives the tint over the map
  useEffect(() => { if (alive) setSpectating(false); }, [alive]);

  return (
    <>
      <WorldMap mode={screen === 'game' ? 'game' : screen === 'lobby' ? 'lobby' : 'menu'} fix={fix} inSession={inSession} />

      {screen === 'join' && <JoinScreen onJoined={game.joined} />}
      {screen === 'lobby' && view && <LobbyScreen view={view} onReady={game.getReady} onStart={game.start} onLeave={game.leave} />}
      {screen === 'game' && view && <GameScreen view={view} onKill={game.kill} onQuit={game.quit} />}
      {screen === 'end' && view && <EndScreen view={view} onReset={game.reset} />}

      {playing && !alive && !spectating && <DeadOverlay onWatch={() => setSpectating(true)} onQuit={game.quit} />}
      {playing && alive && !Sonar.ready && <ReconnectOverlay onTap={game.getReady} />}
      <ErrorToast />
    </>
  );
}

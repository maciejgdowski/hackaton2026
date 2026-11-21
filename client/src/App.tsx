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
import { SonarLabPage } from './sonar-lab/SonarLab.tsx';

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
      <SonarLabPage/>
    </>
  );
}

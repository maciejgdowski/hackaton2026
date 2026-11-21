// The MapLibre map behind every screen (see lib/world.ts for what each mode looks like).
import type { LocationFix } from '@oos/shared';
import { useEffect, useRef } from 'react';
import { World, type WorldMode } from '../lib/world.ts';

interface Props {
  mode: WorldMode;
  fix: LocationFix | null;
  inSession: boolean;
}

export function WorldMap({ mode, fix, inSession }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const wasInSession = useRef(inSession);

  useEffect(() => {
    if (container.current) World.init(container.current);
  }, []);

  useEffect(() => {
    World.setMode(mode);
  }, [mode]);

  // Outside a round the map follows you (fly down once, then move your dot).
  useEffect(() => {
    if (!fix || mode === 'game') return;
    World.home(fix.latitude, fix.longitude);
    World.me(fix.latitude, fix.longitude);
  }, [fix, mode]);

  // Left the game: back out to the spinning globe.
  useEffect(() => {
    if (wasInSession.current && !inSession) World.space();
    wasInSession.current = inSession;
  }, [inSession]);

  return (
    <>
      <div id="world" ref={container} />
      <div id="veil" />
    </>
  );
}

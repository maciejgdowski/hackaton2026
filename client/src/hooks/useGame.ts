// The game session: polls /api/state every second, keeps the sonar in sync, and exposes the actions.
import type { GameView } from '@oos/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, session } from '../lib/api.ts';
import { getLocation, startTracking, stopTracking, upload } from '../lib/location.ts';
import { Sonar } from '../lib/sonar.ts';
import { syncServerClock } from '../lib/time.ts';
import { showCaught, showError } from '../lib/toast.ts';

const POLL_MS = 1000;

export interface GameSession {
  view: GameView | null;
  inSession: boolean;
  joined(token: string): void;
  getReady(): Promise<void>;
  start(): Promise<void>;
  kill(targetId: string): Promise<void>;
  reset(): Promise<void>;
  leave(): Promise<void>;
  quit(): Promise<void>;
}

export function useGame(): GameSession {
  const [view, setView] = useState<GameView | null>(null);
  const [inSession, setInSession] = useState(session.active);
  const viewRef = useRef<GameView | null>(null);
  const polling = useRef(false);

  const apply = useCallback((data: GameView) => {
    syncServerClock(data.serverTime);
    // Sonar: play and listen only in a round, while alive, and while GPS says someone is close.
    const sonarActive = data.phase === 'playing' && data.self.alive && data.sonarOn;
    Sonar.configure(data.sonar, data.self.slot);
    Sonar.setEmitting(sonarActive);
    Sonar.setListening(sonarActive);
    viewRef.current = data;
    setView(data);
  }, []);

  const poll = useCallback(async () => {
    if (!session.active || polling.current) return;
    polling.current = true;
    try {
      const data = await api<GameView>('state');
      if (session.active) apply(data); // ignore a reply that arrives after leaving
    } catch (error) {
      if (session.active) showCaught(error, 'Connection lost. Retrying…');
    } finally {
      polling.current = false;
    }
  }, [apply]);

  // Back to the menu: forget the session, stop GPS and sound.
  const close = useCallback(() => {
    session.end();
    stopTracking();
    Sonar.setEmitting(false);
    Sonar.setListening(false);
    viewRef.current = null;
    setView(null);
    setInSession(false);
  }, []);

  useEffect(() => session.onLost(close), [close]);

  useEffect(() => {
    if (!inSession) return;
    poll();
    const id = setInterval(poll, POLL_MS);
    const onVisible = () => { if (!document.hidden) poll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [inSession, poll]);

  return {
    view,
    inSession,

    joined(token) {
      session.start(token);
      setInSession(true);
    },

    // Sound + location in one tap (iOS only allows audio after a tap).
    async getReady() {
      showError('');
      try {
        const current = viewRef.current;
        if (current) Sonar.configure(current.sonar, current.self.slot);
        await Sonar.start();
        await api('sound', { ready: true });
      } catch (error) {
        showCaught(error);
      }
      try {
        await startTracking();
      } catch (error) {
        showError(`Location: ${error instanceof Error ? error.message : 'unavailable'}`);
      }
      poll();
    },

    async start() {
      showError('');
      try {
        await upload(await getLocation()); // the zone is centred on a fresh fix
        apply(await api<GameView>('start', {}));
      } catch (error) {
        showCaught(error);
      }
    },

    async kill(targetId) {
      try {
        apply(await api<GameView>('kill', { targetId }));
        navigator.vibrate?.(120);
      } catch (error) {
        showCaught(error);
      }
    },

    async reset() {
      try {
        apply(await api<GameView>('reset', {}));
      } catch (error) {
        showCaught(error);
      }
    },

    async leave() {
      try {
        await api('leave', {});
        close();
      } catch (error) {
        showCaught(error);
      }
    },

    async quit() {
      if (!confirm('Quit the game? You can’t rejoin this round.')) return;
      try {
        await api('quit', {});
        close();
      } catch (error) {
        showCaught(error);
      }
    }
  };
}

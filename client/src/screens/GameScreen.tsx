// In game: full-screen map, HUD (role, map refresh, timer, quit), the impostor's kill bar,
// and the ?debug=1 readout.
import type { GameView, PlayerSummary, SonarGate } from '@oos/shared';
import { useEffect, useState } from 'react';
import { useTicker } from '../hooks/useTicker.ts';
import { getLocationState, useLocation } from '../lib/location.ts';
import { Sonar } from '../lib/sonar.ts';
import { formatClock, secondsUntil } from '../lib/time.ts';
import { World, type Dot } from '../lib/world.ts';

interface Props {
  view: GameView;
  onKill: (targetId: string) => Promise<void>;
  onQuit: () => void;
}

export function GameScreen({ view, onKill, onQuit }: Props) {
  useTicker(500);
  const { fix } = useLocation();
  const { self } = view;
  const impostor = self.role === 'impostor';
  const crew = !impostor && self.alive;

  // Map: zone + everyone in my snapshot; my own dot is my live position.
  useEffect(() => {
    if (!view.zone) return;
    const alive = new Set(view.players.filter(p => p.alive).map(p => p.id));
    const dots: Dot[] = view.positions
      .filter(p => p.location && p.id !== self.id && alive.has(p.id))
      .map(p => ({ lat: p.location!.latitude, lon: p.location!.longitude }));
    if (fix && self.alive) dots.push({ lat: fix.latitude, lon: fix.longitude, self: true });
    World.show(view.zone, dots);
  }, [view, fix, self.id, self.alive]);

  return (
    <section id="game">
      <div className="hud">
        <div className="hud-left">
          <span id="role" className="label">{!self.alive ? 'Signal lost' : impostor ? 'Impostor' : 'Crew'}</span>
          {crew && <span id="refresh" className="label">Map {secondsUntil(view.nextUpdateAt)}s</span>}
        </div>
        <div className="hud-right">
          <span id="timer" className="mono">{formatClock(secondsUntil(view.endsAt))}</span>
          <button id="quit" className="mini" onClick={onQuit}>Quit</button>
        </div>
      </div>

      {impostor && self.alive && <KillBar view={view} onKill={onKill} />}
      {Sonar.debug && <DebugPanel view={view} />}
      <button id="recenter" className="ghost" aria-label="Recenter" onClick={() => World.fitZone()}>◎</button>
    </section>
  );
}

// One button per player within ~2 m: charges for HOLD_S, then "Kill NAME".
function KillBar({ view, onKill }: { view: GameView; onKill: (targetId: string) => Promise<void> }) {
  useTicker(200);
  const [busy, setBusy] = useState<string | null>(null);
  const cooldown = secondsUntil(view.killCooldownUntil);

  const inRange = cooldown > 0 ? [] : view.players
    .filter(p => p.alive && p.id !== view.self.id)
    .map(player => ({ player, proximity: Sonar.near(player.slot) }))
    .filter(t => t.proximity.near);

  async function kill(target: PlayerSummary) {
    setBusy(target.id);
    await onKill(target.id);
    setBusy(null);
  }

  return (
    <div id="killbar">
      {inRange.length === 0 && (
        <button id="kill-idle" className="idle" disabled>
          {cooldown > 0 ? `Recharging ${cooldown}` : view.sonarOn ? 'No target in range' : 'Nobody close'}
        </button>
      )}
      {inRange.map(({ player, proximity }) => {
        const charged = proximity.heldS >= Sonar.HOLD_S;
        const percent = Math.min(100, (proximity.heldS / Sonar.HOLD_S) * 100);
        return (
          <button key={player.id} className={charged ? '' : 'charging'} disabled={!charged || busy === player.id} onClick={() => kill(player)}>
            <i style={{ width: `${percent}%` }} />
            <span>{charged ? `Kill ${player.name}` : `${player.name} · hold`}</span>
          </button>
        );
      })}
    </div>
  );
}

// ?debug=1: why the sonar is on/off, GPS quality, live dB per player.
function DebugPanel({ view }: { view: GameView }) {
  const gate: Partial<SonarGate> = view.gate ?? {};
  const { fix, uploadedAt } = getLocationState();
  const describe = (f?: { acc: number; age: number } | null) => (f ? `±${f.acc} m, ${f.age}s old` : 'none');
  const phone = fix ? `±${Math.round(fix.accuracy)} m, sent ${Math.round((Date.now() - uploadedAt) / 1000)}s ago` : 'none';
  const levels = view.players
    .filter(p => p.id !== view.self.id && p.alive)
    .map(p => {
      const { near, heldS, db } = Sonar.near(p.slot);
      return `${p.name.slice(0, 6)} ${Number.isFinite(db) ? db.toFixed(0) : '–'}${near ? `*${heldS.toFixed(1)}s` : ''}`;
    })
    .join('  ');

  return (
    <pre id="debug">
      {[
        `SONAR ${view.sonarOn ? 'ON' : 'off'} (${gate.why ?? '?'}) · kill ≥${Sonar.KILL_DB} dB`,
        `nearest on GPS: ${gate.nearest ? `${gate.nearest.m} m (them ${describe(gate.nearest)})` : '–'}`,
        `me on server: ${describe(gate.me)} · phone: ${phone}`,
        `dB: ${levels || '–'}`
      ].join('\n')}
    </pre>
  );
}

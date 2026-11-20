// In game: full-screen map, HUD (role, map refresh, timer, quit), the impostor's kill bar,
// and the ?debug=1 readout.
import { api } from '../api.js';
import { $, showError } from '../dom.js';
import { gps } from '../location.js';
import { Sonar } from '../sonar.js';
import { formatClock, serverNow, store } from '../store.js';
import { World } from '../world.js';

const secondsUntil = time => Math.max(0, Math.ceil((time - serverNow()) / 1000));

// ---------- map ----------

function renderMap(data) {
  const alive = new Set(data.players.filter(p => p.alive).map(p => p.id));
  const dots = data.positions
    .filter(p => p.location && p.id !== data.self.id && alive.has(p.id))
    .map(p => ({ lat: p.location.latitude, lon: p.location.longitude }));
  if (gps.fix && data.self.alive) dots.push({ lat: gps.fix.latitude, lon: gps.fix.longitude, self: true }); // you: live
  World.show(data.zone, dots);
}

// ---------- kill bar (impostor) ----------
// One button per living player, visible only while that player is within ~2 m. The buttons are only
// rebuilt when the set of targets changes, so a tap is never lost to a re-render.

let targetsKey = '';

function buildKillbar(data, render) {
  const targets = data.players.filter(p => p.alive && p.id !== data.self.id);
  const key = targets.map(p => `${p.id}:${p.slot}`).join();
  if (key === targetsKey) return;
  targetsKey = key;

  const idle = document.createElement('button');
  idle.id = 'kill-idle';
  idle.className = 'idle';
  idle.disabled = true;

  const buttons = targets.map(target => {
    const button = document.createElement('button');
    button.hidden = true;
    button.dataset.slot = target.slot;
    button.dataset.name = target.name;
    button.append(document.createElement('i'), document.createElement('span')); // charge bar, label
    button.onclick = () => kill(target.id, button, render);
    return button;
  });
  $('killbar').replaceChildren(idle, ...buttons);
}

async function kill(targetId, button, render) {
  button.dataset.busy = '1';
  button.disabled = true;
  try {
    render(await api('kill', { targetId }));
    navigator.vibrate?.(120);
  } catch (error) {
    showError(error.message);
  } finally {
    delete button.dataset.busy;
  }
}

// Runs 5×/s: updates the kill buttons from the sonar.
function updateKillbar() {
  const data = store.state;
  if (!data || $('killbar').hidden) return;
  const cooldown = data.killCooldownUntil ? secondsUntil(data.killCooldownUntil) : 0;

  let inRange = 0;
  for (const button of $('killbar').querySelectorAll('button[data-slot]')) {
    const { near, heldS } = Sonar.near(Number(button.dataset.slot));
    button.hidden = !near || cooldown > 0;
    if (button.hidden) continue;

    inRange++;
    const charged = heldS >= Sonar.HOLD_S;
    button.className = charged ? '' : 'charging';
    button.querySelector('i').style.width = `${Math.min(100, (heldS / Sonar.HOLD_S) * 100)}%`;
    button.querySelector('span').textContent = charged ? `Kill ${button.dataset.name}` : `${button.dataset.name} · hold`;
    if (!button.dataset.busy) button.disabled = !charged;
  }

  const idle = $('kill-idle');
  idle.hidden = inRange > 0;
  idle.textContent = cooldown > 0 ? `Recharging ${cooldown}` : data.sonarOn ? 'No target in range' : 'Nobody close';
}

// ---------- HUD ----------

function debugText(data) {
  const gate = data.gate || {};
  const fix = f => (f ? `±${f.acc} m, ${f.age}s old` : 'none');
  const phone = gps.fix ? `±${Math.round(gps.fix.accuracy)} m, sent ${Math.round((Date.now() - gps.uploadedAt) / 1000)}s ago` : 'none';
  const levels = data.players
    .filter(p => p.id !== data.self.id && p.alive)
    .map(p => {
      const { near, heldS, db } = Sonar.near(p.slot);
      return `${p.name.slice(0, 6)} ${Number.isFinite(db) ? db.toFixed(0) : '–'}${near ? `*${heldS.toFixed(1)}s` : ''}`;
    })
    .join('  ');
  return [
    `SONAR ${data.sonarOn ? 'ON' : 'off'} (${gate.why || '?'}) · kill ≥${Sonar.KILL_DB} dB`,
    `nearest on GPS: ${gate.nearest ? `${gate.nearest.m} m (them ${fix(gate.nearest)})` : '–'}`,
    `me on server: ${fix(gate.me)} · phone: ${phone}`,
    `dB: ${levels || '–'}`
  ].join('\n');
}

// Runs 2×/s: timer, crew map countdown, debug readout.
function updateHud() {
  const data = store.state;
  if (data?.phase !== 'playing') return;
  const crew = data.self.role !== 'impostor' && data.self.alive;
  $('refresh').hidden = !crew;
  if (crew) $('refresh').textContent = `Map ${secondsUntil(data.nextUpdateAt)}s`;
  $('debug').hidden = !Sonar.debug;
  if (Sonar.debug) $('debug').textContent = debugText(data);
  $('timer').textContent = formatClock(secondsUntil(data.endsAt));
}

// ---------- screen ----------

let render = () => {};

export function renderGame(data) {
  const impostor = data.self.role === 'impostor';
  $('role').textContent = !data.self.alive ? 'Signal lost' : impostor ? 'Impostor' : 'Crew';
  $('killbar').hidden = !(impostor && data.self.alive);
  if (impostor && data.self.alive) buildKillbar(data, render);
  renderMap(data);
  updateHud();
}

export function leaveGameScreen() {
  targetsKey = '';
}

export function initGame(options) {
  render = options.render;
  $('quit').onclick = options.quit;
  $('quit-dead').onclick = options.quit;
  $('recenter').onclick = () => World.fitZone();
  setInterval(updateKillbar, 200);
  setInterval(updateHud, 500);
}

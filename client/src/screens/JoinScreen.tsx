// Join screen: name, then either "Create lobby" (zone radius + max players) or "Join" (4-letter code).
// A shared link ?code=ABCD opens the Join panel with the code filled in.
import type { JoinResponse } from '@oos/shared';
import { useRef, useState, type FormEvent } from 'react';
import { Choice } from '../components/Choice.tsx';
import { api } from '../lib/api.ts';
import { getLocation, rememberFix, startTracking } from '../lib/location.ts';
import { showCaught, showError } from '../lib/toast.ts';

const NAME_KEY = 'oos-name';
const RADIUS_OPTIONS = [50, 100, 200, 300];
const PLAYER_OPTIONS = [2, 3, 4, 5, 6, 7, 8];

type Mode = 'choose' | 'create' | 'join';

const onlyLetters = (value: string) => value.toUpperCase().replace(/[^A-Z]/g, '');
const codeFromUrl = () => onlyLetters(new URLSearchParams(location.search).get('code') ?? '').slice(0, 4);

// After joining from a shared link, a reload shouldn't open the Join panel again (keeps ?debug etc.).
function dropCodeFromUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('code')) return;
  url.searchParams.delete('code');
  history.replaceState(null, '', url);
}

export function JoinScreen({ onJoined }: { onJoined: (token: string) => void }) {
  const [mode, setMode] = useState<Mode>(codeFromUrl() ? 'join' : 'choose');
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '');
  const [code, setCode] = useState(codeFromUrl);
  const [radius, setRadius] = useState(100);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  const open = (next: Mode) => {
    if (next !== 'choose' && !form.current?.reportValidity()) return; // name is required first
    showError('');
    setMode(next);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    showError('');
    if (mode === 'choose') return; // Enter on the name field: wait for Create / Join
    if (mode === 'join' && code.length !== 4) return showError('Enter the 4-letter lobby code.');

    setBusy(true);
    // Ask for the position right away so the map can start flying in while we join.
    const firstFix = getLocation().then(rememberFix).catch(() => {});
    try {
      const { token } = mode === 'create'
        ? await api<JoinResponse>('create', { name, radius, maxPlayers })
        : await api<JoinResponse>('join', { name, code });
      localStorage.setItem(NAME_KEY, name.trim());
      dropCodeFromUrl();
      setMode('choose');
      onJoined(token);
      firstFix.then(startTracking).catch(() => {});
    } catch (error) {
      showCaught(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="join" className="screen">
      <div className="mark">OUT OF<br />SIGNAL</div>

      <form id="join-form" className="stack" ref={form} onSubmit={submit}>
        <label htmlFor="name" className="label">Name</label>
        <input id="name" maxLength={24} required autoComplete="nickname" spellCheck={false}
          value={name} onChange={e => setName(e.target.value)} />

        {mode === 'choose' && (
          <div id="choose" className="duo">
            <button type="button" id="go-create" onClick={() => open('create')}>Create lobby</button>
            <button type="button" id="go-join" className="ghost" onClick={() => open('join')}>Join</button>
          </div>
        )}

        {mode === 'create' && (
          <div id="create-opts" className="stack">
            <span className="label">Zone radius</span>
            <Choice id="opt-radius" label="Zone radius" options={RADIUS_OPTIONS} value={radius} onChange={setRadius} format={r => `${r} m`} />
            <span className="label">Players</span>
            <Choice id="opt-max" label="Max players" options={PLAYER_OPTIONS} value={maxPlayers} onChange={setMaxPlayers} />
            <div className="duo">
              <button type="button" className="ghost" onClick={() => open('choose')}>Back</button>
              <button id="do-create" disabled={busy}>Create</button>
            </div>
          </div>
        )}

        {mode === 'join' && (
          <div id="join-opts" className="stack">
            <label htmlFor="code" className="label">Lobby code</label>
            <input id="code" className="code-input" maxLength={4} autoComplete="off" autoCapitalize="characters"
              spellCheck={false} placeholder="ABCD" autoFocus value={code} onChange={e => setCode(onlyLetters(e.target.value))} />
            <div className="duo">
              <button type="button" className="ghost" onClick={() => open('choose')}>Back</button>
              <button id="do-join" disabled={busy}>Join</button>
            </div>
          </div>
        )}
      </form>

      <p className="fine">2 m kill range · 2–8 players · one impostor</p>
    </section>
  );
}

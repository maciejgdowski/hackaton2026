// Sonar lab page: React view over the SonarLab engine (re-renders on every engine change / 100 ms tick).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { COLORS, CONDS, DISTS, NOISE_OK, SonarLab, f1, slotName, type Settings } from './engine.ts';

const lab = new SonarLab();

export function SonarLabPage() {
  useSyncExternalStore(lab.subscribe, lab.getVersion);

  useEffect(() => {
    const onDown = () => lab.resumeAudio();
    const onVis = () => lab.onVisible();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('visibilitychange', onVis);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (lab.err) errRef.current?.scrollIntoView({ block: 'center' }); }, [lab.err]);

  const slots = [...Array(lab.S.slots).keys()];
  return (
    <>
      <main>
        <h1>📡 Sonar proximity test</h1>
        <div className="warn">iPhone: turn OFF silent mode. Disconnect Bluetooth headphones. Volume up.</div>
        {lab.err && <div ref={errRef} className="err">{lab.err}</div>}

        <h2>My slot</h2>
        <SlotPicker slots={slots} selected={lab.mySlot} onPick={i => lab.setMySlot(i)} />

        {!lab.started && <div className="panel" style={{ marginTop: 12 }}><button id="start" onClick={() => void lab.start()}>START</button></div>}

        {lab.started && <>
          <Header />
          <Emitter />
          <Proximity slots={slots} />
          <Logger slots={slots} />
          <SettingsPanel />
          <details className="panel"><summary>Device info</summary>
            <div className="kv">{lab.devInfo.map(([k, v]) => <Kv key={k} k={k}><span style={{ wordBreak: 'break-all' }}>{v}</span></Kv>)}</div>
          </details>
        </>}
      </main>

      {lab.dead && (
        <div id="dead">
          <h1>📵 SIGNAL LOST</h1>
          <p>{lab.deadBy}</p>
          <p style={{ fontSize: 14 }}>Your phone stopped broadcasting.</p>
          <button style={{ marginTop: 30 }} onClick={() => lab.respawn()}>Respawn (test)</button>
        </div>
      )}
    </>
  );
}

function Kv({ k, children }: { k: string; children: ReactNode }) {
  return <><b>{k}</b>{children}</>;
}

function SlotPicker({ slots, selected, onPick }: { slots: number[]; selected: number; onPick: (i: number) => void }) {
  return (
    <div className="g4">
      {slots.map(i => {
        const sel = i === selected, color = COLORS[i][0];
        return <button key={i} className={'slotbtn' + (sel ? ' sel' : '')} style={{ borderColor: color, background: sel ? color : undefined }}
          onClick={() => onPick(i)}>{i}</button>;
      })}
    </div>
  );
}

function Choices<T extends string | number>({ items, selected, label, onPick, className }:
  { items: T[]; selected: T; label: (t: T) => string; onPick: (t: T) => void; className: string }) {
  return (
    <div className={className}>
      {items.map(it => <button key={it} className={it === selected ? 'on' : ''} onClick={() => onPick(it)}>{label(it)}</button>)}
    </div>
  );
}

function Dot({ slot }: { slot: number }) {
  return <span style={{ color: COLORS[slot][0] }}>●</span>;
}

function Header() {
  const audio = lab.audioDesc;
  return (
    <div className="panel">
      <div className="big"><Dot slot={lab.mySlot} /> {slotName(lab.mySlot)} · {lab.slotFreqs(lab.mySlot).join(' / ')} Hz · ID {lab.myId}</div>
      <div className="kv" style={{ marginTop: 6 }}>
        <Kv k="Emit"><span>{lab.emitDesc}</span></Kv>
        <Kv k="Audio"><span style={{ color: audio.ok ? undefined : 'var(--bad)' }}>{audio.text}</span></Kv>
        <Kv k="Mic"><span>{lab.micFlags}</span></Kv>
        <Kv k="Wake lock"><span>{lab.wakeDesc}</span></Kv>
      </div>
    </div>
  );
}

function Emitter() {
  return <>
    <h2>Emitter</h2>
    <div className="panel">
      <div className="g2">
        <button className={lab.emitting ? 'on' : ''} onClick={() => lab.toggleEmit()}>{lab.emitting ? 'Emit: ON' : 'Emit: OFF'}</button>
        <button onClick={() => lab.togglePulsed()}>{lab.pulsed ? `Pulsed ${lab.S.pulseMs} ms` : 'Continuous'}</button>
      </div>
      <label>Volume <span>{lab.volume.toFixed(2)}</span></label>
      <input type="range" min="0" max="1" step="0.05" value={lab.volume} onChange={e => lab.setVolume(+e.target.value)} />
      <label>Masking noise (soft rumble below 6 kHz, hides the whine a bit) <span>{lab.mask ? lab.mask.toFixed(2) : 'off'}</span></label>
      <input type="range" min="0" max="1" step="0.05" value={lab.mask} onChange={e => lab.setMask(+e.target.value)} />
    </div>
  </>;
}

function Proximity({ slots }: { slots: number[] }) {
  const now = performance.now(), S = lab.S;
  const others = slots.filter(i => i !== lab.mySlot);
  const near = others.filter(i => lab.inRange[i]);
  const best = near.reduce((b, i) => b < 0 || lab.avg1[i] > lab.avg1[b] ? i : b, -1);

  return <>
    <h2>Within 2 m?</h2>
    <div id="killBanner" className={near.length ? 'in' : ''}>
      {near.length ? '🔪 within 2 m: ' + near.map(slotName).join(', ') : 'nobody within 2 m'}
    </div>
    <div>
      {others.filter(i => !lab.dead && lab.nearFor(i, now)).map(i => {
        const held = (now - lab.inSince[i]) / 1000, ready = held >= S.killHold && !lab.killSending;
        const pc = Math.min(100, held / S.killHold * 100);
        return (
          <button key={i} className="killbtn" disabled={!ready} onClick={() => lab.kill(i)}
            style={ready ? undefined : { background: `linear-gradient(to right,#6b2626 ${pc}%,#2a323b ${pc}%)` }}>
            {ready ? `🔪 KILL ${slotName(i)}`
              : lab.killSending ? 'sending kill…'
              : `${slotName(i)} – stay close ${Math.max(0, S.killHold - held).toFixed(1)} s` + (lab.inRange[i] ? '' : ' (signal blip)')}
          </button>
        );
      })}
    </div>
    <div id="killMsg" className="dim">{lab.killMsg}</div>
    <div className="panel">
      <div className="hdr"><span>slot</span><span>live dB</span><span>1 s dB</span><span>≤2 m</span></div>
      {slots.map(i => {
        const live = lab.live[i], off = lab.peakOff[i], avg = lab.avg1[i], inR = lab.inRange[i];
        return (
          <div key={i} className={'slot' + (i === best ? ' best' : '')}>
            <div className="name">
              <Dot slot={i} /> S{i}{i === lab.mySlot && <> <small>self</small></>}
              <small>{live >= NOISE_OK && Number.isFinite(off) ? ` ${off >= 0 ? '+' : ''}${off.toFixed(0)} Hz` : ''}</small>
            </div>
            <div className="num">{f1(live)}</div>
            <div className="num avg">{f1(avg)}</div>
            <div className={'badge ' + (inR ? 'IN' : 'OUT')}>{inR ? '≤2 m' : '—'}</div>
            <div className="bar"><i style={{ background: COLORS[i][0], width: Math.max(0, Math.min(100, (avg || 0) / 50 * 100)) + '%' }} /></div>
            <div className="tones">
              {lab.slotFreqs(i).map((f, t) => `${(f / 1000).toFixed(2)}k ${lab.toneMax1[i][t] > -100 ? lab.toneMax1[i][t].toFixed(0) : '–'}`).join(' · ')}
            </div>
          </div>
        );
      })}
    </div>
  </>;
}

function Logger({ slots }: { slots: number[] }) {
  const [ivNote, setIvNote] = useState('');
  const rec = lab.rec, ivl = lab.ivl;

  const cut = () => { lab.ivCut(ivNote); setIvNote(''); };
  const stop = () => {
    const secs = lab.ivSecs();
    if (secs > 2 && !confirm(`Stop? The last ${secs.toFixed(0)} s are not saved yet (press "Create interval" to keep them).`)) return;
    lab.ivStop();
  };
  const clear = () => { if (confirm(`Delete all ${lab.rows.length} recorded rows?`)) lab.clearRows(); };

  return <>
    <h2>Calibration logger</h2>
    <div className="panel">
      <label>Distance (m)</label>
      <Choices className="row" items={DISTS} selected={lab.dist} label={d => d + ' m'} onPick={d => lab.setDist(d)} />
      <label>Condition</label>
      <Choices className="g2" items={CONDS} selected={lab.cond} label={c => c} onPick={c => lab.setCond(c)} />
      <label>Source slot (phone being measured)</label>
      <SlotPicker slots={slots} selected={lab.srcSlot} onPick={i => lab.setSrcSlot(i)} />
      <label>Note</label>
      <input type="text" placeholder="e.g. windy, park, Pixel→iPhone" value={lab.note} onChange={e => lab.setNote(e.target.value)} />
      <button style={{ width: '100%', marginTop: 10, fontSize: 20, fontWeight: 800 }} disabled={!!rec} onClick={() => lab.startRecord()}>
        {rec ? `Recording… ${((rec.end - performance.now()) / 1000).toFixed(1)} s` : '● Record 3 s'}
      </button>
      <div className="dim" style={{ marginTop: 6 }}>{lab.recMsg}</div>

      <div style={{ borderTop: '1px solid #333', marginTop: 12, paddingTop: 10 }}>
        <label>Interval recording – record continuously, then cut labelled chunks (uses the distance / condition / source above)</label>
        {!ivl
          ? <button style={{ width: '100%', fontSize: 18, fontWeight: 800 }} onClick={() => lab.ivStart()}>▶ Start recording intervals</button>
          : <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>
                🔴 interval {lab.ivCount + 1}: {lab.ivSecs().toFixed(1)} s · S{lab.srcSlot} avg {f1(lab.ivSrcAvg())} dB · {lab.ivCount} saved
              </div>
              <label>What happened in this interval?</label>
              <input type="text" placeholder="e.g. walking 1→3 m, phone in pocket, door closed" value={ivNote}
                onChange={e => setIvNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') cut(); }} />
              <button style={{ width: '100%', marginTop: 8, fontSize: 20, fontWeight: 800 }} onClick={cut}>✂ Create interval</button>
              <div className="row" style={{ marginTop: 6 }}>
                <button onClick={() => lab.ivDrop()}>↺ Discard current</button><button onClick={stop}>■ Stop</button>
              </div>
            </div>}
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button onClick={() => void copyCSV()}>Copy CSV</button><button onClick={downloadCSV}>Download CSV</button><button onClick={clear}>Clear</button>
      </div>
      <div className="scroll" style={{ marginTop: 8 }}>
        <table>
          <thead><tr><th>time</th><th>s</th><th>src</th><th>m</th><th>cond</th><th>avg</th><th>min</th><th>max</th><th>in%</th><th>note</th></tr></thead>
          <tbody>
            {lab.rows.map((r, i) => (
              <tr key={i}>
                {[String(r.time).slice(11, 19), r.duration_s ?? 3, 'S' + r.src_slot, r.distance_m, r.condition, r.avg_db, r.min_db, r.max_db, r.in_range_pct, r.note]
                  .map((v, j) => <td key={j}>{v}</td>)}
              </tr>
            )).reverse()}
          </tbody>
        </table>
      </div>
    </div>
  </>;
}

async function copyCSV() {
  const txt = lab.toCSV(), n = lab.rows.length;
  try { await navigator.clipboard.writeText(txt); lab.setRecMsg(`Copied ${n} rows.`); }
  catch {
    const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); lab.setRecMsg(ok ? `Copied ${n} rows.` : 'Copy failed – use Download.');
  }
}
function downloadCSV() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lab.toCSV()], { type: 'text/csv' }));
  a.download = `sonar-S${lab.mySlot}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- settings ----------
interface Field { k: keyof Settings; label: string; step?: number; min?: number; max?: number; options?: string[] }
const FIELDS: Field[] = [
  { k: 'base', label: 'Base Hz', step: 50 },
  { k: 'spacing', label: 'Spacing Hz', step: 10 },
  { k: 'slots', label: 'Slots (phones)', step: 1, min: 1, max: 8 },
  { k: 'tones', label: 'Tones per phone', step: 1, min: 1, max: 4 },
  { k: 'dwell', label: 'Hop dwell ms', step: 50, min: 150 },
  { k: 'doppler', label: 'Doppler search ±Hz', step: 5, min: 5, max: 150 },
  { k: 'fft', label: 'FFT size', options: ['4096', '8192', '16384', '32768'] },
  { k: 'smooth', label: 'Smoothing (0–0.95)', step: 0.05, min: 0, max: 0.95 },
  { k: 'kill', label: 'In range (≤2 m) ≥ dB', step: 1 },
  { k: 'hyst', label: 'Leave range below (in − x dB)', step: 0.5, min: 0 },
  { k: 'killHold', label: 'Kill unlocks after (s in range)', step: 0.5, min: 0 },
  { k: 'killGrace', label: 'Dropout grace (s, keeps kill timer)', step: 0.5, min: 0 },
  { k: 'pulseMs', label: 'Pulse on/off ms', step: 50, min: 150 },
  { k: 'session', label: 'audioSession.type', options: ['play-and-record', 'playback', 'auto'] },
];

function SettingsPanel() {
  return (
    <details className="panel"><summary>Settings</summary>
      <div className="g2">
        {FIELDS.map(f => <div key={f.k}><label>{f.label}</label><SettingField key={String(lab.S[f.k])} f={f} /></div>)}
      </div>
      <small>Kill signal for slot v = base + (tones × slots + v) × spacing (just above all slot tones).
        Tone t of slot s = base + (t × slots + s) × spacing. Each phone hops between its tones every “dwell” ms. Doppler: ~60 Hz per 1 m/s at 20 kHz;
        needs spacing ≥ 2×Doppler + 10. All phones must use the same settings. audioSession change applies best after reload.</small>
    </details>
  );
}

// Number inputs keep a local draft and apply on blur / Enter (like the old onchange), then show the clamped value.
// Keyed by the stored value, so an external change remounts it with the new value.
function SettingField({ f }: { f: Field }) {
  const value = String(lab.S[f.k]);
  const [draft, setDraft] = useState(value);
  const commit = (raw: string) => { lab.setSetting(f.k, raw); setDraft(String(lab.S[f.k])); };
  if (f.options) return (
    <select value={value} onChange={e => commit(e.target.value)}>{f.options.map(o => <option key={o}>{o}</option>)}</select>
  );
  return (
    <input type="number" step={f.step} min={f.min} max={f.max} value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={e => commit(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

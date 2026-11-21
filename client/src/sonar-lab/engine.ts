// Sonar lab: standalone ultrasonic proximity test (served at /sonar/).
// Audio, DSP, kill mechanic and calibration logger. The React page subscribes to changes
// (version counter, bumped on every 100 ms tick and every action) and reads the fields directly.

export const MAXS = 8, MAXT = 4;
const FADE = 0.18, PULSE_RAMP = 0.08, GLIDE = 0.015;
export const COLORS: [string, string][] = [['#ff4d4d', 'red'], ['#ff9f1a', 'orange'], ['#ffe14d', 'yellow'], ['#3ddc84', 'green'],
  ['#33d6ff', 'cyan'], ['#4d7cff', 'blue'], ['#b066ff', 'purple'], ['#ff66c4', 'pink']];
export const DISTS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8];
export const CONDS = ['hand facing', 'hand away', 'pocket', 'body between'];
export const NOISE_OK = 12;                          // above this a peak is clearly a real tone

// ---------- storage (always try/catch: private mode / blocked storage) ----------
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem('sonar.' + k); return v == null ? d : JSON.parse(v) as T; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem('sonar.' + k, JSON.stringify(v)); } catch { /* ignore */ } }
};

export interface Settings {
  base: number; spacing: number; slots: number; tones: number; dwell: number; doppler: number; fft: number; smooth: number;
  kill: number; hyst: number; pulseMs: number; killHold: number; killGrace: number; session: string;
}
// 'settings5': new key so phones that saved older settings get the new defaults.
// Back to 17.8 kHz+: above 20 kHz phone speakers/mics are much weaker. One tone per phone.
// kill 27 / hyst 5 (enter ≥27, leave <22), from interval runs: standing in zone 33 dB (min 21), walking in zone 31 dB, border 27 dB, out 19 dB (max 29).
const DEFAULTS: Settings = { base: 17800, spacing: 300, slots: 4, tones: 1, dwell: 250, doppler: 100, fft: 8192, smooth: 0.3,
  kill: 27, hyst: 5, pulseMs: 300, killHold: 3.5, killGrace: 1.5, session: 'play-and-record' };
const LIMITS: Partial<Record<keyof Settings, [number, number]>> = { killHold: [0, 30], killGrace: [0, 10], hyst: [0, 20], smooth: [0, 0.95],
  slots: [1, MAXS], tones: [1, MAXT], dwell: [150, 5000], doppler: [5, 150], pulseMs: [150, 5000] };

export interface Row {
  time: string; end_time: string; duration_s?: number | ''; kind: string; my_slot: number; src_slot: number; src_freq_hz: string;
  distance_m: number; condition: string; avg_db: number | ''; min_db: number | ''; max_db: number | ''; samples: number;
  in_range_pct: number | ''; tones_db: string; mode: string; fft: number; note: string; device: string; doppler_hz: number; all_slots_avg_db: string;
}
const COLS: (keyof Row)[] = ['time', 'end_time', 'duration_s', 'kind', 'my_slot', 'src_slot', 'src_freq_hz', 'distance_m', 'condition', 'avg_db', 'min_db', 'max_db',
  'samples', 'in_range_pct', 'tones_db', 'mode', 'fft', 'note', 'device', 'all_slots_avg_db', 'doppler_hz'];

interface Sample { t: number; v: number }
interface Buf { t0: number; wall0: string; samples: number[][]; tone: number[][][]; inr: number[][] }
interface Stat { avg: number; min: number; max: number; n: number }

// ---------- small helpers ----------
const grid = <T,>(a: number, b: number, f: () => T): T[][] => [...Array(a)].map(() => [...Array(b)].map(f));
export const f1 = (v: number) => Number.isFinite(v) ? v.toFixed(1) : '–';
const r1 = (v: number) => Number.isFinite(v) ? Math.round(v * 10) / 10 : '';
export const slotName = (i: number) => `S${i} ${COLORS[i][1]}`;
const dbv = (v: number) => Number.isFinite(v) ? v : -200;     // -Infinity on digital silence
const stat = (a: number[]): Stat => a.length
  ? { avg: a.reduce((x, y) => x + y, 0) / a.length, min: Math.min(...a), max: Math.max(...a), n: a.length }
  : { avg: NaN, min: NaN, max: NaN, n: 0 };
const newBuf = (): Buf => ({ t0: performance.now(), wall0: new Date().toISOString(),
  samples: [...Array(MAXS)].map(() => []), tone: grid<number[]>(MAXS, MAXT, () => []), inr: [...Array(MAXS)].map(() => []) });
const csvCell = (x: unknown) => { const v = x == null ? '' : String(x); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

const ua = navigator.userAgent;
const shortUA = (((ua.match(/\(([^)]*)\)/) || [])[1] || '') + ' ' +
  ((ua.match(/(CriOS|FxiOS|EdgA|SamsungBrowser|Firefox|Chrome|Version)\/[\d.]+/) || [''])[0])).slice(0, 90);

// Safari-only / legacy APIs missing from lib.dom
const audioSession = () => (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
function setSessionType(v: string) { const a = audioSession(); if (a && v !== 'auto') { try { a.type = v; } catch { /* ignore */ } } }

// Kill tone: stay within 2 m for S.killHold s -> KILL. Killing plays a short tone for the victim's
// slot (a separate frequency above all slot tones). The victim hears it, stops broadcasting and
// shows SIGNAL LOST. The killer sees the victim's signal vanish.
const KILL_TX_MS = 2000, KILL_HEAR_DB = 15, KILL_HEAR_TICKS = 4, CONFIRM_MS = 6000;

export class SonarLab {
  S: Settings = { ...DEFAULTS, ...store.get<Partial<Settings>>('settings5', {}) };
  mySlot = this.clampSlot(store.get('slot', 0));
  srcSlot = this.clampSlot(store.get('src', 1));
  dist = store.get('dist', 2);
  cond = store.get('cond', CONDS[0]);
  rows: Row[] = (r => Array.isArray(r) ? r : [])(store.get<Row[]>('rows', []));

  started = false;
  err = '';
  emitting = true;
  pulsed = false;
  volume = 0.5;
  mask = 0;
  note = '';                                         // note for the 3 s recording

  // per-slot signal (see tick)
  live: number[] = []; avg1: number[] = []; peakOff: number[] = []; toneMax1: number[][] = [];
  inRange: boolean[] = Array(MAXS).fill(false);
  inSince: number[] = Array(MAXS).fill(0);
  private lastIn: number[] = Array(MAXS).fill(-1e9);
  private hist: Sample[][] = []; private histT: Sample[][][] = [];

  // kill
  dead = false; deadBy = ''; killMsg = '';
  private killTx: number | null = null;
  private killHeard = 0;
  private pending: { v: number; t: number } | null = null;

  // logger
  rec: (Buf & { end: number }) | null = null;
  recMsg = '';
  ivl: Buf | null = null;
  ivCount = 0;

  // audio graph
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  micTrack: MediaStreamTrack | null = null;
  wakeLock: WakeLockSentinel | null = null;
  private osc: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private maskGain: GainNode | null = null;
  private killOsc: OscillatorNode | null = null;
  private killGain: GainNode | null = null;
  private spec = new Float32Array(0);
  private scratch = new Float32Array(1024);
  private pulseTimer: number | undefined;
  private hopTimer: number | undefined;
  private hopIdx = 0;

  // ---------- change notification (for useSyncExternalStore) ----------
  private version = 0;
  private listeners = new Set<() => void>();
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getVersion = () => this.version;
  private changed() { this.version++; this.listeners.forEach(f => f()); }

  constructor() { this.resetHist(); }

  // ---------- frequencies ----------
  // Slot s, tone t. Tones are interleaved (t*slots + s) so one phone's tones are slots*spacing
  // apart -> they fade independently in multipath (frequency diversity).
  toneFreq(s: number, t: number) { return this.S.base + (t * this.S.slots + s) * this.S.spacing; }
  slotFreqs(s: number) { return [...Array(this.S.tones).keys()].map(t => this.toneFreq(s, t)); }
  killFreq(v: number) { return this.S.base + (this.S.tones * this.S.slots + v) * this.S.spacing; }
  private clampSlot(i: number) { return Math.max(0, Math.min(this.S.slots - 1, i | 0)); }

  private resetHist() {
    this.hist = [...Array(MAXS)].map(() => []); this.histT = grid<Sample[]>(MAXS, MAXT, () => []);
    this.live = Array(MAXS).fill(NaN); this.avg1 = Array(MAXS).fill(NaN); this.peakOff = Array(MAXS).fill(NaN);
    this.toneMax1 = grid(MAXS, MAXT, () => NaN);
  }

  // ---------- range: 2 m or not ----------
  // Enter range when the 1 s average ≥ S.kill, leave only when it drops below S.kill − S.hyst
  // (hysteresis, so it doesn't flicker at the boundary).
  // Dropouts shorter than S.killGrace s don't reset the kill timer, and you can still kill during them.
  nearFor(s: number, now: number) { return this.inRange[s] || now - this.lastIn[s] < this.S.killGrace * 1000; }
  private updateRange(s: number) {
    const v = this.avg1[s], was = this.inRange[s], now = performance.now();
    this.inRange[s] = Number.isFinite(v) && (was ? v >= this.S.kill - this.S.hyst : v >= this.S.kill);
    if (this.inRange[s] && !was && now - this.lastIn[s] >= this.S.killGrace * 1000) this.inSince[s] = now;   // fresh approach, not a blip
    if (this.inRange[s]) this.lastIn[s] = now;
  }
  get killSending() { return this.killTx !== null; }

  // ---------- kill mechanic ----------
  kill(v: number) {
    const ctx = this.ctx;
    if (!ctx || this.dead || this.killTx || !this.nearFor(v, performance.now())) return;
    if (!this.killOsc || !this.killGain) {
      this.killOsc = ctx.createOscillator(); this.killOsc.type = 'sine';
      this.killGain = ctx.createGain(); this.killGain.gain.value = 0;
      this.killOsc.connect(this.killGain); this.killGain.connect(ctx.destination); this.killOsc.start();
    }
    this.killOsc.frequency.setValueAtTime(this.killFreq(v), ctx.currentTime);
    const t = ctx.currentTime, g = this.killGain.gain, lvl = Math.max(0.3, this.volume);
    g.cancelScheduledValues(t); g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(lvl, t + FADE); g.setValueAtTime(lvl, t + KILL_TX_MS / 1000 - FADE);
    g.linearRampToValueAtTime(0, t + KILL_TX_MS / 1000);
    this.killTx = window.setTimeout(() => { this.killTx = null; }, KILL_TX_MS);
    this.pending = { v, t: performance.now() };
    navigator.vibrate?.(80);
    this.killMsg = `🔪 Kill sent to ${slotName(v)}…`;
    this.changed();
  }
  // Called every tick: victim side (hear my kill tone) + killer side (confirm the victim went silent).
  private killTick(binHz: number, now: number) {
    if (!this.dead) {
      const [v] = this.toneSnr(this.killFreq(this.mySlot), binHz);
      this.killHeard = v >= KILL_HEAR_DB ? this.killHeard + 1 : 0;
      if (this.killHeard >= KILL_HEAR_TICKS) this.die();
    }
    if (this.pending) {
      const age = now - this.pending.t;
      if (age > KILL_TX_MS && !(this.avg1[this.pending.v] >= NOISE_OK)) {
        this.killMsg = `☠ ${slotName(this.pending.v)} – signal lost (confirmed)`; this.pending = null;
      } else if (age > CONFIRM_MS) {
        this.killMsg = `⚠ ${slotName(this.pending.v)} still broadcasting – kill not received`; this.pending = null;
      }
    }
  }
  private die() {
    this.dead = true; this.killHeard = 0;
    // best guess at the killer: the strongest phone in range right now
    let by = -1;
    for (let i = 0; i < this.S.slots; i++)
      if (i !== this.mySlot && Number.isFinite(this.avg1[i]) && (by < 0 || this.avg1[i] > this.avg1[by])) by = i;
    this.emitting = false; this.applyEmit();
    this.deadBy = by >= 0 ? `Killed – probably by ${slotName(by)}.` : 'You were killed.';
    navigator.vibrate?.([300, 100, 300, 100, 600]);
  }
  respawn() { this.dead = false; this.killHeard = 0; this.emitting = true; this.applyEmit(); }

  // ---------- pickers ----------
  setMySlot(i: number) { this.mySlot = i; store.set('slot', i); this.restartHop(); this.changed(); }
  setSrcSlot(i: number) { this.srcSlot = i; store.set('src', i); this.changed(); }
  setDist(d: number) { this.dist = d; store.set('dist', d); this.changed(); }
  setCond(c: string) { this.cond = c; store.set('cond', c); this.changed(); }
  setNote(n: string) { this.note = n; this.changed(); }

  // ---------- START: AudioContext + getUserMedia must be created inside this tap (iOS) ----------
  async start() {
    if (this.ctx) return;
    this.err = ''; this.changed();
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw new Error('Microphone API unavailable. Open this page over HTTPS in Safari or Chrome (not an in-app browser like Messenger/Instagram).');
      setSessionType(this.S.session);
      const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser.');
      const ctx = this.ctx = new AC();
      ctx.resume().catch(() => {});          // don't await: keep the gesture for getUserMedia
      ctx.onstatechange = () => this.changed();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.micTrack = stream.getAudioTracks()[0];
      this.micTrack.onended = () => { this.err = 'Microphone stopped (another app took it, or permission was revoked). Reload the page.'; this.changed(); };
      if (ctx.state !== 'running') ctx.resume().catch(() => {});

      // Listener: mic -> analyser only. Never connected to destination (no feedback).
      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      src.connect(this.analyser);
      this.applyAnalyser();

      // Emitter: sine osc runs forever; gain is ramped for on/off, frequency glides for hops.
      this.osc = ctx.createOscillator(); this.osc.type = 'sine'; this.osc.frequency.value = this.toneFreq(this.mySlot, 0);
      this.gain = ctx.createGain(); this.gain.gain.value = 0;
      this.osc.connect(this.gain); this.gain.connect(ctx.destination); this.osc.start();
      this.buildMask();

      this.started = true;
      void this.requestWake(); this.applyEmit(); this.restartHop();
      window.setInterval(() => this.tick(), 100);
    } catch (e) {
      const { name: n, message } = (e ?? {}) as { name?: string; message?: string };
      let msg = message || String(e);
      if (n === 'NotAllowedError' || n === 'SecurityError')
        msg = 'Microphone permission denied.\niPhone: Settings › Apps › Safari › Microphone → Ask/Allow, or tap “aA” › Website Settings › Microphone.\nAndroid Chrome: tap the icon left of the URL › Permissions › Microphone → Allow.\nThen reload this page.';
      else if (n === 'NotFoundError') msg = 'No microphone found.';
      else if (n === 'NotReadableError') msg = 'Microphone is busy (phone call or another app using it). Close it and reload.';
      this.err = 'Could not start: ' + msg;
      if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
      this.changed();
    }
  }

  private applyAnalyser() {
    if (!this.analyser) return;
    this.analyser.fftSize = this.S.fft;
    this.analyser.smoothingTimeConstant = this.S.smooth;
    this.spec = new Float32Array(this.analyser.frequencyBinCount);
    this.resetHist();
  }

  // ---------- emitter: gain envelope (on/off/pulse) ----------
  private rampTo(v: number, dur: number) {
    if (!this.gain || !this.ctx) return;
    const t = this.ctx.currentTime, g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);             // start the ramp from wherever we are now
    g.linearRampToValueAtTime(v, t + dur);
  }
  private applyEmit() {
    clearInterval(this.pulseTimer); this.pulseTimer = undefined;
    this.changed();
    if (!this.gain) return;
    if (!this.emitting) return this.rampTo(0, FADE);
    if (!this.pulsed) return this.rampTo(this.volume, FADE);
    let on = true; this.rampTo(this.volume, PULSE_RAMP);
    this.pulseTimer = window.setInterval(() => { on = !on; this.rampTo(on ? this.volume : 0, PULSE_RAMP); }, this.S.pulseMs);
  }
  toggleEmit() { this.emitting = !this.emitting; this.applyEmit(); }
  togglePulsed() { this.pulsed = !this.pulsed; this.applyEmit(); }
  setVolume(v: number) {
    this.volume = v;
    if (this.emitting && !this.pulsed) this.rampTo(v, 0.08);
    this.changed();
  }

  // ---------- masking noise ----------
  // Looping pink noise through 4 cascaded low-passes at 6 kHz (≈ -75 dB at 17.8 kHz), so it
  // masks the audible whine a little without raising the noise floor where we detect.
  private buildMask() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;   // Paul Kellet pink-noise filter
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    let node: AudioNode = src;
    for (let i = 0; i < 4; i++) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 6000; node.connect(f); node = f; }
    this.maskGain = ctx.createGain(); this.maskGain.gain.value = 0;
    node.connect(this.maskGain); this.maskGain.connect(ctx.destination); src.start();
    this.setMask(this.mask);
  }
  setMask(v: number) {
    this.mask = v;
    if (this.maskGain && this.ctx) {
      const t = this.ctx.currentTime, g = this.maskGain.gain;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v * v, t + 0.3);  // squared: finer control at low levels
    }
    this.changed();
  }

  // ---------- emitter: frequency hopping ----------
  // One tone at a time at constant amplitude, gliding to the next tone every S.dwell ms.
  // (Simultaneous tones would intermodulate in the speaker into an audible difference tone.)
  private glideTo(f: number) {
    if (!this.osc || !this.ctx) return;
    const t = this.ctx.currentTime, p = this.osc.frequency;
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(f, t + GLIDE);
  }
  private restartHop() {
    clearInterval(this.hopTimer); this.hopTimer = undefined; this.hopIdx = 0;
    if (!this.osc) return;
    this.glideTo(this.toneFreq(this.mySlot, 0));
    if (this.S.tones > 1) this.hopTimer = window.setInterval(() => {
      this.hopIdx = (this.hopIdx + 1) % this.S.tones; this.glideTo(this.toneFreq(this.mySlot, this.hopIdx));
    }, this.S.dwell);
  }

  // ---------- DSP ----------
  // Noise floor near bin k = median of bins within ±250 Hz. The median ignores the few bins
  // that hold tones (ours or other phones'), so tones can sit close together.
  private noiseDb(k: number, binHz: number) {
    const r = Math.min(500, Math.round(250 / binHz)), n = this.spec.length;
    let c = 0;
    for (let j = Math.max(0, k - r); j <= Math.min(n - 1, k + r); j++) this.scratch[c++] = dbv(this.spec[j]);
    return c ? this.scratch.subarray(0, c).sort()[c >> 1] : NaN;
  }
  // SNR of one tone = strongest bin within ±D Hz (Doppler: ~60 Hz per 1 m/s at 20 kHz) minus
  // the local noise floor. Pure noise reads ~8 dB here (max of many bins vs. median).
  private toneSnr(f: number, binHz: number): [number, number] {
    const n = this.spec.length, k = Math.round(f / binHz), w = Math.max(1, Math.round(this.S.doppler / binHz));
    if (k + w >= n) return [NaN, NaN];                // above Nyquist
    let peak = -Infinity, pj = k;
    for (let j = k - w; j <= k + w; j++) if (dbv(this.spec[j]) > peak) { peak = dbv(this.spec[j]); pj = j; }
    return [peak - this.noiseDb(k, binHz), (pj - k) * binHz];
  }

  private tick() {
    const { analyser, ctx } = this;
    if (!analyser || !ctx) return;
    analyser.getFloatFrequencyData(this.spec);
    const binHz = ctx.sampleRate / analyser.fftSize, now = performance.now();
    for (let s = 0; s < this.S.slots; s++) {
      // The emitting phone plays one of its tones at a time -> slot value = best tone right now.
      let best = NaN, bt = 0, off = NaN;
      for (let t = 0; t < this.S.tones; t++) {
        const [v, o] = this.toneSnr(this.toneFreq(s, t), binHz), h = this.histT[s][t];
        h.push({ t: now, v });
        while (h.length && now - h[0].t > 1000) h.shift();
        this.toneMax1[s][t] = Math.max(...h.map(p => dbv(p.v)));
        if (Number.isFinite(v) && !(v <= best)) { best = v; bt = t; off = o; }
      }
      this.live[s] = best; this.peakOff[s] = off;
      const h = this.hist[s]; h.push({ t: now, v: best });
      while (h.length && now - h[0].t > 1000) h.shift();
      let sum = 0, c = 0;                              // 1 s rolling average (dB) over all hops
      for (const p of h) if (Number.isFinite(p.v)) { sum += p.v; c++; }
      this.avg1[s] = c ? sum / c : NaN;
      this.updateRange(s);
      if (this.rec) this.pushBuf(this.rec, s, best, bt);
      if (this.ivl) this.pushBuf(this.ivl, s, best, bt);
    }
    if (this.rec && now >= this.rec.end) this.finishRecord();
    this.killTick(binHz, now);
    this.changed();
  }

  // ---------- header / device ----------
  get emitDesc() {
    const S = this.S;
    return !this.emitting ? 'OFF' : (this.pulsed ? `ON, pulsed ${S.pulseMs} ms` : 'ON, continuous') +
      ` · vol ${this.volume.toFixed(2)}` + (S.tones > 1 ? ` · hopping ${S.tones} tones / ${S.dwell} ms` : '');
  }
  get audioDesc(): { text: string; ok: boolean } {
    const ctx = this.ctx;
    if (!ctx) return { text: '', ok: true };
    const binHz = this.analyser ? (ctx.sampleRate / this.analyser.fftSize).toFixed(2) : '?';
    const warn: string[] = [];
    if (this.S.spacing < 2 * this.S.doppler + 10) warn.push(`spacing ${this.S.spacing} too small for Doppler ±${this.S.doppler}`);
    const top = this.killFreq(this.S.slots - 1);
    if (top + this.S.doppler + 250 > ctx.sampleRate / 2) warn.push(`top tone ${top} Hz too close to Nyquist ${ctx.sampleRate / 2}`);
    return { text: `${ctx.sampleRate} Hz · FFT ${this.S.fft} · bin ${binHz} Hz · ctx ${ctx.state}` + warn.map(w => ' · ⚠ ' + w).join(''),
      ok: ctx.state === 'running' && !warn.length };
  }
  get micFlags() {
    if (!this.micTrack) return '';
    let s: MediaTrackSettings = {}; try { s = this.micTrack.getSettings() || {}; } catch { /* ignore */ }
    const keys = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
    return keys.map(k => `${k.replace('Cancellation', 'Canc').replace('Suppression', 'Supp').replace('GainControl', 'Gain')} ${s[k] === false ? '✓off' : s[k] === true ? '✗ON' : '?n/a'}`).join(' · ');
  }
  get wakeDesc() { return !('wakeLock' in navigator) ? 'unsupported – keep screen awake manually' : this.wakeLock ? 'held ✓' : 'not held'; }
  get devInfo(): [string, string][] {
    const a = audioSession();
    return [['UA', shortUA], ['Sample rate', this.ctx ? this.ctx.sampleRate + ' Hz' : '?'], ['audioSession', a ? 'yes (' + a.type + ')' : 'no'],
      ['wakeLock', 'wakeLock' in navigator ? 'yes' : 'no'], ['Mic label', this.micTrack ? this.micTrack.label || '?' : '?'], ['Full UA', ua]];
  }
  private async requestWake() {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => { this.wakeLock = null; this.changed(); });
      } catch { this.wakeLock = null; }
    }
    this.changed();
  }
  // iOS may suspend/interrupt the context; any tap or returning to the tab resumes it.
  resumeAudio() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  onVisible() {
    if (document.visibilityState !== 'visible' || !this.ctx) return;
    this.resumeAudio();
    if (!this.wakeLock) void this.requestWake();
  }

  // ---------- settings ----------
  // Applies a raw input value (clamped / rounded); invalid numbers are ignored.
  setSetting(k: keyof Settings, raw: string) {
    let v: number | string = raw;
    if (k !== 'session') {
      let n = parseFloat(raw);
      if (!Number.isFinite(n)) { this.changed(); return; }
      const lim = LIMITS[k];
      if (lim) n = Math.max(lim[0], Math.min(lim[1], n));
      if (k === 'slots' || k === 'tones') n = Math.round(n);
      v = n;
    }
    (this.S as unknown as Record<string, number | string>)[k] = v;
    store.set('settings5', this.S);
    if (['base', 'spacing', 'slots', 'tones', 'dwell'].includes(k)) {
      this.mySlot = this.clampSlot(this.mySlot); this.srcSlot = this.clampSlot(this.srcSlot);
      this.resetHist(); this.restartHop();
    }
    if ((k === 'fft' || k === 'smooth') && this.analyser) this.applyAnalyser();
    if (k === 'pulseMs') this.applyEmit();
    if (k === 'session') setSessionType(String(v));
    this.changed();
  }

  // ---------- calibration logger ----------
  private pushBuf(b: Buf, s: number, best: number, bt: number) {
    b.inr[s].push(this.inRange[s] ? 1 : 0);
    if (Number.isFinite(best)) { b.samples[s].push(best); b.tone[s][bt].push(best); }
  }
  // Turns a buffer into a CSV row, stores it, and returns [row, stat of the source slot].
  private saveBuf(b: Buf, kind: string, note: string): [Row, Stat] {
    const { S, srcSlot } = this;
    const stats = b.samples.slice(0, S.slots).map(stat);
    const st = stats[srcSlot];
    const inr = b.inr[srcSlot], inPct = inr.length ? Math.round(100 * inr.reduce((a, x) => a + x, 0) / inr.length) : '';
    // per-tone average while that tone was the one being received (shows multipath / dead tones)
    const tones = b.tone[srcSlot].slice(0, S.tones).map(a => f1(stat(a).avg)).join('/');
    const r: Row = { time: b.wall0, end_time: new Date().toISOString(), duration_s: r1((performance.now() - b.t0) / 1000), kind,
      my_slot: this.mySlot, src_slot: srcSlot, src_freq_hz: this.slotFreqs(srcSlot).join('/'), distance_m: this.dist, condition: this.cond,
      avg_db: r1(st.avg), min_db: r1(st.min), max_db: r1(st.max), samples: st.n, in_range_pct: inPct, tones_db: tones,
      mode: (!this.emitting ? 'silent' : this.pulsed ? 'pulsed' + S.pulseMs : 'cont') + (S.tones > 1 ? `-hop${S.tones}x${S.dwell}` : ''), fft: S.fft, note, device: shortUA,
      doppler_hz: S.doppler, all_slots_avg_db: stats.map((s, i) => `${i}:${f1(s.avg)}`).join(' ') };
    this.rows = [...this.rows, r]; store.set('rows', this.rows);
    return [r, st];
  }
  startRecord() {
    if (!this.analyser || this.rec) return;
    const b = newBuf();
    this.rec = { ...b, end: b.t0 + 3000 };
    this.recMsg = '';
    this.changed();
  }
  private finishRecord() {
    const b = this.rec!; this.rec = null;
    const [r, st] = this.saveBuf(b, 'fixed3s', this.note);
    this.recMsg = `Saved: S${r.src_slot} @ ${r.distance_m} m, ${r.condition} → avg ${f1(st.avg)} dB (min ${f1(st.min)}, max ${f1(st.max)}) · in range ${r.in_range_pct}% of the time`;
  }

  // ---------- interval recording: record continuously, cut labelled chunks ----------
  ivStart() {
    if (!this.analyser) { this.recMsg = 'Press START first.'; this.changed(); return; }
    this.ivl = newBuf(); this.ivCount = 0;
    this.changed();
  }
  ivCut(rawNote: string) {
    if (!this.ivl) return;
    const note = rawNote.trim() || `interval ${this.ivCount + 1}`;
    const [r, st] = this.saveBuf(this.ivl, 'interval', note);
    this.ivCount++; this.ivl = newBuf();
    this.recMsg = `Interval ${this.ivCount} saved (${r.duration_s} s, "${note}"): avg ${f1(st.avg)} dB, min ${f1(st.min)}, max ${f1(st.max)} · in range ${r.in_range_pct}%`;
    this.changed();
  }
  ivDrop() {
    if (!this.ivl) return;
    this.ivl = newBuf(); this.recMsg = 'Current interval discarded – recording a fresh one.';
    this.changed();
  }
  ivSecs() { return this.ivl ? (performance.now() - this.ivl.t0) / 1000 : 0; }
  ivSrcAvg() { return this.ivl ? stat(this.ivl.samples[this.srcSlot]).avg : NaN; }
  ivStop() {
    if (!this.ivl) return;
    this.ivl = null;
    this.recMsg = `Interval recording stopped – ${this.ivCount} interval(s) saved.`;
    this.changed();
  }

  clearRows() { this.rows = []; store.set('rows', this.rows); this.changed(); }
  setRecMsg(m: string) { this.recMsg = m; this.changed(); }
  toCSV() { return [COLS.join(',')].concat(this.rows.map(r => COLS.map(k => csvCell(r[k])).join(','))).join('\n') + '\n'; }
}

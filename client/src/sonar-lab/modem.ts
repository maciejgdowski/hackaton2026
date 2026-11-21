// Touch data link: short frames sent as tones while two phones are held speaker-to-mic.
//
// MFSK: 16 tones = 4 bits per symbol, 100 Hz apart, just below the slot tones (base − 2300 … base − 800 Hz).
// A frame starts with a sync tone (base − 600 Hz). The receiver finds where the sync tone ends and
// reads the symbols at fixed times after it (timing is in samples, so it doesn't drift).
//   frame = sync 150 ms + 12 symbols × 80 ms (5 payload bytes + CRC-8) ≈ 1.1 s
// Each symbol is read from its middle 40 ms only, so a ±20 ms timing error is harmless.

export const PAYLOAD_BYTES = 5;
const NSYM = (PAYLOAD_BYTES + 1) * 2;
const SYNC_S = 0.15, SYM_S = 0.08, EDGE_S = 0.02;
const WIN_S = 0.02, HOP_S = 0.01;         // sync search: 20 ms windows every 10 ms
const SYNC_MIN_WINDOWS = 6;               // sync must be seen for ≥ 60 ms
const SYNC_OVER_NOISE = 100;              // 20 dB (power ratio)
const SYNC_OVER_DATA = 10;                // 10 dB above the strongest data tone
const SYMBOL_OVER_NOISE = 31.6;           // 15 dB: weaker symbols drop the frame

const dataFreq = (base: number, n: number) => base - 2300 + n * 100;
const syncFreq = (base: number) => base - 600;
export const frameSeconds = SYNC_S + NSYM * SYM_S;

function crc8(b: number[]) {
  let c = 0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; }
  return c;
}

// Schedules one frame on osc/gain (frequency changes are sample-accurate and phase-continuous).
// Returns when it ends, in AudioContext time.
export function scheduleFrame(ctx: AudioContext, osc: OscillatorNode, gain: GainNode, base: number, payload: number[], level: number) {
  const bytes = [...payload, crc8(payload)];
  const f = osc.frequency, g = gain.gain, t = ctx.currentTime + 0.05;
  f.cancelScheduledValues(0); g.cancelScheduledValues(0);
  f.setValueAtTime(syncFreq(base), t);
  g.setValueAtTime(0, t); g.linearRampToValueAtTime(level, t + 0.005);
  let tt = t + SYNC_S;
  for (const b of bytes) for (const n of [b >> 4, b & 15]) { f.setValueAtTime(dataFreq(base, n), tt); tt += SYM_S; }
  g.setValueAtTime(level, tt - 0.005); g.linearRampToValueAtTime(0, tt);
  return tt;
}

const hannCache = new Map<number, Float32Array>();
function hann(n: number) {
  let w = hannCache.get(n);
  if (!w) { w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); hannCache.set(n, w); }
  return w;
}

// Raw mic samples -> frames. Runs on a ScriptProcessorNode (main thread, works on iOS Safari too).
export class DataRx {
  muteUntil = 0;                          // performance.now(): ignore the mic while we transmit ourselves
  private sr: number;
  private C: number;
  private ring: Float32Array;
  private w = 0;                          // samples written (absolute index)
  private h = 0;                          // start of the next sync-search window
  private present = 0;                    // consecutive windows with the sync tone
  private t0 = -1;                        // start of the data symbols while reading a frame

  constructor(ctx: AudioContext, src: AudioNode, private getBase: () => number, private onFrame: (payload: number[]) => void) {
    this.sr = ctx.sampleRate;
    this.C = Math.round(this.sr * 4);
    this.ring = new Float32Array(this.C);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    node.onaudioprocess = e => this.feed(e.inputBuffer.getChannelData(0));
    src.connect(node);
    const sink = ctx.createGain(); sink.gain.value = 0;   // must reach the destination or it never runs
    node.connect(sink); sink.connect(ctx.destination);
  }

  private feed(x: Float32Array) {
    for (let i = 0; i < x.length; i++) this.ring[(this.w + i) % this.C] = x[i];
    this.w += x.length;
    if (performance.now() < this.muteUntil || this.w - this.h > this.C / 2) { this.reset(); return; }
    this.process();
  }
  private reset() { this.h = this.w; this.present = 0; this.t0 = -1; }

  // Hann-windowed Goertzel power of one frequency over n samples starting at absolute index a.
  private power(a: number, n: number, f: number) {
    const w = hann(n), k = 2 * Math.cos(2 * Math.PI * f / this.sr);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = this.ring[(a + i) % this.C] * w[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - k * s1 * s2;
  }
  private dataPowers(a: number, n: number, base: number) {
    const p: number[] = [];
    for (let i = 0; i < 16; i++) p.push(this.power(a, n, dataFreq(base, i)));
    return p;
  }

  private process() {
    const sr = this.sr, base = this.getBase();
    const win = Math.round(sr * WIN_S), hop = Math.round(sr * HOP_S), sym = Math.round(sr * SYM_S), edge = Math.round(sr * EDGE_S);
    for (;;) {
      if (this.t0 < 0) {
        // hunt for the end of a sync tone
        if (this.h + win > this.w) return;
        const sync = this.power(this.h, win, syncFreq(base));
        const p = this.dataPowers(this.h, win, base).sort((a, b) => a - b);
        const on = sync > SYNC_OVER_NOISE * (p[7] + 1e-12) && sync > SYNC_OVER_DATA * p[15];
        if (on) this.present++;
        else {
          if (this.present >= SYNC_MIN_WINDOWS) this.t0 = this.h + Math.round(sr * 0.005);
          this.present = 0;
        }
        this.h += hop;
        continue;
      }
      // read the frame once all its samples are in
      const end = this.t0 + NSYM * sym;
      if (this.w < end) return;
      const nib: number[] = [];
      for (let k = 0; k < NSYM; k++) {
        const p = this.dataPowers(this.t0 + k * sym + edge, sym - 2 * edge, base);
        let best = 0; for (let i = 1; i < 16; i++) if (p[i] > p[best]) best = i;
        const median = [...p].sort((a, b) => a - b)[7];
        if (p[best] < SYMBOL_OVER_NOISE * (median + 1e-12)) break;
        nib.push(best);
      }
      this.t0 = -1; this.h = end;
      if (nib.length < NSYM) continue;
      const bytes: number[] = [];
      for (let i = 0; i < NSYM; i += 2) bytes.push(nib[i] << 4 | nib[i + 1]);
      const payload = bytes.slice(0, PAYLOAD_BYTES);
      if (crc8(payload) === bytes[PAYLOAD_BYTES]) this.onFrame(payload);
    }
  }
}

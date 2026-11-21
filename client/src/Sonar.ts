// Sonar: tells if another phone is within ~2 m.
// Every living player plays one high tone (their "slot"). The microphone listens for the
// other players' tones and measures how loud each one is above the background noise (in dB).
// Loud enough for long enough = close enough to kill.

export interface SonarConfig {
  base: number;
  spacing: number;
  slots: number;
}

export interface Proximity {
  near: boolean; // within ~2 m right now (or a short dropout)
  heldS: number; // seconds spent in range so far
  db: number; // 1 s average loudness above noise (NaN if unknown)
}

const KILL_DB = 25; // in range at 25 dB or more...
const LEAVE_DB = 20; // ...and out of range again below 20 dB
export const HOLD_S = 3.5; // seconds in range needed before the kill unlocks
const GRACE_S = 1.5; // dropouts shorter than this don't reset the charge
const DOPPLER_HZ = 100; // look ± this around each tone (walking changes the pitch a bit)
const NOISE_SPAN_HZ = 250; // background noise = median of ± this around the tone
const VOLUME = 0.5;

let config: SonarConfig = { base: 17800, spacing: 300, slots: 8 };
let mySlot = -1;
let ctx: AudioContext | null = null;
let oscillator: OscillatorNode | null = null;
let gain: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let spectrum = new Float32Array(0);
let emitting = false;
let listening = false;
let ready = false;
let lastTick = 0;

// One entry per slot
let history: { time: number; db: number }[][] = [];
let averageDb: number[] = [];
let inRange: boolean[] = [];
let heldS: number[] = [];
let lastInRangeAt: number[] = [];

function resetTracking() {
  history = [];
  averageDb = [];
  inRange = [];
  heldS = [];
  lastInRangeAt = [];
  for (let slot = 0; slot < 16; slot++) {
    history.push([]);
    averageDb.push(NaN);
    inRange.push(false);
    heldS.push(0);
    lastInRangeAt.push(-Infinity);
  }
}
resetTracking();

export function frequencyOf(slot: number) {
  return config.base + slot * config.spacing;
}

// ---------- measuring ----------

// -Infinity (digital silence) would break the math, so treat it as very quiet.
function safeDb(value: number) {
  return Number.isFinite(value) ? value : -200;
}

function noiseFloorDb(bin: number, binHz: number) {
  const span = Math.round(NOISE_SPAN_HZ / binHz);
  const values: number[] = [];
  for (let i = Math.max(0, bin - span); i <= Math.min(spectrum.length - 1, bin + span); i++) {
    values.push(safeDb(spectrum[i]));
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

// How loud one tone is above the noise around it.
function toneDb(frequency: number, binHz: number) {
  const bin = Math.round(frequency / binHz);
  const width = Math.max(1, Math.round(DOPPLER_HZ / binHz));
  if (bin + width >= spectrum.length) return NaN;

  let peak = -Infinity;
  for (let i = bin - width; i <= bin + width; i++) {
    peak = Math.max(peak, safeDb(spectrum[i]));
  }
  return peak - noiseFloorDb(bin, binHz);
}

// Runs 10 times a second.
function tick() {
  if (!analyser || !ctx) return;
  if (!listening) {
    lastTick = 0;
    return;
  }

  analyser.getFloatFrequencyData(spectrum);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const now = performance.now();
  const seconds = lastTick ? Math.min(0.5, (now - lastTick) / 1000) : 0;
  lastTick = now;

  for (let slot = 0; slot < config.slots; slot++) {
    if (slot === mySlot) continue;

    // average over the last second
    const samples = history[slot];
    samples.push({ time: now, db: toneDb(frequencyOf(slot), binHz) });
    while (samples.length > 0 && now - samples[0].time > 1000) samples.shift();

    let sum = 0;
    let count = 0;
    for (const sample of samples) {
      if (Number.isFinite(sample.db)) {
        sum += sample.db;
        count++;
      }
    }
    averageDb[slot] = count > 0 ? sum / count : NaN;

    // in range? (harder to get in than to stay in, so it doesn't flicker)
    const threshold = inRange[slot] ? LEAVE_DB : KILL_DB;
    inRange[slot] = Number.isFinite(averageDb[slot]) && averageDb[slot] >= threshold;

    if (inRange[slot]) {
      heldS[slot] += seconds;
      lastInRangeAt[slot] = now;
    } else if (now - lastInRangeAt[slot] >= GRACE_S * 1000) {
      heldS[slot] = 0;
    }
  }
}

// ---------- sound ----------

function fadeTo(volume: number) {
  if (!gain || !ctx) return;
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.18);
}

function resumeAudio() {
  if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
}

// iOS pauses audio sometimes: any tap, or coming back to the app, resumes it.
document.addEventListener("pointerdown", resumeAudio);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") resumeAudio();
});

// Must be called from a button tap: phones only allow sound and the mic after a tap.
export async function startSonar() {
  if (ready) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone needs HTTPS in Safari or Chrome (not an in-app browser).");
  }

  // iPhone: play and record at the same time
  const audioSession = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
  try {
    if (audioSession) audioSession.type = "play-and-record";
  } catch {
    // not supported
  }

  const audio = new AudioContext();
  ctx = audio;
  resumeAudio(); // not awaited: the tap must still count for getUserMedia

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    resumeAudio();

    // microphone -> analyser (never to the speaker)
    analyser = audio.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.3;
    spectrum = new Float32Array(analyser.frequencyBinCount);
    audio.createMediaStreamSource(stream).connect(analyser);

    // our own tone -> volume (starts silent) -> speaker
    oscillator = audio.createOscillator();
    oscillator.type = "sine";
    if (mySlot >= 0) oscillator.frequency.value = frequencyOf(mySlot);
    gain = audio.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start();

    setInterval(tick, 100);
    ready = true;
    if (emitting) fadeTo(VOLUME);
  } catch (error) {
    audio.close().catch(() => {});
    ctx = null;
    if (error instanceof DOMException && error.name === "NotAllowedError") {
      throw new Error("Microphone permission denied. Allow it in the browser settings and reload.");
    }
    throw error;
  }
}

export function isSonarReady() {
  return ready;
}

// From the server: the frequency plan and which slot is mine.
export function configureSonar(newConfig: SonarConfig, slot: number) {
  config = newConfig;
  if (slot === mySlot) return;
  mySlot = slot;
  if (oscillator && ctx) oscillator.frequency.setValueAtTime(frequencyOf(slot), ctx.currentTime);
}

export function setEmitting(on: boolean) {
  if (on === emitting) return;
  emitting = on;
  fadeTo(on ? VOLUME : 0);
}

// Off = ignore the mic and forget everything (nobody is close on GPS).
export function setListening(on: boolean) {
  if (on === listening) return;
  listening = on;
  if (!on) resetTracking();
}

export function getProximity(slot: number): Proximity {
  const near = inRange[slot] || performance.now() - lastInRangeAt[slot] < GRACE_S * 1000;
  return { near, heldS: near ? heldS[slot] : 0, db: averageDb[slot] };
}

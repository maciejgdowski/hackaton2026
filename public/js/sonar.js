// Sonar: near-ultrasonic proximity (~2 m) between phones.
//
// Every living player plays one sine tone at their slot frequency. The phone listens with the mic
// and measures each other slot's tone above the local noise floor (signal-to-noise ratio, dB):
//   - "in range" when the 1 s average is ≥ KILL_DB, and stays in range until it drops below KILL_DB − HYSTERESIS
//   - the kill charge grows only while in range; gaps shorter than GRACE_S pause it, longer gaps reset it
//
// URL overrides for field testing: ?db=NN (threshold), ?debug=1 (readout in game).

const params = new URLSearchParams(location.search);
const dbOverride = parseFloat(params.get('db'));

// 25 dB in / 20 dB out, tuned with tools/sonar-lab recordings
// (27 dB let a 5–6 m kill through; 32 dB was too strict).
const KILL_DB = Number.isFinite(dbOverride) ? dbOverride : 25;
const HYSTERESIS_DB = 5;
const HOLD_S = 3.5;        // time in range needed to kill
const GRACE_S = 1.5;       // dropouts shorter than this don't reset the charge
const DOPPLER_HZ = 100;    // search ± this around each tone (walking Doppler shift)
const NOISE_SPAN_HZ = 250; // noise floor = median of ± this around the tone
const FFT_SIZE = 8192;
const VOLUME = 0.5;
const FADE_S = 0.18;
const TICK_MS = 100;
const MAX_SLOTS = 16;

let config = { base: 17_800, spacing: 300, slots: 8 };
let ctx = null, oscillator = null, gain = null, analyser = null, spectrum = null, wakeLock = null;
let mySlot = -1, emitting = false, listening = true, ready = false, lastTick = 0;

// Per-slot tracking
let history, averageDb, inRange, heldS, lastInRangeAt;
function resetTracking() {
  history = Array.from({ length: MAX_SLOTS }, () => []);
  averageDb = new Array(MAX_SLOTS).fill(NaN);
  inRange = new Array(MAX_SLOTS).fill(false);
  heldS = new Array(MAX_SLOTS).fill(0);
  lastInRangeAt = new Array(MAX_SLOTS).fill(-Infinity);
}
resetTracking();

const frequencyOf = slot => config.base + slot * config.spacing;
const finiteDb = v => (Number.isFinite(v) ? v : -200);

// ---------- signal analysis ----------

const scratch = new Float32Array(1024);
function noiseFloorDb(bin, binHz) {
  const span = Math.min(500, Math.round(NOISE_SPAN_HZ / binHz));
  let count = 0;
  for (let j = Math.max(0, bin - span); j <= Math.min(spectrum.length - 1, bin + span); j++) scratch[count++] = finiteDb(spectrum[j]);
  return count ? scratch.subarray(0, count).sort()[count >> 1] : NaN;
}

function toneSnrDb(frequency, binHz) {
  const bin = Math.round(frequency / binHz);
  const width = Math.max(1, Math.round(DOPPLER_HZ / binHz));
  if (bin + width >= spectrum.length) return NaN;
  let peak = -Infinity;
  for (let j = bin - width; j <= bin + width; j++) peak = Math.max(peak, finiteDb(spectrum[j]));
  return peak - noiseFloorDb(bin, binHz);
}

function tick() {
  if (!analyser) return;
  if (!listening) { lastTick = 0; return; }

  analyser.getFloatFrequencyData(spectrum);
  const binHz = ctx.sampleRate / analyser.fftSize;
  const now = performance.now();
  const dt = lastTick ? Math.min(0.5, (now - lastTick) / 1000) : 0;
  lastTick = now;

  for (let slot = 0; slot < config.slots; slot++) {
    if (slot === mySlot) continue;

    // 1 s moving average of the SNR
    const samples = history[slot];
    samples.push({ t: now, db: toneSnrDb(frequencyOf(slot), binHz) });
    while (samples.length && now - samples[0].t > 1000) samples.shift();
    const valid = samples.filter(s => Number.isFinite(s.db));
    averageDb[slot] = valid.length ? valid.reduce((sum, s) => sum + s.db, 0) / valid.length : NaN;

    // In range with hysteresis (no flicker at the edge)
    const threshold = inRange[slot] ? KILL_DB - HYSTERESIS_DB : KILL_DB;
    inRange[slot] = Number.isFinite(averageDb[slot]) && averageDb[slot] >= threshold;

    if (inRange[slot]) {
      heldS[slot] += dt;
      lastInRangeAt[slot] = now;
    } else if (now - lastInRangeAt[slot] >= GRACE_S * 1000) {
      heldS[slot] = 0;
    }
  }
}

// ---------- audio ----------

function fadeTo(volume) {
  if (!gain) return;
  const t = ctx.currentTime;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.linearRampToValueAtTime(volume, t + FADE_S);
}

async function keepScreenOn() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    wakeLock = null;
  }
}

function resumeAudio() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

function explainMicError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
    return new Error('Microphone permission denied. Allow it in the browser settings and reload.');
  if (error?.name === 'NotReadableError')
    return new Error('Microphone is busy (call or another app). Close it and try again.');
  return error;
}

// Must be called from a tap: iOS only allows audio and the mic after a user gesture.
async function start() {
  if (ready) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new Error('Microphone needs HTTPS in Safari or Chrome (not an in-app browser).');
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* not supported */ }

  ctx = new (window.AudioContext || window.webkitAudioContext)();
  resumeAudio(); // not awaited: the tap must still count as a gesture for getUserMedia

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    resumeAudio();

    // Mic → analyser (never to the speaker)
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.3;
    spectrum = new Float32Array(analyser.frequencyBinCount);
    ctx.createMediaStreamSource(stream).connect(analyser);

    // Our own tone → gain (starts silent) → speaker
    oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    if (mySlot >= 0) oscillator.frequency.value = frequencyOf(mySlot);
    gain = ctx.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start();

    setInterval(tick, TICK_MS);
    ready = true;
    keepScreenOn();
    if (emitting) fadeTo(VOLUME);
  } catch (error) {
    try { ctx.close(); } catch { /* already closed */ }
    ctx = null;
    throw explainMicError(error);
  }
}

// iOS may suspend audio: any tap, or coming back to the app, resumes it.
document.addEventListener('pointerdown', resumeAudio);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !ctx) return;
  resumeAudio();
  keepScreenOn();
});

export const Sonar = {
  KILL_DB,
  HOLD_S,
  debug: params.has('debug'),
  start,
  frequencyOf,

  get ready() { return ready; },

  // Server-provided frequency plan and this player's slot.
  configure(sonarConfig, slot) {
    if (sonarConfig) config = { ...config, ...sonarConfig };
    if (slot === mySlot) return;
    mySlot = slot;
    if (oscillator) oscillator.frequency.setValueAtTime(frequencyOf(slot), ctx.currentTime);
  },

  setEmitting(on) {
    if (on === emitting) return;
    emitting = on;
    fadeTo(on ? VOLUME : 0);
  },

  // Off = ignore the mic and forget all proximity (GPS says nobody is around).
  setListening(on) {
    if (on === listening) return;
    listening = on;
    if (!on) resetTracking();
  },

  // Proximity to one slot: near = within ~2 m (or a short dropout), heldS = seconds of kill charge.
  near(slot) {
    const near = inRange[slot] || performance.now() - lastInRangeAt[slot] < GRACE_S * 1000;
    return { near, heldS: near ? heldS[slot] : 0, db: averageDb[slot] };
  }
};

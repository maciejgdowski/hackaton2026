// Sonar: near-ultrasonic 2 m proximity between phones (ported from /sonar, same tuning).
// Every living player plays one sine tone at their slot frequency; the phone listens with the
// mic and measures each other slot's tone above the local noise floor (SNR, dB).
// Within 2 m = 1 s average ≥ KILL_DB; leave only below KILL_DB − HYST (no flicker).
// Dropouts shorter than GRACE_S don't reset the "held close" timer.
'use strict';
window.Sonar = (() => {
  const KILL_DB = 27, HYST = 5, GRACE_S = 1.5, HOLD_S = 3.5, DOPPLER_HZ = 100, FFT = 8192, VOLUME = 0.5, FADE = 0.18;
  let cfg = { base: 17800, spacing: 300, slots: 8 };
  let ctx = null, osc = null, gain = null, analyser = null, spec = null, micTrack = null, wakeLock = null, timer = null;
  let mySlot = -1, emitting = false, ready = false;
  const hist = [], avg1 = [], inRange = [], inSince = [], lastIn = [];
  const reset = () => { for (let s = 0; s < 16; s++) { hist[s] = []; avg1[s] = NaN; inRange[s] = false; inSince[s] = 0; lastIn[s] = -1e9; } };
  reset();

  const freq = s => cfg.base + s * cfg.spacing;
  const dbv = v => Number.isFinite(v) ? v : -200;
  const scratch = new Float32Array(1024);
  function noiseDb(k, binHz) {
    const r = Math.min(500, Math.round(250 / binHz)), n = spec.length;
    let c = 0;
    for (let j = Math.max(0, k - r); j <= Math.min(n - 1, k + r); j++) scratch[c++] = dbv(spec[j]);
    return c ? scratch.subarray(0, c).sort()[c >> 1] : NaN;
  }
  function toneSnr(f, binHz) {
    const n = spec.length, k = Math.round(f / binHz), w = Math.max(1, Math.round(DOPPLER_HZ / binHz));
    if (k + w >= n) return NaN;
    let peak = -Infinity;
    for (let j = k - w; j <= k + w; j++) peak = Math.max(peak, dbv(spec[j]));
    return peak - noiseDb(k, binHz);
  }

  function tick() {
    if (!analyser) return;
    analyser.getFloatFrequencyData(spec);
    const binHz = ctx.sampleRate / analyser.fftSize, now = performance.now();
    for (let s = 0; s < cfg.slots; s++) {
      if (s === mySlot) continue;
      const v = toneSnr(freq(s), binHz), h = hist[s];
      h.push({ t: now, v });
      while (h.length && now - h[0].t > 1000) h.shift();
      let sum = 0, c = 0;
      for (const p of h) if (Number.isFinite(p.v)) { sum += p.v; c++; }
      avg1[s] = c ? sum / c : NaN;
      const was = inRange[s];
      inRange[s] = Number.isFinite(avg1[s]) && (was ? avg1[s] >= KILL_DB - HYST : avg1[s] >= KILL_DB);
      if (inRange[s] && !was && now - lastIn[s] >= GRACE_S * 1000) inSince[s] = now;   // fresh approach, not a blip
      if (inRange[s]) lastIn[s] = now;
    }
  }

  function ramp(v) {
    if (!gain) return;
    const t = ctx.currentTime, g = gain.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + FADE);
  }

  async function requestWake() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    catch { wakeLock = null; }
  }

  // Must be called from a tap (iOS needs a user gesture for audio + mic).
  async function start() {
    if (ready) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone needs HTTPS in Safari or Chrome (not an in-app browser).');
    if (navigator.audioSession) { try { navigator.audioSession.type = 'play-and-record'; } catch { /* ignore */ } }
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    ctx.resume().catch(() => {});                       // don't await: keep the gesture for getUserMedia
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      micTrack = stream.getAudioTracks()[0];
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      analyser = ctx.createAnalyser(); analyser.fftSize = FFT; analyser.smoothingTimeConstant = 0.3;
      spec = new Float32Array(analyser.frequencyBinCount);
      ctx.createMediaStreamSource(stream).connect(analyser);      // never to the speaker
      osc = ctx.createOscillator(); osc.type = 'sine';
      gain = ctx.createGain(); gain.gain.value = 0;
      osc.connect(gain); gain.connect(ctx.destination); osc.start();
      if (mySlot >= 0) osc.frequency.value = freq(mySlot);
      timer = setInterval(tick, 100);
      ready = true;
      requestWake();
      if (emitting) ramp(VOLUME);
    } catch (e) {
      try { ctx.close(); } catch { /* ignore */ }
      ctx = null;
      if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw new Error('Microphone permission denied. Allow it in the browser settings and reload.');
      if (e?.name === 'NotReadableError') throw new Error('Microphone is busy (call or another app). Close it and try again.');
      throw e;
    }
  }

  // iOS may suspend audio; any tap or coming back to the tab resumes it.
  document.addEventListener('pointerdown', () => { if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {}); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !ctx) return;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    requestWake();
  });

  return {
    HOLD_S, GRACE_S,
    start,
    get ready() { return ready; },
    get running() { return !!ctx && ctx.state === 'running'; },
    configure(c, slot) {
      if (c) cfg = { ...cfg, ...c };
      if (slot !== mySlot) { mySlot = slot; if (osc) osc.frequency.setValueAtTime(freq(slot), ctx.currentTime); }
    },
    setEmitting(on) { if (on === emitting) return; emitting = on; ramp(on ? VOLUME : 0); },
    freq,
    // Proximity of one slot: near = within 2 m (or a short blip), held = seconds kept close.
    near(slot, now = performance.now()) {
      const near = inRange[slot] || now - lastIn[slot] < GRACE_S * 1000;
      return { near, blip: near && !inRange[slot], held: near ? (now - inSince[slot]) / 1000 : 0, db: avg1[slot] };
    },
    reset,
  };
})();

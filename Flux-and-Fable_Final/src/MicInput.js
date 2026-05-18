// MicInput.js — microphone analysis for Defect Choir
//
// CRITICAL FIX from v13:
//   v13 created its own AudioContext separate from Tone.js.
//   Chrome (and some browsers) silently suspend a second AudioContext that
//   wasn't activated in the same user gesture as the first — meaning mic
//   audio would route through a suspended context and produce zero signal.
//   Fix: we now accept an AudioContext from the caller (Tone.getContext().rawContext)
//   so everything shares one live context activated by the button click.
//
// Features extracted each frame via Web Audio AnalyserNode:
//   level      — RMS amplitude (0–1), adaptive noise-floor subtracted
//   brightness — spectral centroid proxy: weighted (high + mid) / total
//   roughness  — inter-frame spectral difference, measures texture/noise
//   flux       — positive spectral flux only (energy increases = onsets)
//   onset      — boolean: transient detected, 130ms cooldown
//   confidence — signal confidence above noise floor (0–1)
//
// References:
//   Bello et al. (2005). "A Tutorial on Onset Detection in Music Signals."
//     IEEE Transactions on Speech and Audio Processing, 13(5).
//   Web Audio API: https://www.w3.org/TR/webaudio/ (AnalyserNode spec)

export class MicInput {
  constructor() {
    this.audioContext = null; // injected from Tone.getContext().rawContext
    this.stream       = null;
    this.source       = null;
    this.analyser     = null;
    this.timeData     = null;
    this.freqData     = null;
    this.prevFreqData = null;
    this.isStarted    = false;

    // Noise floor: starts conservatively low, adapts slowly to room noise.
    // We use a FIXED lower bound so the floor can never completely swallow speech.
    this.noiseFloor    = 0.003;
    this.noiseFloorMax = 0.018; // hard ceiling — floor never rises above this

    this.smoothedLevel      = 0;
    this.smoothedBrightness = 0.5; // init at 0.5 so startup doesn't cause bias offset
    this.smoothedRoughness  = 0;
    this.smoothedFlux       = 0;
    this.lastOnsetAt        = 0;
    this.lastLevel          = 0;

    this.metrics = {
      level: 0, brightness: 0.5, roughness: 0,
      flux: 0, onset: false, confidence: 0,
    };
  }

  clamp(v, mn, mx) { return Math.min(mx, Math.max(mn, v)); }
  lerp(a, b, t)    { return a + (b - a) * t; }

  // ─── start(audioContext) ─────────────────────────────────────────────────
  // audioContext MUST be Tone.getContext().rawContext — sharing the live
  // context activated by the user gesture prevents silent suspension.

  async start(audioContext) {
    if (this.isStarted) return;

    if (!audioContext) {
      throw new Error('MicInput.start() requires an AudioContext argument. '
        + 'Pass Tone.getContext().rawContext after Tone.start().');
    }

    this.audioContext = audioContext;

    // Resume context if it was suspended (can happen after page visibility changes)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,  // OFF: we want raw acoustic signal, not processed
        noiseSuppression: false,  // OFF: noise floor adaptation handles this in JS
        autoGainControl:  false,  // OFF: we need consistent amplitude for level mapping
        channelCount:     1,
      },
      video: false,
    });

    this.source   = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();

    // fftSize 1024 = 512 frequency bins at 44100Hz → bin width ~43Hz
    // smoothingTimeConstant 0.6: lighter smoothing than v13 (was 0.72)
    // so the analyser responds faster to transients — better onset detection
    this.analyser.fftSize               = 1024;
    this.analyser.smoothingTimeConstant = 0.60;

    this.source.connect(this.analyser);
    // Note: analyser is NOT connected to audioContext.destination —
    // we only READ data from it, never play mic audio through speakers.

    this.timeData     = new Uint8Array(this.analyser.fftSize);
    this.freqData     = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevFreqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.isStarted = true;
  }

  stop() {
    if (!this.isStarted) return;

    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());

    // Do NOT close audioContext here — it's shared with Tone.js.
    // Disconnecting the source node is sufficient.
    if (this.source) {
      try { this.source.disconnect(); } catch (_) {}
    }

    this.stream       = null;
    this.source       = null;
    this.analyser     = null;
    this.timeData     = null;
    this.freqData     = null;
    this.prevFreqData = null;
    this.isStarted    = false;

    this.noiseFloor         = 0.003;
    this.smoothedLevel      = 0;
    this.smoothedBrightness = 0.5;
    this.smoothedRoughness  = 0;
    this.smoothedFlux       = 0;
    this.lastOnsetAt        = 0;
    this.lastLevel          = 0;

    this.metrics = {
      level: 0, brightness: 0.5, roughness: 0,
      flux: 0, onset: false, confidence: 0,
    };
  }

  // ─── update() — call once per animation frame ─────────────────────────────

  update(nowMs = performance.now()) {
    if (!this.isStarted || !this.analyser) return this.metrics;

    this.analyser.getByteTimeDomainData(this.timeData);
    this.analyser.getByteFrequencyData(this.freqData);

    // ── RMS amplitude ────────────────────────────────────────────────────
    // Byte time-domain data: 0–255, midpoint 128 = silence.
    // We centre and normalise to [-1, 1] then take the root-mean-square.
    let sumSq = 0;
    for (let i = 0; i < this.timeData.length; i++) {
      const c = (this.timeData[i] - 128) / 128;
      sumSq += c * c;
    }
    const rms = Math.sqrt(sumSq / this.timeData.length);

    // ── Adaptive noise floor with hard ceiling ────────────────────────────
    // The floor tracks ambient room noise slowly. The hard ceiling ensures
    // even in a noisy room, we never lose sensitivity to speech entirely.
    // Asymmetric: rises fast (0.04) when quiet, drops very slowly (0.001).
    if (rms < this.noiseFloor + 0.008) {
      this.noiseFloor = this.lerp(this.noiseFloor, Math.min(rms, this.noiseFloorMax), 0.04);
    } else {
      this.noiseFloor = this.lerp(this.noiseFloor, this.noiseFloor * 0.9, 0.001);
    }
    this.noiseFloor = this.clamp(this.noiseFloor, 0.001, this.noiseFloorMax);

    // ── Level mapping ────────────────────────────────────────────────────
    // usable: signal above noise floor
    // We map to [0,1] using a normaliser tuned for speech (rms ~0.01–0.08)
    // Power curve 0.5 (square root) expands small signals into audible range.
    const usable     = Math.max(0, rms - this.noiseFloor);
    const normalized = this.clamp(usable / 0.04, 0, 1); // 0.04 = typical speech peak
    const rawLevel   = Math.pow(normalized, 0.5);        // gentler curve than v13's 0.58

    // Fast attack (0.35), slower release (0.12) — matches how we hear loudness
    const lerpRate         = rawLevel > this.smoothedLevel ? 0.35 : 0.12;
    this.smoothedLevel     = this.lerp(this.smoothedLevel, rawLevel, lerpRate);

    // ── Spectral feature extraction ──────────────────────────────────────
    // Divide spectrum into low/mid/high bands (speech: 80Hz–8kHz spans all three)
    // At fftSize=1024, sampleRate≈44100: each bin ≈ 43Hz
    //   lowEnd bin  ~0.18 * 512 ≈ bin 92  → ~4kHz  (lows: 0–4kHz)
    //   midEnd bin  ~0.52 * 512 ≈ bin 266 → ~11kHz (mids: 4–11kHz)
    //   high: 11kHz–22kHz
    let total   = 0;
    let lowSum  = 0;
    let midSum  = 0;
    let highSum = 0;
    let fluxSum = 0;
    let diffSum = 0;

    const binCount = this.freqData.length;   // 512
    const lowEnd   = Math.floor(binCount * 0.18);
    const midEnd   = Math.floor(binCount * 0.52);

    for (let i = 0; i < binCount; i++) {
      const mag  = this.freqData[i] / 255;
      const prev = this.prevFreqData[i] / 255;
      total += mag;

      if (i < lowEnd)       lowSum  += mag;
      else if (i < midEnd)  midSum  += mag;
      else                  highSum += mag;

      fluxSum += Math.max(0, mag - prev); // positive flux = energy increases only
      diffSum += Math.abs(mag - prev);    // total flux = roughness/texture

      this.prevFreqData[i] = this.freqData[i];
    }

    // brightness: high-frequency emphasis weighted by total energy
    // High in bright/fricative speech, low in low-frequency hum
    const rawBrightness = total > 0.001
      ? this.clamp((highSum + midSum * 0.42) / total, 0, 1)
      : 0.5; // default to centre when silent — prevents startup bias jump

    // flux: normalised onset energy (attacks, transients)
    const rawFlux      = this.clamp(fluxSum * 2.0, 0, 1);

    // roughness: overall spectral instability — noise > tones > silence
    const rawRoughness = this.clamp((diffSum / binCount) * 5.0, 0, 1);

    // Smooth all features with different time constants
    this.smoothedBrightness = this.lerp(this.smoothedBrightness, rawBrightness, 0.10);
    this.smoothedFlux       = this.lerp(this.smoothedFlux,       rawFlux,       0.25);
    this.smoothedRoughness  = this.lerp(this.smoothedRoughness,  rawRoughness,  0.15);

    // ── Onset detection ───────────────────────────────────────────────────
    // Onset = sudden level increase OR high spectral flux, with cooldown.
    // Lowered threshold from v13 (0.05 → 0.03) so softer sounds register.
    const deltaLevel      = this.smoothedLevel - this.lastLevel;
    const onsetCooldownMs = 130;
    const onset = this.smoothedLevel > 0.03
      && (deltaLevel > 0.012 || this.smoothedFlux > 0.06)
      && nowMs - this.lastOnsetAt > onsetCooldownMs;

    if (onset) this.lastOnsetAt = nowMs;
    this.lastLevel = this.smoothedLevel;

    this.metrics = {
      level:      this.smoothedLevel,
      brightness: this.smoothedBrightness,
      roughness:  this.smoothedRoughness,
      flux:       this.smoothedFlux,
      onset,
      confidence: this.clamp(usable / 0.01, 0, 1),
    };

    return this.metrics;
  }

  getMetrics() { return this.metrics; }
  dispose()    { this.stop(); }
}

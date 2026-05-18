// ToneDrone.js — three-bus audio engine for Defect Choir
//
// Architecture:
//   output bus   — continuous FM drone (Tone.FMSynth) tracking field order
//   eventBus     — polyphonic ambient events triggered by SpinField events
//   gestureBus   — real-time gesture lead + pulse synth responding to pointer/mic
//
// Signal chain:
//   FMSynth → EQ3 → Vibrato → PingPongDelay → Freeverb → Distortion → output → Limiter
//   PolySynth(FM) → eventFilter → eventDelay → eventReverb → eventBus → Limiter
//   MonoSynth → gestureFilter → gestureDelay → gestureReverb → gestureBus → Limiter

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pick(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class ToneDrone {
  constructor() {
    this.baseNote = 'C2';
    this.isStarted = false;
    this.lastGesturePulseAt = 0;
    this.gestureLeadActive = false;

    this.ambientEventBusRangeDb = { min: -15, max: -7 };
    this.ambientVelocityRange = { min: 0.24, max: 0.5 };
    this.ambientNoiseVolumeRangeDb = { min: -22, max: -13 };
    this.gestureBusRangeDb = { min: -17, max: -8 };
    this.gestureVelocityRange = { min: 0.18, max: 0.56 };
    this.gestureNoiseRangeDb = { min: -22, max: -12 };

    this._buildGraph();

    this.scaleSets = {
      fault:   [['C3','G3','D4'],['Bb2','F3','C4'],['D3','A3','E4']],
      shear:   [['C3','Eb3','G3'],['D3','F3','A3'],['G2','C3','D4']],
      plume:   [['C4','G4','D5'],['F3','C4','G4'],['Eb3','Bb3','F4']],
      ribbon:  [['C3','G3','Bb3'],['D3','A3','C4'],['F3','C4','D4']],
      lattice: [['C3','Eb3','Bb3'],['D3','G3','C4'],['A2','E3','B3']],
      veil:    [['C4','Eb4','G4'],['D4','A4','C5'],['F3','A3','C4']],
      gesture: [['C4','D4','G4'],['D4','F4','A4'],['G3','C4','D4'],['A3','C4','E4']],
    };
  }

  _buildGraph() {
    this.output   = new Tone.Volume(-18);
    this.limiter  = new Tone.Limiter(-1).toDestination();
    this.output.connect(this.limiter);

    this.eq        = new Tone.EQ3(-2, 0, 1.5);
    this.vibrato   = new Tone.Vibrato({ maxDelay:0.006, frequency:2.2, depth:0.08, wet:1 });
    this.delay     = new Tone.PingPongDelay({ delayTime:'8n', feedback:0.16, wet:0.12 });
    this.freeverb  = new Tone.Freeverb({ roomSize:0.82, dampening:2800 });
    this.freeverb.wet.value = 0.18;
    this.distortion = new Tone.Distortion({ distortion:0.05, wet:0.08 });

    // Continuous FM drone — pitch tracks field order parameter
    this.synth = new Tone.FMSynth({
      harmonicity:1.15, modulationIndex:7.4,
      oscillator:{ type:'sine' }, modulation:{ type:'sine' },
      envelope:{ attack:1.1, decay:0.2, sustain:1, release:2.8 },
      modulationEnvelope:{ attack:1.1, decay:0.4, sustain:0.9, release:2.4 },
    });

    this.synth.connect(this.eq);
    this.eq.connect(this.vibrato);
    this.vibrato.connect(this.delay);
    this.delay.connect(this.freeverb);
    this.freeverb.connect(this.distortion);
    this.distortion.connect(this.output);
    this.eq.connect(this.output);
    this.output.volume.value = -Infinity;

    // Event bus — polyphonic ambient chords
    this.eventBus    = new Tone.Volume(this.ambientEventBusRangeDb.min - 4);
    this.eventBus.connect(this.limiter);
    this.eventFilter = new Tone.Filter({ type:'lowpass', frequency:1800, rolloff:-24, Q:0.8 });
    this.eventReverb = new Tone.Reverb({ decay:5.4, wet:0.46, preDelay:0.02 });
    this.eventDelay  = new Tone.FeedbackDelay({ delayTime:'8n', feedback:0.22, wet:0.18 });

    this.eventSynth = new Tone.PolySynth(Tone.FMSynth, {
      oscillator:{ type:'triangle' }, modulation:{ type:'sine' },
      harmonicity:1.45, modulationIndex:5.8,
      envelope:{ attack:0.14, decay:0.4, sustain:0.2, release:3.6 },
      modulationEnvelope:{ attack:0.12, decay:0.5, sustain:0.18, release:3.2 },
      volume:-1,
    });

    this.textureNoise = new Tone.NoiseSynth({
      noise:{ type:'pink' },
      envelope:{ attack:0.02, decay:1.1, sustain:0, release:0.1 },
      volume:this.ambientNoiseVolumeRangeDb.min,
    });
    this.noiseFilter = new Tone.Filter({ type:'bandpass', frequency:1050, Q:1.1 });

    this.eventSynth.connect(this.eventFilter);
    this.eventFilter.connect(this.eventDelay);
    this.eventDelay.connect(this.eventReverb);
    this.eventReverb.connect(this.eventBus);
    this.eventFilter.connect(this.eventBus);
    this.textureNoise.connect(this.noiseFilter);
    this.noiseFilter.connect(this.eventReverb);

    // Gesture bus — monophonic lead + pulse synth
    this.gestureBus    = new Tone.Volume(this.gestureBusRangeDb.min - 6);
    this.gestureBus.connect(this.limiter);
    this.gestureFilter = new Tone.Filter({ type:'bandpass', frequency:1400, Q:1.3 });
    this.gestureDelay  = new Tone.FeedbackDelay({ delayTime:0.14, feedback:0.18, wet:0.16 });
    this.gestureReverb = new Tone.Reverb({ decay:2.8, wet:0.24, preDelay:0.01 });

    this.gestureSynth = new Tone.PolySynth(Tone.Synth, {
      oscillator:{ type:'triangle' },
      envelope:{ attack:0.018, decay:0.28, sustain:0.08, release:0.85 },
      volume:-2,
    });

    // MonoSynth with portamento for smooth pitch glide during drag
    this.gestureLead = new Tone.MonoSynth({
      oscillator:{ type:'triangle' },
      filter:{ Q:1.2, type:'lowpass', rolloff:-24 },
      envelope:{ attack:0.04, decay:0.18, sustain:0.42, release:0.38 },
      filterEnvelope:{ attack:0.02, decay:0.24, sustain:0.45, release:0.3, baseFrequency:260, octaves:2.2 },
      portamento:0.08, volume:-8,
    });

    this.gestureNoise = new Tone.NoiseSynth({
      noise:{ type:'white' },
      envelope:{ attack:0.004, decay:0.14, sustain:0, release:0.05 },
      volume:this.gestureNoiseRangeDb.min,
    });
    this.gestureNoiseFilter = new Tone.Filter({ type:'highpass', frequency:1400, Q:0.9 });

    this.gestureSynth.connect(this.gestureFilter);
    this.gestureLead.connect(this.gestureFilter);
    this.gestureFilter.connect(this.gestureDelay);
    this.gestureDelay.connect(this.gestureReverb);
    this.gestureReverb.connect(this.gestureBus);
    this.gestureFilter.connect(this.gestureBus);
    this.gestureNoise.connect(this.gestureNoiseFilter);
    this.gestureNoiseFilter.connect(this.gestureReverb);
  }

  async start() {
    if (this.isStarted) return;
    await Tone.start();
    this.output.volume.rampTo(-9, 0.9);
    this.eventBus.volume.rampTo(this.ambientEventBusRangeDb.min, 0.9);
    this.gestureBus.volume.rampTo(this.gestureBusRangeDb.min, 0.9);
    this.synth.triggerAttack(this.baseNote);
    this.isStarted = true;
  }

  stop() {
    if (!this.isStarted) return;
    this.output.volume.rampTo(-Infinity, 0.4);
    this.eventBus.volume.rampTo(-Infinity, 0.4);
    this.gestureBus.volume.rampTo(-Infinity, 0.4);
    this.synth.triggerRelease('+0.1');
    this.endGesture();
    // FIX: cancel all pending transport automation to prevent scheduled
    // rampTo() callbacks accumulating across repeated start()/stop() cycles.
    // Without this, the AudioContext automation timeline grows unbounded
    // and causes parameter drift / glitches after several toggles.
    Tone.getTransport().cancel();
    this.isStarted = false;
  }

  update(params, metrics) {
    const couplingAmount = Math.abs(params.coupling);
    const biasAmount     = Math.abs(params.bias);
    const tempAmount     = params.temperature;
    const colorAmount    = params.colorShift;
    const defectAmount   = clamp(metrics.defectMean * 1.25, 0, 1);

    // FM timbre: coupling → harmonicity, activity → modulation index
    const harmonicity    = 0.78 + couplingAmount * 3.4 + metrics.order * 0.9;
    const modulationIndex = 4 + biasAmount * 12 + metrics.activity * 12 + defectAmount * 10;

    const vibratoDepth = clamp(0.04 + couplingAmount * 0.14 + metrics.activity * 0.18, 0.04, 0.42);
    const vibratoRate  = 1.2 + biasAmount * 4 + metrics.order * 2.8 + defectAmount * 1.6;
    const distortion   = clamp(0.03 + tempAmount * 0.32 + defectAmount * 0.16, 0.03, 0.68);
    const delayWet     = clamp(0.08 + colorAmount * 0.18 + defectAmount * 0.08, 0.08, 0.34);
    const reverbWet    = clamp(0.12 + couplingAmount * 0.08 + colorAmount * 0.12, 0.12, 0.38);

    // Drone pitch: field order parameter → semitone offset from C2
    const semitoneOffset  = Math.round((metrics.order - 0.5) * 6 + params.bias * 3 + defectAmount * 2);
    const targetFrequency = Tone.Frequency(this.baseNote).transpose(semitoneOffset).toFrequency();

    this.synth.frequency.rampTo(targetFrequency, 0.35);
    this.synth.harmonicity.rampTo(harmonicity, 0.22);
    this.synth.modulationIndex.rampTo(modulationIndex, 0.22);
    this.vibrato.depth.rampTo(vibratoDepth, 0.24);
    this.vibrato.frequency.rampTo(vibratoRate, 0.24);
    this.delay.wet.rampTo(delayWet, 0.3);
    this.freeverb.wet.rampTo(reverbWet, 0.34);
    this.distortion.distortion = distortion;
    this.distortion.wet.value  = clamp(0.06 + tempAmount * 0.14 + defectAmount * 0.08, 0.06, 0.26);
    this.eq.low.value  = -4 + (1 - metrics.activity) * 4;
    this.eq.high.value = -2 + colorAmount * 4 + defectAmount * 3;
    this.eventFilter.frequency.rampTo(1100 + defectAmount * 2400 + colorAmount * 500, 0.25);
    this.eventDelay.wet.rampTo(0.12 + defectAmount * 0.16, 0.3);
  }

  gestureLeadTarget(metrics, gesture = {}) {
    const speed    = clamp(gesture.speed    ?? 0,   0, 1.35);
    const curvature = clamp(gesture.curvature ?? 0,  0, 1);
    const xNorm    = clamp(gesture.xNorm    ?? 0.5, 0, 1);
    const yNorm    = clamp(gesture.yNorm    ?? 0.5, 0, 1);
    const force    = clamp(gesture.force    ?? 0.8, 0.2, 1.4);
    const semitone = Math.round(
      (xNorm - 0.5) * 7 + (0.5 - yNorm) * 4 + (metrics.order - 0.5) * 5
      + speed * 3 + curvature * 4 + force * 1.5
    );
    return Tone.Frequency('C3').transpose(semitone).toFrequency();
  }

  beginGesture(metrics, gesture = {}) {
    if (!this.isStarted || this.gestureLeadActive) return;
    const freq = this.gestureLeadTarget(metrics, gesture);
    this.gestureBus.volume.rampTo(this.gestureBusRangeDb.min + 1.5, 0.08);
    this.gestureLead.triggerAttack(freq, Tone.now(), 0.34);
    this.gestureLeadActive = true;
  }

  updateGestureDrag(metrics, gesture = {}) {
    if (!this.isStarted) return;
    if (!this.gestureLeadActive) { this.beginGesture(metrics, gesture); }

    const speed    = clamp(gesture.speed    ?? 0,   0, 1.35);
    const curvature = clamp(gesture.curvature ?? 0,  0, 1);
    const xNorm    = clamp(gesture.xNorm    ?? 0.5, 0, 1);
    const yNorm    = clamp(gesture.yNorm    ?? 0.5, 0, 1);
    const force    = clamp(gesture.force    ?? 0.8, 0.2, 1.4);

    const loudnessT = clamp(speed * 0.62 + curvature * 0.26 + force * 0.18, 0, 1);
    const freq      = this.gestureLeadTarget(metrics, gesture);
    const detune    = lerp(-8, 14, clamp(curvature * 0.9 + (xNorm - 0.5) * 0.5 + 0.5, 0, 1));
    const busDb     = lerp(this.gestureBusRangeDb.min, this.gestureBusRangeDb.max, loudnessT) - 1.2;
    const filterHz  = 900 + xNorm * 2000 + speed * 1200 + curvature * 900;

    this.gestureBus.volume.rampTo(busDb, 0.04);
    this.gestureLead.frequency.rampTo(freq, 0.05);
    this.gestureLead.detune.rampTo(detune, 0.05);
    this.gestureFilter.frequency.rampTo(filterHz, 0.05);
    this.gestureDelay.wet.rampTo(0.1 + speed * 0.1 + curvature * 0.06, 0.06);
    this.gestureReverb.wet.rampTo(0.12 + yNorm * 0.08 + curvature * 0.07, 0.08);
  }

  endGesture() {
    if (!this.gestureLeadActive) return;
    this.gestureLead.triggerRelease('+0.02');
    this.gestureBus.volume.rampTo(this.gestureBusRangeDb.min - 3, 0.18);
    this.gestureLeadActive = false;
  }

  buildAmbientNoteLayers(kind, secondaryKind, metrics, xNorm, duringInteraction) {
    const transpose      = Math.round((metrics.order - 0.5) * 4 + (xNorm - 0.5) * 6);
    const primaryCluster = pick(this.scaleSets[kind] || this.scaleSets.plume);
    const primaryNotes   = primaryCluster.map((n) => Tone.Frequency(n).transpose(transpose).toNote());

    let overlayNotes = [];
    if (secondaryKind) {
      const sc = pick(this.scaleSets[secondaryKind] || this.scaleSets.plume);
      overlayNotes = sc.slice(0, 2).map((n) => Tone.Frequency(n).transpose(transpose - 1).toNote());
    }
    if (duringInteraction) {
      overlayNotes = [Tone.Frequency(primaryCluster[0]).transpose(transpose - 12).toNote(), ...overlayNotes];
    }
    return {
      primaryNotes,
      overlayNotes: [...new Set(overlayNotes)].filter((n) => !primaryNotes.includes(n)),
    };
  }

  triggerAmbientEvent(event, metrics, options = {}) {
    if (!this.isStarted) return;
    const duringInteraction = Boolean(options.duringInteraction);
    const kind              = event.kind || 'plume';
    const secondaryKind     = event.secondaryKind || null;
    const { primaryNotes, overlayNotes } = this.buildAmbientNoteLayers(
      kind, secondaryKind, metrics, event.xNorm ?? 0.5, duringInteraction,
    );

    const intensity       = clamp(event.intensity || 1, 0.5, 1.8);
    const interactionBoost = duringInteraction ? 0.18 : 0;
    const loudnessT       = clamp(0.34 + intensity * 0.34 + metrics.defectMean * 0.22
      + interactionBoost + (Math.random() - 0.5) * 0.12, 0, 1);
    const velocity = lerp(this.ambientVelocityRange.min, this.ambientVelocityRange.max, loudnessT);
    const duration = 1.9 + intensity * 1.9 + (duringInteraction ? 0.35 : 0);
    const busDb    = lerp(this.ambientEventBusRangeDb.min, this.ambientEventBusRangeDb.max, loudnessT)
      + (duringInteraction ? 2.4 : 0);
    const noiseDb  = lerp(this.ambientNoiseVolumeRangeDb.min, this.ambientNoiseVolumeRangeDb.max, loudnessT)
      + (duringInteraction ? 2.0 : 0);

    this.eventSynth.set({
      harmonicity:     1.12 + intensity * 0.82 + metrics.defectMean * 0.8 + (duringInteraction ? 0.18 : 0),
      modulationIndex: 4    + intensity * 4.2  + metrics.activity   * 4   + (duringInteraction ? 1.1  : 0),
    });

    const filterTarget = 900 + (event.yNorm ?? 0.5) * 2600 + metrics.defectMean * 1200 + (duringInteraction ? 260 : 0);
    this.eventFilter.frequency.rampTo(filterTarget, 0.18);
    this.eventReverb.wet.rampTo(clamp(0.34 + intensity * 0.12 + (duringInteraction ? 0.06 : 0), 0.34, 0.66), 0.3);
    this.eventDelay.wet.rampTo(clamp(0.16 + intensity * 0.05 + (duringInteraction ? 0.04 : 0), 0.14, 0.34), 0.18);
    this.eventBus.volume.rampTo(busDb, 0.08);
    this.eventSynth.triggerAttackRelease(primaryNotes, duration, undefined, velocity);

    if (overlayNotes.length > 0) {
      this.eventSynth.triggerAttackRelease(
        overlayNotes, Math.max(0.7, duration * 0.78), Tone.now() + 0.06,
        clamp(velocity * 0.82, 0.18, 0.85),
      );
    }

    if (duringInteraction || kind !== 'shear' || intensity > 1.1 || secondaryKind) {
      this.textureNoise.volume.value = noiseDb;
      this.noiseFilter.frequency.rampTo(820 + intensity * 1080 + (duringInteraction ? 280 : 0), 0.12);
      this.textureNoise.triggerAttackRelease(duringInteraction ? '1.1' : '0.9');
    }
  }

  triggerGesturePulse(metrics, gesture = {}) {
    if (!this.isStarted) return;
    const speed    = clamp(gesture.speed    ?? 0.2, 0, 1.35);
    const curvature = clamp(gesture.curvature ?? 0,  0, 1);
    const xNorm    = clamp(gesture.xNorm    ?? 0.5, 0, 1);
    const yNorm    = clamp(gesture.yNorm    ?? 0.5, 0, 1);
    const force    = clamp(gesture.force    ?? 0.7, 0.2, 1.4);

    const now      = Tone.now();
    const cooldown = speed > 0.85 ? 0.065 : speed > 0.45 ? 0.092 : 0.12;
    if (now - this.lastGesturePulseAt < cooldown) return;
    this.lastGesturePulseAt = now;

    const clusterIndex = Math.min(
      this.scaleSets.gesture.length - 1,
      Math.floor(clamp(curvature * 0.65 + xNorm * 0.35, 0, 0.999) * this.scaleSets.gesture.length),
    );
    const cluster   = this.scaleSets.gesture[clusterIndex];
    const transpose = Math.round((metrics.order - 0.5) * 3 + (xNorm - 0.5) * 4 + curvature * 3);
    const notes     = cluster.map((n) => Tone.Frequency(n).transpose(transpose).toNote());
    const loudnessT = clamp(speed * 0.64 + force * 0.2 + metrics.activity * 0.14 + curvature * 0.22, 0, 1);
    const velocity  = lerp(this.gestureVelocityRange.min, this.gestureVelocityRange.max, loudnessT);
    const busDb     = lerp(this.gestureBusRangeDb.min, this.gestureBusRangeDb.max, loudnessT);
    const noiseDb   = lerp(this.gestureNoiseRangeDb.min, this.gestureNoiseRangeDb.max, loudnessT);
    const duration  = lerp(0.14, 0.4, clamp(speed * 0.82 + force * 0.18 + curvature * 0.22, 0, 1));

    this.gestureBus.volume.rampTo(busDb, 0.05);
    this.gestureFilter.frequency.rampTo(900 + xNorm * 2400 + speed * 900 + curvature * 700, 0.04);
    this.gestureDelay.wet.rampTo(0.1 + speed * 0.12 + curvature * 0.06, 0.06);
    this.gestureReverb.wet.rampTo(0.14 + yNorm * 0.1 + curvature * 0.06, 0.08);

    const pulseNotes = curvature > 0.42 ? notes.slice(0, 3) : notes.slice(0, 2);
    this.gestureSynth.triggerAttackRelease(pulseNotes, duration, undefined, velocity);

    if (curvature > 0.35) {
      const shimmer = Tone.Frequency(pulseNotes[pulseNotes.length - 1]).transpose(7).toNote();
      this.gestureSynth.triggerAttackRelease(
        [shimmer], Math.max(0.08, duration * 0.7), Tone.now() + 0.03,
        clamp(velocity * 0.62, 0.12, 0.55),
      );
    }

    if (speed > 0.16) {
      this.gestureNoise.volume.value = noiseDb;
      this.gestureNoiseFilter.frequency.rampTo(1300 + speed * 2200 + yNorm * 600 + curvature * 500, 0.03);
      this.gestureNoise.triggerAttackRelease(0.05 + speed * 0.08 + curvature * 0.05);
    }
  }

  dispose() {
    // FIX: call stop() first so held notes release before nodes are torn down,
    // preventing dangling AudioContext references on repeated start/stop cycles.
    this.stop();

    [
      this.synth, this.eq, this.vibrato, this.delay, this.freeverb,
      this.distortion, this.output, this.limiter,
      this.eventSynth, this.eventFilter, this.eventReverb, this.eventDelay,
      this.eventBus, this.textureNoise, this.noiseFilter,
      this.gestureSynth, this.gestureLead, this.gestureFilter,
      this.gestureDelay, this.gestureReverb, this.gestureBus,
      this.gestureNoise, this.gestureNoiseFilter,
    ].forEach((node) => node.dispose());
  }
}

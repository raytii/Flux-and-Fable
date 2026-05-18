// SpinField.js — discrete XY model for Defect Choir
//
// Physical model:
//   Each cell (i,j) holds a planar spin angle θ ∈ [0, 2π).
//   The update rule is a non-equilibrium discretisation of the XY Hamiltonian:
//     H = −J · Σ cos(θᵢ − θⱼ)    [nearest-neighbour sum]
//
//   Per step, each spin evolves as:
//     θ_new = θ + dt · (J·neighborForce + T·noise + B·fieldBias + steerForce)
//
//   where:
//     neighborForce = Σ sin(θⱼ − θᵢ)  — pulls toward neighbours (coupling J)
//     thermalKick   = T · rand(−1,1)   — stochastic noise (temperature T)
//     fieldForce    = B · sin(θ · 1.18)— symmetry-breaking drift bias (B)
//     steerForce    = steerStrength · sin(steerAngle − θ)  — user/event steering
//
//   The 0.16 prefactor on delta is the effective integration time-step.
//   The 0.966 accent decay and 0.918 steerForce decay are empirically tuned
//   to give responsive brushstrokes that fade over ~60 frames at 60 fps.
//
//   Topological defects (vortex/anti-vortex pairs) are tracked via localStrain:
//     localStrain = mean |sin(θⱼ − θᵢ)| across 4 neighbours
//     cells with localStrain > 0.66 are counted as defect cores
//
//   Six ambient event types (fault/shear/plume/ribbon/lattice/veil) inject
//   structured disturbances that mimic real phase-ordering phenomena.
//
// References:
//   Kosterlitz & Thouless (1973). "Ordering, metastability and phase transitions
//     in two-dimensional systems." J. Phys. C, 6(7), 1181.
//   Bray, A.J. (1994). "Theory of phase-ordering kinetics." Adv. Phys., 43(3).
//   XY Synth reference (T. Mudd): https://github.com/tothepoweroftom/xysynth
//     (this work extends the model with multi-event types, accent field,
//      defect tracking, mic coupling, and a bucket renderer)

const TAU = Math.PI * 2;
const PI = Math.PI;

function wrapAngle(angle) {
  angle %= TAU;
  return angle < 0 ? angle + TAU : angle;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function signedAngleDiff(a, b) {
  let diff = b - a;
  while (diff > PI) diff -= TAU;
  while (diff < -PI) diff += TAU;
  return diff;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function smoothFalloff(distanceSq, radiusSq) {
  const t = clamp(1 - distanceSq / radiusSq, 0, 1);
  return t * t * (3 - 2 * t);
}

function mergeEvents(primary, secondary) {
  return {
    kind: primary.kind,
    secondaryKind: secondary.kind,
    label: `${primary.label} + ${secondary.label}`,
    intensity: Math.max(primary.intensity, secondary.intensity),
    xNorm: (primary.xNorm + secondary.xNorm) * 0.5,
    yNorm: (primary.yNorm + secondary.yNorm) * 0.5,
    cooldown: Math.max(primary.cooldown, secondary.cooldown) + randomBetween(400, 900),
  };
}

export class SpinField {
  constructor({ cols = 92, rows = 92, hueBins = 56, satBins = 5, widthBins = 3 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.size = cols * rows;
    this.hueBins = hueBins;
    this.satBins = satBins;
    this.widthBins = widthBins;

    this.angles = new Float32Array(this.size);
    this.nextAngles = new Float32Array(this.size);
    this.accent = new Float32Array(this.size);
    this.nextAccent = new Float32Array(this.size);
    this.defectField = new Float32Array(this.size);
    this.steerAngle = new Float32Array(this.size);
    this.steerForce = new Float32Array(this.size);

    this.buckets = Array.from({ length: hueBins * satBins * widthBins }, () => []);

    this.width = 1;
    this.height = 1;
    this.cellW = 1;
    this.cellH = 1;

    this.coupling = 0.92;
    this.bias = 0.28;
    this.temperature = 0.22;
    this.colorShift = 0.92;

    this.order = 0;
    this.activity = 0;
    this.hueOffset = 0;
    this.defectCount = 0;
    this.defectMean = 0;
    this.frame = 0;
    this.lastEventLabel = 'None';

    this.seed();
  }

  seed(randomness = 1) {
    for (let i = 0; i < this.size; i += 1) {
      const angle = Math.random() * TAU * randomness;
      this.angles[i] = angle;
      this.nextAngles[i] = angle;
      this.accent[i] = 0;
      this.nextAccent[i] = 0;
      this.defectField[i] = 0;
      this.steerAngle[i] = angle;
      this.steerForce[i] = 0;
    }

    this.defectCount = 0;
    this.defectMean = 0;
    this.lastEventLabel = 'None';
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.cellW = width / this.cols;
    this.cellH = height / this.rows;
  }

  setParameters({ coupling, bias, temperature, colorShift }) {
    if (typeof coupling === 'number') this.coupling = coupling;
    if (typeof bias === 'number') this.bias = bias;
    if (typeof temperature === 'number') this.temperature = temperature;
    if (typeof colorShift === 'number') this.colorShift = colorShift;
  }

  injectBurst(strength = 1.8) {
    return this.triggerAmbientEvent(null, strength);
  }

  disturb(gridX, gridY, radius = 6, force = 1.2, dirX = 1, dirY = 0, speed = 0.5, curvature = 0) {
    const radiusSq = radius * radius;
    const mag = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / mag;
    const ny = dirY / mag;
    const tangentX = -ny;
    const tangentY = nx;
    const dragAngle = Math.atan2(ny, nx);
    const brushStrength = clamp(force * (0.34 + speed * 0.82 + curvature * 0.42), 0.14, 1.62);

    for (let y = -radius; y <= radius; y += 1) {
      const py = gridY + y;
      if (py < 0 || py >= this.rows) continue;

      for (let x = -radius; x <= radius; x += 1) {
        const px = gridX + x;
        if (px < 0 || px >= this.cols) continue;

        const distSq = x * x + y * y;
        if (distSq > radiusSq) continue;

        const idx = py * this.cols + px;
        const falloff = smoothFalloff(distSq, radiusSq);
        const lateral = (x * tangentX + y * tangentY) / Math.max(1, radius);
        const longitudinal = (x * nx + y * ny) / Math.max(1, radius);
        const weave = Math.sin((px * 0.43 + py * 0.31) + this.frame * 0.046 + longitudinal * 3.2) * (0.035 + curvature * 0.12);
        const grain = Math.sin((px * 0.91 - py * 0.57) + this.frame * 0.031) * (0.02 + speed * 0.018);
        const stripe = 0.5 + 0.5 * Math.sin(lateral * (4.4 + curvature * 4.8) + longitudinal * 2.6 + this.frame * 0.038);
        const targetAngle = wrapAngle(
          dragAngle
          + lateral * (0.18 + curvature * 0.22)
          + longitudinal * (0.05 + speed * 0.05)
          + weave
          + grain
        );
        const diff = signedAngleDiff(this.angles[idx], targetAngle);
        const steer = brushStrength * falloff;
        const jitter = (Math.random() * 2 - 1) * (0.01 + speed * 0.012 + curvature * 0.02) * falloff;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * steer * 0.23 + jitter);
        this.steerAngle[idx] = targetAngle;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.18 + steer * (1.08 + stripe * 0.32));
        this.accent[idx] = Math.max(this.accent[idx], 0.08 + falloff * (0.24 + speed * 0.38 + curvature * 0.32 + stripe * 0.24));
      }
    }

    this.lastEventLabel = 'Manual Comb';
  }

  triggerAmbientEvent(kind, strength = randomBetween(0.92, 1.42)) {
    const mode = kind || this.pickAmbientKind();
    const primary = this.applyEvent(mode, strength);

    if (Math.random() < 0.28) {
      let secondaryKind = this.pickAmbientKind();
      if (secondaryKind === mode) {
        secondaryKind = this.pickAmbientKind();
      }
      const secondary = this.applyEvent(secondaryKind, strength * randomBetween(0.58, 0.82));
      const combo = mergeEvents(primary, secondary);
      this.lastEventLabel = combo.label;
      return combo;
    }

    this.lastEventLabel = primary.label;
    return primary;
  }

  pickAmbientKind() {
    const r = Math.random();
    if (r < 0.2) return 'fault';
    if (r < 0.38) return 'shear';
    if (r < 0.56) return 'plume';
    if (r < 0.72) return 'ribbon';
    if (r < 0.88) return 'lattice';
    return 'veil';
  }

  applyEvent(kind, strength) {
    switch (kind) {
      case 'fault':
        return this.applyFaultLine(strength);
      case 'shear':
        return this.applyShearBand(strength);
      case 'ribbon':
        return this.applyRibbonField(strength);
      case 'lattice':
        return this.applyLatticeField(strength);
      case 'veil':
        return this.applyVeilField(strength);
      case 'plume':
      default:
        return this.applyPlume(strength);
    }
  }

  applyFaultLine(strength) {
    const vertical = Math.random() > 0.5;
    const pivot = Math.floor((vertical ? this.cols : this.rows) * randomBetween(0.18, 0.82));
    const band = Math.floor(randomBetween(2, 5));
    const phase = randomBetween(-0.85, 0.85) * strength;
    const steerAngle = vertical ? (phase > 0 ? PI * 0.05 : PI * 0.95) : (phase > 0 ? PI * 0.55 : PI * 1.45);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const distance = vertical ? Math.abs(col - pivot) : Math.abs(row - pivot);
        if (distance > band * 4) continue;

        const falloff = clamp(1 - distance / (band * 4), 0, 1);
        const side = vertical ? (col > pivot ? 1 : -1) : (row > pivot ? 1 : -1);
        const target = wrapAngle(steerAngle + side * 0.16 + Math.sin((row + col) * 0.08) * 0.08);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = falloff * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.22 + phase * falloff * side * 0.08);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.2 + influence * 0.7);
        this.accent[idx] = Math.max(this.accent[idx], 0.22 + falloff * 0.72);
      }
    }

    return {
      kind: 'fault',
      label: vertical ? 'Vertical Fault' : 'Horizontal Fault',
      intensity: strength,
      xNorm: vertical ? pivot / this.cols : 0.5,
      yNorm: vertical ? 0.5 : pivot / this.rows,
      cooldown: randomBetween(1600, 3200),
    };
  }

  applyShearBand(strength) {
    const theta = randomBetween(0, TAU);
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const tx = -ny;
    const ty = nx;
    const cx = randomBetween(this.cols * 0.2, this.cols * 0.8);
    const cy = randomBetween(this.rows * 0.2, this.rows * 0.8);
    const thickness = randomBetween(this.cols * 0.08, this.cols * 0.14);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const offX = col - cx;
        const offY = row - cy;
        const distance = Math.abs(offX * nx + offY * ny);
        if (distance > thickness) continue;

        const longitudinal = offX * tx + offY * ty;
        const falloff = clamp(1 - distance / thickness, 0, 1);
        const waviness = Math.sin(longitudinal * 0.16 + this.frame * 0.018) * 0.26;
        const target = wrapAngle(theta + waviness);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = falloff * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.18);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.16 + influence * 0.74);
        this.accent[idx] = Math.max(this.accent[idx], 0.15 + falloff * 0.74);
      }
    }

    return {
      kind: 'shear',
      label: 'Shear Band',
      intensity: strength,
      xNorm: cx / this.cols,
      yNorm: cy / this.rows,
      cooldown: randomBetween(1800, 3400),
    };
  }

  applyPlume(strength) {
    const theta = randomBetween(0, TAU);
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const tx = -ny;
    const ty = nx;
    const cx = randomBetween(this.cols * 0.22, this.cols * 0.78);
    const cy = randomBetween(this.rows * 0.22, this.rows * 0.78);
    const length = randomBetween(this.cols * 0.1, this.cols * 0.18);
    const width = randomBetween(this.rows * 0.06, this.rows * 0.12);
    const phaseBias = randomBetween(-0.32, 0.32);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const offX = col - cx;
        const offY = row - cy;
        const along = offX * nx + offY * ny;
        const across = offX * tx + offY * ty;
        const norm = (along * along) / (length * length) + (across * across) / (width * width);
        if (norm > 1) continue;

        const falloff = clamp(1 - norm, 0, 1);
        const wave = Math.sin(along * 0.14 + across * 0.18 + this.frame * 0.02) * 0.42;
        const target = wrapAngle(theta + phaseBias + wave * falloff);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = falloff * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.16);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.12 + influence * 0.66);
        this.accent[idx] = Math.max(this.accent[idx], 0.18 + falloff * 0.72);
      }
    }

    return {
      kind: 'plume',
      label: 'Feather Plume',
      intensity: strength,
      xNorm: cx / this.cols,
      yNorm: cy / this.rows,
      cooldown: randomBetween(2000, 3600),
    };
  }

  applyRibbonField(strength) {
    const theta = randomBetween(0, TAU);
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const tx = -ny;
    const ty = nx;
    const cx = randomBetween(this.cols * 0.24, this.cols * 0.76);
    const cy = randomBetween(this.rows * 0.24, this.rows * 0.76);
    const radius = randomBetween(this.cols * 0.22, this.cols * 0.34);
    const spacing = randomBetween(2.4, 4.2);
    const bend = randomBetween(-0.18, 0.18);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const offX = col - cx;
        const offY = row - cy;
        const along = offX * nx + offY * ny;
        const across = offX * tx + offY * ty;
        const radial = Math.hypot(offX, offY);
        if (radial > radius) continue;

        const envelope = clamp(1 - radial / radius, 0, 1);
        const ribbon = Math.sin(across / spacing + along * 0.065 + this.frame * 0.016);
        const lane = Math.pow(Math.abs(ribbon), 1.8);
        const target = wrapAngle(theta + ribbon * 0.32 + bend * envelope + Math.sin(along * 0.09) * 0.08);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = envelope * (0.35 + lane * 0.85) * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.17);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.14 + influence * 0.72);
        this.accent[idx] = Math.max(this.accent[idx], 0.18 + envelope * 0.2 + lane * 0.72);
      }
    }

    return {
      kind: 'ribbon',
      label: 'Ribbon Sweep',
      intensity: strength,
      xNorm: cx / this.cols,
      yNorm: cy / this.rows,
      cooldown: randomBetween(1800, 3200),
    };
  }

  applyLatticeField(strength) {
    const thetaA = randomBetween(0, TAU);
    const thetaB = thetaA + randomBetween(0.72, 1.32);
    const ax = Math.cos(thetaA);
    const ay = Math.sin(thetaA);
    const bx = Math.cos(thetaB);
    const by = Math.sin(thetaB);
    const cx = randomBetween(this.cols * 0.2, this.cols * 0.8);
    const cy = randomBetween(this.rows * 0.2, this.rows * 0.8);
    const radius = randomBetween(this.cols * 0.2, this.cols * 0.3);
    const freqA = randomBetween(0.16, 0.22);
    const freqB = randomBetween(0.14, 0.2);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const offX = col - cx;
        const offY = row - cy;
        const radial = Math.hypot(offX, offY);
        if (radial > radius) continue;

        const envelope = clamp(1 - radial / radius, 0, 1);
        const waveA = Math.sin((offX * ax + offY * ay) * freqA + this.frame * 0.016);
        const waveB = Math.sin((offX * bx + offY * by) * freqB - this.frame * 0.012);
        const blend = (waveA + waveB) * 0.5;
        const gridAccent = Math.pow(Math.abs(waveA * waveB), 0.6);
        const target = wrapAngle(thetaA + blend * 0.42 + waveB * 0.12);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = envelope * (0.3 + gridAccent * 0.9) * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.18);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.14 + influence * 0.76);
        this.accent[idx] = Math.max(this.accent[idx], 0.18 + envelope * 0.16 + gridAccent * 0.74);
      }
    }

    return {
      kind: 'lattice',
      label: 'Lattice Interference',
      intensity: strength,
      xNorm: cx / this.cols,
      yNorm: cy / this.rows,
      cooldown: randomBetween(1900, 3300),
    };
  }

  applyVeilField(strength) {
    const vertical = Math.random() > 0.5;
    const theta = vertical ? PI * 0.5 : 0;
    const pivot = vertical
      ? randomBetween(this.cols * 0.18, this.cols * 0.82)
      : randomBetween(this.rows * 0.18, this.rows * 0.82);
    const spread = vertical ? this.cols * randomBetween(0.18, 0.28) : this.rows * randomBetween(0.18, 0.28);
    const freq = randomBetween(0.18, 0.28);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const idx = row * this.cols + col;
        const axis = vertical ? col : row;
        const secondary = vertical ? row : col;
        const distance = Math.abs(axis - pivot);
        if (distance > spread) continue;

        const envelope = clamp(1 - distance / spread, 0, 1);
        const curtain = Math.sin(secondary * freq + this.frame * 0.022) * envelope;
        const ripple = Math.sin(axis * 0.11 - secondary * 0.06) * 0.08;
        const target = wrapAngle(theta + curtain * 0.36 + ripple);
        const diff = signedAngleDiff(this.angles[idx], target);
        const influence = envelope * strength;

        this.angles[idx] = wrapAngle(this.angles[idx] + diff * influence * 0.16);
        this.steerAngle[idx] = target;
        this.steerForce[idx] = Math.max(this.steerForce[idx], 0.12 + influence * 0.66);
        this.accent[idx] = Math.max(this.accent[idx], 0.14 + envelope * 0.3 + Math.abs(curtain) * 0.58);
      }
    }

    return {
      kind: 'veil',
      label: vertical ? 'Vertical Veil' : 'Horizontal Veil',
      intensity: strength,
      xNorm: vertical ? pivot / this.cols : 0.5,
      yNorm: vertical ? 0.5 : pivot / this.rows,
      cooldown: randomBetween(1700, 3100),
    };
  }

  step(substeps = 1) {
    const cols = this.cols;
    const rows = this.rows;
    const size = this.size;

    for (let s = 0; s < substeps; s += 1) {
      let sumCos = 0;
      let sumSin = 0;
      let totalDelta = 0;
      let defectAccum = 0;
      let defectCount = 0;

      for (let row = 0; row < rows; row += 1) {
        const rowOffset = row * cols;
        const upRow = ((row - 1 + rows) % rows) * cols;
        const downRow = ((row + 1) % rows) * cols;

        for (let col = 0; col < cols; col += 1) {
          const idx = rowOffset + col;
          const leftIdx = rowOffset + ((col - 1 + cols) % cols);
          const rightIdx = rowOffset + ((col + 1) % cols);
          const upIdx = upRow + col;
          const downIdx = downRow + col;

          const angle = this.angles[idx];
          const left = this.angles[leftIdx];
          const right = this.angles[rightIdx];
          const up = this.angles[upIdx];
          const down = this.angles[downIdx];

          const neighborForce =
            Math.sin(left - angle) +
            Math.sin(right - angle) +
            Math.sin(up - angle) +
            Math.sin(down - angle);

          const thermalKick = this.temperature * (Math.random() * 2 - 1) * 0.22;
          const fieldForce = this.bias * Math.sin(angle * 1.18 + this.frame * 0.006);
          const drift = this.colorShift * 0.0034 * Math.sin(row * 0.13 + col * 0.08 + this.frame * 0.012);
          const accentForce = this.accent[idx] * 0.07 * Math.sin((row - col) * 0.08 + this.frame * 0.022);
          const steerForce = this.steerForce[idx] * Math.sin(this.steerAngle[idx] - angle);

          const delta = this.coupling * neighborForce + thermalKick + fieldForce + drift + accentForce + steerForce * 0.96;
          const next = wrapAngle(angle - delta * 0.16);

          const localStrain = (
            Math.abs(Math.sin(left - angle)) +
            Math.abs(Math.sin(right - angle)) +
            Math.abs(Math.sin(up - angle)) +
            Math.abs(Math.sin(down - angle))
          ) * 0.25;

          this.nextAngles[idx] = next;
          this.defectField[idx] = localStrain;
          this.nextAccent[idx] = Math.max(this.accent[idx] * 0.966 - 0.0014, 0);
          this.steerForce[idx] = Math.max(this.steerForce[idx] * (0.918 - this.temperature * 0.012), 0);

          sumCos += Math.cos(next);
          sumSin += Math.sin(next);
          totalDelta += Math.abs(signedAngleDiff(angle, next));
          defectAccum += localStrain;
          if (localStrain > 0.66) defectCount += 1;
        }
      }

      const swapAngles = this.angles;
      this.angles = this.nextAngles;
      this.nextAngles = swapAngles;

      const swapAccent = this.accent;
      this.accent = this.nextAccent;
      this.nextAccent = swapAccent;

      this.order = Math.sqrt(sumCos * sumCos + sumSin * sumSin) / size;
      this.activity = clamp(totalDelta / size / PI, 0, 1);
      this.defectCount = defectCount;
      this.defectMean = defectAccum / size;
      this.frame += 1;
    }

    this.hueOffset = (this.hueOffset + (0.14 + this.colorShift * 0.85)) % 360;
  }

  render(ctx) {
    const fade = 0.076 + this.temperature * 0.028;
    ctx.fillStyle = `rgba(0, 0, 0, ${fade.toFixed(3)})`;
    ctx.fillRect(0, 0, this.width, this.height);

    for (let b = 0; b < this.buckets.length; b += 1) {
      this.buckets[b].length = 0;
    }

    const baseSat = 18 + this.colorShift * 64;
    const lightness = 57 + this.order * 16;
    const lineWidthBase = Math.max(0.85, Math.min(this.cellW, this.cellH) * (0.12 + this.colorShift * 0.05));
    const baseLength = Math.min(this.cellW, this.cellH) * (0.72 + Math.abs(this.coupling) * 0.34);

    for (let idx = 0; idx < this.size; idx += 1) {
      const angle = this.angles[idx];
      const col = idx % this.cols;
      const texture = clamp(this.accent[idx] * 0.84 + this.defectField[idx] * 0.54 + this.steerForce[idx] * 0.48, 0, 1.85);
      const hue = (angle * 180 / PI + this.hueOffset + (col / this.cols) * 18) % 360;
      const sat = clamp(baseSat + texture * 24, 12, 96);
      const hueBin = Math.floor((hue / 360) * this.hueBins) % this.hueBins;
      const satBin = Math.min(this.satBins - 1, Math.floor((sat / 100) * this.satBins));
      const widthBin = Math.min(this.widthBins - 1, Math.floor((texture / 1.85) * this.widthBins));
      const bucketIndex = (hueBin * this.satBins + satBin) * this.widthBins + widthBin;
      this.buckets[bucketIndex].push(idx);
    }

    ctx.lineCap = 'round';

    for (let h = 0; h < this.hueBins; h += 1) {
      for (let s = 0; s < this.satBins; s += 1) {
        for (let w = 0; w < this.widthBins; w += 1) {
          const bucket = this.buckets[(h * this.satBins + s) * this.widthBins + w];
          if (bucket.length === 0) continue;

          const hue = (h / this.hueBins) * 360;
          const sat = clamp(baseSat + (s / Math.max(1, this.satBins - 1)) * 28, 12, 96);
          const alpha = 0.12 + this.order * 0.15 + (s / Math.max(1, this.satBins - 1)) * 0.08 + w * 0.03;
          ctx.strokeStyle = `hsla(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${lightness.toFixed(1)}%, ${alpha.toFixed(3)})`;
          ctx.lineWidth = lineWidthBase * (0.82 + w * 0.48);
          ctx.beginPath();

          for (let i = 0; i < bucket.length; i += 1) {
            const idx = bucket[i];
            const col = idx % this.cols;
            const row = (idx / this.cols) | 0;
            const angle = this.angles[idx];
            const texture = clamp(this.accent[idx] * 0.78 + this.defectField[idx] * 0.74 + this.steerForce[idx] * 0.62, 0, 1.95);
            const pulse = 0.85 + 0.15 * Math.sin(row * 0.37 + col * 0.21 + this.frame * 0.05);
            const length = baseLength * (1 + texture * 0.88) * pulse;
            const half = length * 0.5;
            const x = (col + 0.5) * this.cellW;
            const y = (row + 0.5) * this.cellH;
            const dx = Math.cos(angle) * half;
            const dy = Math.sin(angle) * half;
            const nx = -Math.sin(angle);
            const ny = Math.cos(angle);

            ctx.moveTo(x - dx, y - dy);
            ctx.lineTo(x + dx, y + dy);

            if (texture > 0.38) {
              const off = Math.min(this.cellW, this.cellH) * (0.08 + texture * 0.16);
              ctx.moveTo(x - dx + nx * off, y - dy + ny * off);
              ctx.lineTo(x + dx + nx * off, y + dy + ny * off);
            }

            if (texture > 1.02) {
              const off = Math.min(this.cellW, this.cellH) * (0.06 + texture * 0.12);
              ctx.moveTo(x - dx - nx * off, y - dy - ny * off);
              ctx.lineTo(x + dx - nx * off, y + dy - ny * off);
            }
          }

          ctx.stroke();
        }
      }
    }
  }

  getMetrics() {
    return {
      order: this.order,
      activity: this.activity,
      defectCount: this.defectCount,
      defectMean: this.defectMean,
      hueOffset: this.hueOffset,
      cols: this.cols,
      rows: this.rows,
      lastEventLabel: this.lastEventLabel,
    };
  }
}

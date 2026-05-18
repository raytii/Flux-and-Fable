// main.js — Defect Choir v19
//
// Dual-hand gesture interaction:
//
//   LEFT  hand (proximity 远近) → 缠结 / Entanglement  (coupling  -1.4…+1.6)
//   RIGHT hand (proximity 远近) → 偏场 / Drift          (bias      -1.2…+1.2)
//
//   Both hands use the same power-curve proximity mapping:
//     palm bounding-box area → normalised t → t^0.68 (sub-linear) → parameter value
//   Sub-linear means the middle distance range is most sensitive —
//   a small move at ~50 cm produces a larger change than the same move at 20 cm.
//
//   Each hand also paints the field where it moves:
//     travel direction → spin angle → hue change + line direction at that location
//
//   When only one hand is present, the other parameter stays at slider value.
//   Both sliders move in real-time to reflect hand-driven values.
//   Two independent proximity arcs drawn on overlay (left = left side, right = right).

import { SpinField      } from './SpinField.js';
import { ToneDrone      } from './ToneDrone.js';
import { MicInput       } from './MicInput.js';
import { CameraMotion   } from './CameraMotion.js';
import { GestureControl } from './GestureControl.js';

// ─── Constants ─────────────────────────────────────────────────────────────
const COUPLING_MIN   = -1.4;
const COUPLING_MAX   =  1.6;
const BIAS_MIN       = -1.2;
const BIAS_MAX       =  1.2;
const FIXED_TEMPERATURE       = 0.22;
const GLOBAL_COLOR_SATURATION = 0.97;
const MOTION_ACTIVE_THRESHOLD = 0.025;

// ─── DOM refs ──────────────────────────────────────────────────────────────
const canvas           = document.getElementById('fieldCanvas');
const ctx              = canvas.getContext('2d', { alpha: false, desynchronized: true });
const rippleCanvas     = document.getElementById('rippleCanvas');
const rCtx             = rippleCanvas.getContext('2d');

const audioToggle      = document.getElementById('audioToggle');
const cameraToggle     = document.getElementById('cameraToggle');
const resetFieldButton = document.getElementById('resetField');
const burstFieldButton = document.getElementById('burstField');
const fullscreenButton = document.getElementById('fullscreenToggle');



// Two sliders and their indicators
const couplingInput  = document.getElementById('coupling');
const biasInput      = document.getElementById('bias');
const couplingLabel  = document.getElementById('couplingValue');
const biasLabel      = document.getElementById('biasValue');
const leftIndicator  = document.getElementById('leftHandIndicator');   // above coupling
const rightIndicator = document.getElementById('rightHandIndicator');  // above bias
const gestureHint    = document.getElementById('gestureHint');

// ─── Modules ───────────────────────────────────────────────────────────────
const field   = new SpinField({ cols: 92, rows: 92, hueBins: 56, satBins: 5, widthBins: 3 });
const drone   = new ToneDrone();
const mic     = new MicInput();
const camera  = new CameraMotion({ sampleW: 80, sampleH: 60 });
const gesture = new GestureControl();

// ─── Ambient cadence ───────────────────────────────────────────────────────
const ambientCadence = { minMs: 900, maxMs: 14500, burstiness: 0.78 };

// ─── State ─────────────────────────────────────────────────────────────────
let isAudioOn  = false;
let isCameraOn = false;
let animationFrameId    = 0;
let pointerDown         = false;
let burstQueueRemaining = 0;
let lastInteractionTime = performance.now();
let nextAmbientAt       = performance.now();

const dragState = {
  lastX: 0, lastY: 0, lastTime: 0, lastAngle: 0,
  smoothVX: 0, smoothVY: 0, smoothCurvature: 0,
};

const camState = {
  phase: 0, phaseB: 0, xNorm: 0.5, yNorm: 0.5, lastDisturbAt: 0,
};

// Per-hand disturbance cooldown state
const gestureDisturbLeft  = { lastDisturbAt: 0 };
const gestureDisturbRight = { lastDisturbAt: 0 };

// ─── Overlay: ripples + hand skeletons + proximity arcs ───────────────────
const ripples = [];

function spawnRipple(clientX, clientY, intensity = 1.0) {
  const rect = canvas.getBoundingClientRect();
  ripples.push({
    x: clientX - rect.left, y: clientY - rect.top,
    r: 4, alpha: 0.72 * intensity, speed: 2.4 + intensity * 2.2,
  });
}

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
];

// Draw hand skeleton. lineColour / dotColour allow visual distinction L vs R.
function drawHandSkeleton(lm, W, H, lineColour, dotColour) {
  rCtx.strokeStyle = lineColour;
  rCtx.lineWidth   = 1.0;
  rCtx.lineCap     = 'round';
  for (const [a, b] of HAND_CONNECTIONS) {
    rCtx.beginPath();
    rCtx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
    rCtx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
    rCtx.stroke();
  }
  rCtx.fillStyle = dotColour;
  for (const i of [0,4,8,12,16,20]) {
    rCtx.beginPath();
    rCtx.arc((1 - lm[i].x) * W, lm[i].y * H, 3.5, 0, Math.PI * 2);
    rCtx.fill();
  }
}

// Draw proximity arc around a hand.
// arcColour: hue-tinted so left/right hands are visually distinct.
// proximityT 0→1 sweeps the arc from thin sliver to full circle.
function drawProximityArc(palmBBox, proximityT, W, H, arcColour) {
  if (!palmBBox) return;

  const cx = (palmBBox.x + palmBBox.w * 0.5) * W;
  const cy = (palmBBox.y + palmBBox.h * 0.5) * H;
  const r  = Math.max(palmBBox.w, palmBBox.h) * 0.5 * Math.max(W, H) * 1.18;

  // Faint full-circle background so the empty gap is meaningful
  rCtx.beginPath();
  rCtx.arc(cx, cy, r, 0, Math.PI * 2);
  rCtx.strokeStyle = 'rgba(255,255,255,0.09)';
  rCtx.lineWidth   = 1.5;
  rCtx.stroke();

  if (proximityT < 0.01) return;

  const startAngle = -Math.PI * 0.5;
  const endAngle   = startAngle + proximityT * Math.PI * 2;

  rCtx.beginPath();
  rCtx.arc(cx, cy, r, startAngle, endAngle);
  rCtx.strokeStyle = arcColour;
  rCtx.lineWidth   = 2.4;
  rCtx.stroke();

  // Dot at arc tip
  rCtx.beginPath();
  rCtx.arc(
    cx + Math.cos(endAngle) * r,
    cy + Math.sin(endAngle) * r,
    3.5, 0, Math.PI * 2,
  );
  rCtx.fillStyle = arcColour;
  rCtx.fill();
}

// Build arc colours from proximityT — brightness encodes depth, hue encodes hand
function leftArcColour(t)  {
  const b = Math.floor(140 + t * 115);
  return `rgba(${b}, ${b}, ${Math.floor(b * 0.7)}, 0.88)`;  // warm white-gold
}
function rightArcColour(t) {
  const b = Math.floor(140 + t * 115);
  return `rgba(${Math.floor(b * 0.7)}, ${b}, ${b}, 0.88)`;  // cool white-cyan
}

function updateOverlay(gestureMetrics) {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const W   = rippleCanvas.width  / dpr;
  const H   = rippleCanvas.height / dpr;

  rCtx.clearRect(0, 0, rippleCanvas.width, rippleCanvas.height);
  rCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Click ripples
  for (let i = ripples.length - 1; i >= 0; i--) {
    const rp = ripples[i];
    rp.r    += rp.speed;
    rp.alpha *= 0.88;
    if (rp.alpha < 0.01) { ripples.splice(i, 1); continue; }
    rCtx.beginPath();
    rCtx.arc(rp.x, rp.y, rp.r, 0, Math.PI * 2);
    rCtx.strokeStyle = `rgba(255,255,255,${rp.alpha.toFixed(3)})`;
    rCtx.lineWidth   = 1.2;
    rCtx.stroke();
  }

  const { left, right } = gestureMetrics;

  if (left.present && left.landmarks) {
    drawHandSkeleton(left.landmarks, W, H,
      'rgba(255,240,180,0.32)', 'rgba(255,240,180,0.70)');  // warm gold
    drawProximityArc(left.palmBBox, left.proximityT, W, H,
      leftArcColour(left.proximityT));
  }

  if (right.present && right.landmarks) {
    drawHandSkeleton(right.landmarks, W, H,
      'rgba(180,240,255,0.32)', 'rgba(180,240,255,0.70)');  // cool cyan
    drawProximityArc(right.palmBBox, right.proximityT, W, H,
      rightArcColour(right.proximityT));
  }
}

// ─── Slider sync ───────────────────────────────────────────────────────────
// Sync both sliders to whatever value the hands are producing (or not).
// leftPresent / rightPresent toggle the indicator bars above each slider.

function syncSliders(coupling, bias, leftPresent, rightPresent) {
  couplingInput.value       = coupling.toFixed(4);
  couplingLabel.textContent = coupling.toFixed(2);
  biasInput.value           = bias.toFixed(4);
  biasLabel.textContent     = bias.toFixed(2);

  if (leftIndicator)  leftIndicator.classList.toggle('active',  leftPresent);
  if (rightIndicator) rightIndicator.classList.toggle('active', rightPresent);

  // Gesture hint: show when camera is on but neither hand is detected
  if (gestureHint) {
    gestureHint.classList.toggle('visible', isCameraOn && !leftPresent && !rightPresent);
  }
}

// ─── Utils ─────────────────────────────────────────────────────────────────
function clamp(v, mn, mx)    { return Math.min(mx, Math.max(mn, v)); }
function lerp(a, b, t)       { return a + (b - a) * t; }
function randomBetween(a, b) { return a + Math.random() * (b - a); }

function signedAngleDiff(a, b) {
  let d = b - a;
  while (d >  Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─── Button icons ──────────────────────────────────────────────────────────
function speakerIcon(on) {
  return on
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 10h4l5-4v12l-5-4H5z"/>
        <path d="M17 9.5a4.5 4.5 0 0 1 0 5"/>
        <path d="M19.5 7a8 8 0 0 1 0 10"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 10h4l5-4v12l-5-4H5z"/>
        <path d="M17 9l4 6"/><path d="M21 9l-4 6"/></svg>`;
}

function cameraIcon(on) {
  return on
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <circle cx="12" cy="14" r="3"/>
        <path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2" y="7" width="20" height="14" rx="2"/>
        <circle cx="12" cy="14" r="3"/>
        <path d="M8 7V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>
        <line x1="2" y1="2" x2="22" y2="22" stroke-width="1.5"/></svg>`;
}

function fullscreenIcon(isFs) {
  return isFs
    ? `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 0 2-2h3M3 16h3a2 2 0 0 0 2 2v3"/></svg>`
    : `<svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
}

function setAudioState() {
  audioToggle.innerHTML = speakerIcon(isAudioOn);
  audioToggle.classList.toggle('is-on', isAudioOn);
  audioToggle.setAttribute('aria-pressed', String(isAudioOn));
  audioToggle.setAttribute('aria-label', isAudioOn ? 'Disable sound' : 'Enable sound');
}

function setCameraState() {
  cameraToggle.innerHTML = cameraIcon(isCameraOn);
  cameraToggle.classList.toggle('is-on', isCameraOn);
  cameraToggle.setAttribute('aria-pressed', String(isCameraOn));
  cameraToggle.setAttribute('aria-label', isCameraOn ? 'Disable camera' : 'Enable camera');
  if (!isCameraOn) {
    if (leftIndicator)  leftIndicator.classList.remove('active');
    if (rightIndicator) rightIndicator.classList.remove('active');
    if (gestureHint)    gestureHint.classList.remove('visible');
  } else {
    if (gestureHint)    gestureHint.classList.add('visible');
  }
}

function setFullscreenState() {
  fullscreenButton.innerHTML = fullscreenIcon(Boolean(document.fullscreenElement));
  fullscreenButton.setAttribute('aria-label',
    document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen');
}

// ─── Fullscreen ────────────────────────────────────────────────────────────
async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await document.querySelector('.sheet').requestFullscreen().catch((e) => console.warn(e));
  } else {
    await document.exitFullscreen();
  }
}
document.addEventListener('fullscreenchange', () => { setFullscreenState(); setTimeout(resizeCanvas, 80); });
window.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFullscreen(); });

// ─── Ambient cadence ───────────────────────────────────────────────────────
function nextAmbientDelay() {
  const minMs = Math.max(60, ambientCadence.minMs);
  const maxMs = Math.max(minMs + 120, ambientCadence.maxMs);
  const b     = clamp(ambientCadence.burstiness, 0, 1);
  if (burstQueueRemaining > 0) {
    burstQueueRemaining--;
    return randomBetween(lerp(180,80,b), lerp(520,220,b));
  }
  const roll = Math.random();
  if (roll < 0.08 + b*0.28) {
    burstQueueRemaining = Math.random() < 0.58+b*0.22 ? 1 : 2;
    return randomBetween(lerp(520,140,b), lerp(1800,720,b));
  }
  if (roll > 1 - (0.08+b*0.22))
    return randomBetween(lerp(maxMs*0.55, maxMs*0.76, b), maxMs);
  return minMs + (maxMs-minMs) * Math.pow(Math.random(), 1.15 + b*2.05);
}

function scheduleNextAmbientEvent(offsetMs = 0) {
  nextAmbientAt = performance.now() + offsetMs + nextAmbientDelay();
}
function isRecentInteraction(now = performance.now()) {
  return pointerDown || now - lastInteractionTime < 180;
}

// ─── Build field parameters ────────────────────────────────────────────────
// Priority:
//   coupling → left hand if present, else coupling slider
//   bias     → right hand if present, else bias slider

function buildParams(gestureMetrics) {
  const { left, right } = gestureMetrics;

  const sliderCoupling = Number(couplingInput.value);
  const sliderBias     = Number(biasInput.value);

  const coupling = left.present  && left.targetValue  !== null
    ? clamp(left.targetValue,  COUPLING_MIN, COUPLING_MAX)
    : sliderCoupling;

  const bias = right.present && right.targetValue !== null
    ? clamp(right.targetValue, BIAS_MIN, BIAS_MAX)
    : sliderBias;

  syncSliders(coupling, bias, left.present, right.present);

  return {
    coupling,
    bias,
    temperature: FIXED_TEMPERATURE,
    colorShift:  GLOBAL_COLOR_SATURATION,
  };
}

// ─── Canvas resize ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const dpr    = Math.min(window.devicePixelRatio || 1, 1.5);
  const bounds = canvas.getBoundingClientRect();
  const width  = Math.max(320, Math.floor(bounds.width));
  const height = Math.max(240, Math.floor(bounds.height));

  canvas.width  = Math.floor(width  * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rippleCanvas.width        = canvas.width;
  rippleCanvas.height       = canvas.height;
  rippleCanvas.style.width  = width  + 'px';
  rippleCanvas.style.height = height + 'px';

  field.resize(width, height);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
}

function markInteraction() { lastInteractionTime = performance.now(); }

// ─── Ambient events ────────────────────────────────────────────────────────
function triggerAmbientEvent() {
  const event = field.triggerAmbientEvent();
  if (isAudioOn) drone.triggerAmbientEvent(event, field.getMetrics(), { duringInteraction: isRecentInteraction() });
  scheduleNextAmbientEvent();
}
function maybeTriggerAmbientEvent(now) {
  if (now >= nextAmbientAt) triggerAmbientEvent();
}

// ─── Camera-driven field disturbance ──────────────────────────────────────
function driveFromCamera(now, camMetrics) {
  if (!isCameraOn) return;
  const motion = camMetrics.motionLevel;
  if (motion < MOTION_ACTIVE_THRESHOLD) return;

  markInteraction();
  const ps = 0.004 + motion * 0.022;
  camState.phase  += ps;
  camState.phaseB += ps * 0.618;

  camState.xNorm = clamp(0.5 + 0.40 * Math.sin(camState.phase), 0.10, 0.90);
  camState.yNorm = clamp(0.5 + 0.40 * Math.sin(camState.phaseB + Math.PI * 0.5), 0.10, 0.90);

  const radius    = Math.floor(3 + motion * 16);
  const force     = clamp(0.3 + motion * 1.1, 0.25, 1.4);
  const speed     = clamp(0.1 + motion * 1.0, 0.06, 1.3);
  const curvature = clamp(0.1 + Math.abs(Math.sin(camState.phaseB)) * 0.4, 0, 1);
  const dirX      = Math.cos(camState.phase + Math.PI * 0.5);
  const dirY      = Math.sin(camState.phaseB);

  if (now - camState.lastDisturbAt >= lerp(90, 20, clamp(motion / 0.4, 0, 1))) {
    field.disturb(
      Math.floor(camState.xNorm * field.cols),
      Math.floor(camState.yNorm * field.rows),
      radius, force, dirX, dirY, speed, curvature,
    );
    camState.lastDisturbAt = now;
  }

  if (isAudioOn) {
    drone.updateGestureDrag(field.getMetrics(), {
      speed, curvature, xNorm: camState.xNorm, yNorm: camState.yNorm,
      force, dirAngle: Math.atan2(dirY, dirX),
    });
  }
}

// ─── Gesture-driven field disturbance ─────────────────────────────────────
// Each hand paints the field where it is and moves.
// dirX/dirY come from the hand's travel angle, so spin angles at that location
// reorient to the hand's direction — changing both line direction and hue.

function disturbFromHand(handMetrics, disturbState, now) {
  if (!handMetrics.present) return;

  const { palmCentreX, palmCentreY, palmMoveAngle, palmVelocity, proximityT } = handMetrics;

  const gridX = Math.floor(clamp(palmCentreX, 0, 1) * field.cols);
  const gridY = Math.floor(clamp(palmCentreY, 0, 1) * field.rows);

  // Brush radius: scales with proximity (close = bigger) and speed (fast = bigger)
  const radius = Math.floor(3 + proximityT * 9 + palmVelocity * 7);

  // Force: proximity boosts how strongly spins are steered
  const force = clamp(0.28 + proximityT * 0.72 + palmVelocity * 0.48, 0.22, 1.45);

  const dirX      = Math.cos(palmMoveAngle);
  const dirY      = Math.sin(palmMoveAngle);
  const curvature = clamp(palmVelocity * 0.3, 0, 0.5);

  // Disturbance interval: faster hand = more frequent calls = denser brush marks
  const disturbInterval = lerp(55, 12, clamp(palmVelocity, 0, 1));

  if (now - disturbState.lastDisturbAt >= disturbInterval) {
    field.disturb(gridX, gridY, radius, force, dirX, dirY,
      Math.max(0.08, palmVelocity), curvature);
    disturbState.lastDisturbAt = now;
  }

  markInteraction();
}

function driveFromGesture(now, gestureMetrics) {
  if (!isCameraOn) return;
  disturbFromHand(gestureMetrics.left,  gestureDisturbLeft,  now);
  disturbFromHand(gestureMetrics.right, gestureDisturbRight, now);
}

// ─── Pointer disturbance ───────────────────────────────────────────────────
function resetDragState(e) {
  dragState.lastX = e.clientX; dragState.lastY = e.clientY;
  dragState.lastTime = performance.now(); dragState.lastAngle = 0;
  dragState.smoothVX = 0; dragState.smoothVY = 0; dragState.smoothCurvature = 0;
}

function disturbFromPointer(clientX, clientY, force = 1.0, pulse = false) {
  const rect  = canvas.getBoundingClientRect();
  const xNorm = clamp((clientX - rect.left) / rect.width,  0, 1);
  const yNorm = clamp((clientY - rect.top)  / rect.height, 0, 1);
  const now   = performance.now();
  const dt    = Math.max(8, now - dragState.lastTime);

  dragState.smoothVX = dragState.smoothVX * 0.72 + ((clientX - dragState.lastX) / dt) * 0.28;
  dragState.smoothVY = dragState.smoothVY * 0.72 + ((clientY - dragState.lastY) / dt) * 0.28;

  const dragMag   = Math.hypot(dragState.smoothVX, dragState.smoothVY);
  const speed     = clamp(dragMag / 1.18, 0.04, 1.35);
  const dirX      = dragMag > 0.001 ? dragState.smoothVX : 1;
  const dirY      = dragMag > 0.001 ? dragState.smoothVY : 0;
  const angle     = Math.atan2(dirY, dirX);
  const curvature = dragState.lastAngle === 0
    ? 0 : Math.abs(signedAngleDiff(dragState.lastAngle, angle)) / Math.PI;

  dragState.smoothCurvature = dragState.smoothCurvature * 0.7 + curvature * 0.3;
  dragState.lastAngle = angle;

  field.disturb(
    Math.floor(xNorm * field.cols),
    Math.floor(yNorm * field.rows),
    Math.floor(4 + FIXED_TEMPERATURE*5 + speed*4.2 + dragState.smoothCurvature*3.2),
    force, dirX, dirY, speed, dragState.smoothCurvature,
  );

  if (isAudioOn) {
    const g = { speed, curvature: dragState.smoothCurvature, xNorm, yNorm, force, dirAngle: angle };
    drone.updateGestureDrag(field.getMetrics(), g);
    if (pulse) drone.triggerGesturePulse(field.getMetrics(), g);
  }

  dragState.lastX = clientX; dragState.lastY = clientY; dragState.lastTime = now;
}

// ─── Toggles ───────────────────────────────────────────────────────────────
async function toggleAudio() {
  if (!isAudioOn) {
    await drone.start();
    await mic.start(Tone.getContext().rawContext);
    isAudioOn = true;
  } else {
    mic.stop(); drone.stop(); isAudioOn = false;
  }
  setAudioState();
}

async function toggleCamera() {
  if (!isCameraOn) {
    await Promise.all([camera.start(), gesture.start()]);
    isCameraOn = true;
  } else {
    camera.stop(); gesture.stop(); isCameraOn = false;
  }
  setCameraState();
}

// ─── Field reset / burst ───────────────────────────────────────────────────
function resetField() {
  field.seed();
  burstQueueRemaining = 0;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (isAudioOn) drone.endGesture();
  Object.assign(camState, { phase:0, phaseB:0, xNorm:0.5, yNorm:0.5, lastDisturbAt:0 });
  markInteraction();
  scheduleNextAmbientEvent(1200);
}

function burstField() {
  const event = field.injectBurst(1.2 + Math.random() * 0.9);
  if (isAudioOn) drone.triggerAmbientEvent(event, field.getMetrics(), { duringInteraction: true });
  markInteraction();
  scheduleNextAmbientEvent(900);
}

// ─── Main loop ─────────────────────────────────────────────────────────────
function animate(now) {
  const camMetrics     = isCameraOn ? camera.update()      : { motionLevel: 0, active: false };
  const gestureMetrics = isCameraOn ? gesture.getMetrics() : {
    left:  { present: false, targetValue: null, landmarks: null, palmBBox: null, proximityT: 0, palmCentreX: 0.5, palmCentreY: 0.5, palmMoveAngle: 0, palmVelocity: 0 },
    right: { present: false, targetValue: null, landmarks: null, palmBBox: null, proximityT: 0, palmCentreX: 0.5, palmCentreY: 0.5, palmMoveAngle: 0, palmVelocity: 0 },
    isReady: false,
  };
  const micMetrics = isAudioOn
    ? mic.update(now)
    : { level: 0, brightness: 0.5, roughness: 0, flux: 0, onset: false, confidence: 0 };

  const params   = buildParams(gestureMetrics);
  const substeps = params.temperature > 0.8 ? 2 : 1;

  field.setParameters(params);
  driveFromCamera(now, camMetrics);
  driveFromGesture(now, gestureMetrics);
  field.step(substeps);
  field.render(ctx);

  updateOverlay(gestureMetrics);

  if (isAudioOn) drone.update(params, field.getMetrics());

  maybeTriggerAmbientEvent(now);
  animationFrameId = window.requestAnimationFrame(animate);
}

// ─── Pointer events ────────────────────────────────────────────────────────
canvas.addEventListener('pointerdown', (e) => {
  pointerDown = true;
  canvas.setPointerCapture(e.pointerId);
  resetDragState(e);
  markInteraction();
  spawnRipple(e.clientX, e.clientY, 0.7);
  if (isAudioOn) {
    drone.beginGesture(field.getMetrics(), {
      speed: 0.12, curvature: 0,
      xNorm: clamp(e.offsetX / canvas.clientWidth,  0, 1),
      yNorm: clamp(e.offsetY / canvas.clientHeight, 0, 1),
      force: 0.92, dirAngle: 0,
    });
  }
  disturbFromPointer(e.clientX, e.clientY, 0.96, true);
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointerDown) return;
  markInteraction();
  disturbFromPointer(e.clientX, e.clientY, 0.78, true);
});

canvas.addEventListener('pointerup', (e) => {
  pointerDown = false;
  canvas.releasePointerCapture(e.pointerId);
  if (isAudioOn) drone.endGesture();
  markInteraction();
});

canvas.addEventListener('pointerleave', () => {
  pointerDown = false;
  if (isAudioOn) drone.endGesture();
});

canvas.addEventListener('dblclick', (e) => {
  markInteraction();
  resetDragState(e);
  spawnRipple(e.clientX, e.clientY, 1.4);
  disturbFromPointer(e.clientX, e.clientY, 1.22, true);
  burstField();
});

[couplingInput, biasInput].forEach((i) => i.addEventListener('input', () => markInteraction()));

audioToggle.addEventListener('click', async () => {
  audioToggle.disabled = true;
  try { await toggleAudio(); }
  catch (err) { console.error(err); audioToggle.style.borderColor='#c00'; setTimeout(()=>audioToggle.style.borderColor='',3000); }
  finally { audioToggle.disabled = false; }
});

cameraToggle.addEventListener('click', async () => {
  cameraToggle.disabled = true;
  try { await toggleCamera(); }
  catch (err) { console.error(err); cameraToggle.style.borderColor='#c00'; setTimeout(()=>cameraToggle.style.borderColor='',3000); }
  finally { cameraToggle.disabled = false; }
});

fullscreenButton.addEventListener('click', toggleFullscreen);
resetFieldButton.addEventListener('click', resetField);
burstFieldButton.addEventListener('click', burstField);

window.addEventListener('resize', resizeCanvas, { passive: true });
window.addEventListener('beforeunload', () => {
  window.cancelAnimationFrame(animationFrameId);
  gesture.dispose(); camera.dispose(); mic.dispose(); drone.dispose();
});

// ─── Init ──────────────────────────────────────────────────────────────────
couplingLabel.textContent = Number(couplingInput.value).toFixed(2);
biasLabel.textContent     = Number(biasInput.value).toFixed(2);
setAudioState();
setCameraState();
setFullscreenState();
resizeCanvas();
scheduleNextAmbientEvent();
animationFrameId = window.requestAnimationFrame(animate);

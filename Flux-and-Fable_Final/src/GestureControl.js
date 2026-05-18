// GestureControl.js — dual-hand proximity tracking for Defect Choir v19
//
// Two hands, two parameters:
//   LEFT  hand proximity  →  缠结 / Entanglement  (coupling,  -1.4 … +1.6)
//   RIGHT hand proximity  →  偏场 / Drift          (bias,      -1.2 … +1.2)
//
// Same proximity mapping for both:
//   Input  : palm bounding-box area as fraction of frame area  (0 … ~0.20)
//   Mapping: normalise to [0,1] between PALM_FAR and PALM_NEAR,
//            then apply power curve t^CURVE_POWER (sub-linear: centre range
//            is most responsive — a 5 cm hand movement in the middle distance
//            produces a larger parameter change than the same movement when
//            very close or very far).
//   Output : lerp from parameter MIN to MAX using the curved t value.
//
//   Hand at arm's length  (~80 cm)  →  parameter at its MINIMUM
//   Hand at mid distance  (~50 cm)  →  parameter near mid-range (most sensitive)
//   Hand close to camera  (~25 cm)  →  parameter at its MAXIMUM
//
// Handedness note:
//   MediaPipe's multiHandedness label is FROM THE CAMERA'S PERSPECTIVE,
//   which is mirrored relative to the viewer. So:
//     MediaPipe "Left"  label = camera left = viewer's RIGHT hand
//     MediaPipe "Right" label = camera right = viewer's LEFT hand
//   We invert the label to get real-world handedness.
//   If handedness is unavailable, we assign by x position: hand on the
//   left side of the un-mirrored frame = left hand.
//
// Position + movement outputs (per hand):
//   palmCentreX / palmCentreY — un-mirrored normalised position (0=screen-left)
//   palmMoveAngle             — radians, direction of lateral movement
//   palmVelocity              — 0–1, normalised speed in frame plane
//
// References:
//   Lugaresi et al. (2019). MediaPipe: A Framework for Building Perception
//     Pipelines. arXiv:1906.08172.
//   MediaPipe Hands solution: https://google.github.io/mediapipe/solutions/hands

// ── Parameter ranges ────────────────────────────────────────────────────────
const COUPLING_MIN   = -1.4;
const COUPLING_MAX   =  1.6;
const COUPLING_RANGE = COUPLING_MAX - COUPLING_MIN;

const BIAS_MIN   = -1.2;
const BIAS_MAX   =  1.2;
const BIAS_RANGE = BIAS_MAX - BIAS_MIN;

// ── Proximity calibration ───────────────────────────────────────────────────
// Palm bounding-box area as fraction of total frame area.
// These work for a typical laptop front camera at the distances below.
// Tune PALM_NEAR / PALM_FAR in the README if your exhibition setup differs.
const PALM_NEAR  = 0.14;    // ~25 cm from camera → parameter MAX
const PALM_FAR   = 0.012;   // ~80 cm from camera → parameter MIN

// Sub-linear power curve: t^0.68 compresses the far range and expands the
// middle range, so a visitor at a natural working distance (40–60 cm) gets
// the most responsive region of the parameter.
const CURVE_POWER = 0.68;

// ── Smoothing ───────────────────────────────────────────────────────────────
// Single alpha (no split rise/fall) for both area and position — fast enough
// to feel immediate, slow enough to suppress jitter.
const AREA_ALPHA = 0.22;
const POS_ALPHA  = 0.28;

// Velocity smoothing: fast rise (responsive to new movement),
// slow fall (directional mark lingers a few frames after hand stops)
const VEL_ALPHA_RISE = 0.40;
const VEL_ALPHA_FALL = 0.12;
const MIN_VELOCITY   = 0.004;  // normalised units/frame; below this, don't update angle

// ── Detection settings ──────────────────────────────────────────────────────
const MIN_OPENNESS    = 0.32;   // wrist-to-tip / palm-width ratio; filters fists
const HAND_TIMEOUT_MS = 600;    // ms without detection before we release control

// ── Per-hand state class ─────────────────────────────────────────────────────
class HandState {
  constructor() {
    this.present       = false;
    this.lastSeenAt    = 0;

    // Proximity → parameter
    this.smoothArea    = 0;
    this.rawArea       = 0;
    this.proximityT    = 0;      // 0–1 after power curve, for arc drawing
    this.targetValue   = null;   // null = not controlling parameter

    // Position & movement
    this.palmCentreX   = 0.5;
    this.palmCentreY   = 0.5;
    this._smoothCX     = 0.5;
    this._smoothCY     = 0.5;
    this._prevCX       = 0.5;
    this._prevCY       = 0.5;
    this.palmMoveAngle = 0;
    this.palmVelocity  = 0;
    this._smoothVel    = 0;

    // Drawing
    this.landmarks     = null;
    this.palmBBox      = null;
  }

  reset() {
    this.present       = false;
    this.smoothArea    = 0;
    this.proximityT    = 0;
    this.targetValue   = null;
    this.palmVelocity  = 0;
    this._smoothVel    = 0;
    this.palmCentreX   = 0.5;
    this.palmCentreY   = 0.5;
    this._smoothCX     = 0.5;
    this._smoothCY     = 0.5;
    this._prevCX       = 0.5;
    this._prevCY       = 0.5;
    this.palmMoveAngle = 0;
    this.landmarks     = null;
    this.palmBBox      = null;
  }

  // Update from a set of 21 MediaPipe landmarks.
  // paramMin / paramMax define this hand's parameter range.
  update(lm, paramMin, paramRange, now) {
    // ── Open-palm filter ────────────────────────────────────────────────
    const palmWidth = Math.hypot(lm[5].x - lm[17].x, lm[5].y - lm[17].y);
    const tipDist   = Math.hypot(lm[12].x - lm[0].x,  lm[12].y - lm[0].y);
    const openness  = palmWidth > 0.001 ? tipDist / palmWidth : 0;
    if (openness < MIN_OPENNESS) return false; // fist — skip frame

    // ── Bounding box & area ──────────────────────────────────────────────
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const p of lm) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;

    this.rawArea    = bboxW * bboxH;
    this.smoothArea = this.smoothArea * (1 - AREA_ALPHA) + this.rawArea * AREA_ALPHA;

    // ── Proximity → parameter value (power curve) ────────────────────────
    const rawT      = (this.smoothArea - PALM_FAR) / (PALM_NEAR - PALM_FAR);
    this.proximityT = Math.max(0, Math.min(1, rawT));
    const curvedT   = Math.pow(this.proximityT, CURVE_POWER);
    this.targetValue = paramMin + curvedT * paramRange;

    // ── Palm centre (un-mirrored x: 0 = left on screen) ─────────────────
    const rawCX = 1 - (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
    const rawCY =      (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;

    this._smoothCX = this._smoothCX * (1 - POS_ALPHA) + rawCX * POS_ALPHA;
    this._smoothCY = this._smoothCY * (1 - POS_ALPHA) + rawCY * POS_ALPHA;

    // ── Velocity & movement direction ────────────────────────────────────
    const dvx    = this._smoothCX - this._prevCX;
    const dvy    = this._smoothCY - this._prevCY;
    const rawVel = Math.hypot(dvx, dvy);
    const va     = rawVel > this._smoothVel ? VEL_ALPHA_RISE : VEL_ALPHA_FALL;
    this._smoothVel   = this._smoothVel * (1 - va) + rawVel * va;
    this.palmVelocity = Math.min(1, this._smoothVel / 0.025);
    if (rawVel > MIN_VELOCITY) this.palmMoveAngle = Math.atan2(dvy, dvx);

    this._prevCX = this._smoothCX;
    this._prevCY = this._smoothCY;

    this.palmCentreX = this._smoothCX;
    this.palmCentreY = this._smoothCY;
    this.present     = true;
    this.lastSeenAt  = now;
    this.landmarks   = lm;
    this.palmBBox    = { x: 1 - maxX, y: minY, w: bboxW, h: bboxH };

    return true;
  }

  toMetrics() {
    return {
      present:       this.present,
      targetValue:   this.targetValue,
      proximityT:    this.proximityT,
      palmCentreX:   this.palmCentreX,
      palmCentreY:   this.palmCentreY,
      palmMoveAngle: this.palmMoveAngle,
      palmVelocity:  this.palmVelocity,
      landmarks:     this.landmarks,
      palmBBox:      this.palmBBox,
    };
  }
}

// ── Main class ───────────────────────────────────────────────────────────────
export class GestureControl {
  constructor() {
    this.hands     = null;
    this.camera    = null;
    this.video     = null;
    this.isStarted = false;
    this.isReady   = false;

    // Two independent hand states
    this.leftHand  = new HandState();   // controls coupling (缠结)
    this.rightHand = new HandState();   // controls bias     (偏场)
  }

  async start() {
    if (this.isStarted) return;
    if (!window.Hands || !window.Camera) {
      throw new Error('MediaPipe Hands / Camera not loaded.');
    }

    this.video = document.createElement('video');
    this.video.style.display = 'none';
    document.body.appendChild(this.video);

    this.hands = new window.Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}`,
    });

    this.hands.setOptions({
      maxNumHands:            2,      // ← two hands now
      modelComplexity:        1,
      minDetectionConfidence: 0.70,
      minTrackingConfidence:  0.55,
    });

    this.hands.onResults((r) => this._onResult(r));

    this.camera = new window.Camera(this.video, {
      onFrame: async () => { if (this.hands) await this.hands.send({ image: this.video }); },
      width: 640, height: 480, facingMode: 'user',
    });

    await this.camera.start();
    this.isStarted = true;
  }

  stop() {
    if (!this.isStarted) return;
    if (this.camera) { this.camera.stop(); this.camera = null; }
    if (this.hands)  { this.hands.close(); this.hands  = null; }
    if (this.video)  { this.video.remove(); this.video = null; }
    this.isStarted = false;
    this.isReady   = false;
    this.leftHand.reset();
    this.rightHand.reset();
  }

  // ─── MediaPipe result handler ───────────────────────────────────────────
  _onResult(results) {
    this.isReady = true;
    const now    = performance.now();

    // Release hands that haven't been seen recently
    if (now - this.leftHand.lastSeenAt  > HAND_TIMEOUT_MS) this.leftHand.reset();
    if (now - this.rightHand.lastSeenAt > HAND_TIMEOUT_MS) this.rightHand.reset();

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) return;

    results.multiHandLandmarks.forEach((lm, i) => {
      // ── Determine real-world handedness ─────────────────────────────────
      // MediaPipe's label is from the camera's (mirrored) POV, so we invert.
      // Fallback: if no handedness data, assign by un-mirrored x position.
      let isLeft;
      const label = results.multiHandedness?.[i]?.label;
      if (label) {
        // "Left" from MediaPipe (camera left) = viewer's RIGHT hand → isLeft false
        isLeft = label === 'Right'; // camera "Right" = viewer's LEFT
      } else {
        // No label — use x position of wrist landmark (un-mirrored)
        // un-mirrored x = 1 - lm[0].x; if < 0.5 it's on the left of screen
        isLeft = (1 - lm[0].x) < 0.5;
      }

      if (isLeft) {
        this.leftHand.update(lm, COUPLING_MIN, COUPLING_RANGE, now);
      } else {
        this.rightHand.update(lm, BIAS_MIN, BIAS_RANGE, now);
      }
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────
  getMetrics() {
    return {
      left:    this.leftHand.toMetrics(),
      right:   this.rightHand.toMetrics(),
      isReady: this.isReady,
    };
  }

  dispose() { this.stop(); }
}

// CameraMotion.js — frame-differencing motion detector for Defect Choir
//
// Algorithm: frame differencing on a downsampled 80×60 offscreen canvas.
//   motionLevel = RMS pixel-luminance difference between consecutive frames,
//   after subtracting an adaptive baseline that tracks slow background drift.
//
// Used for: driving the SpinField.disturb() brush position/force.
// NOT used for: coupling parameter (that is now owned by GestureControl).
//
// Shares the same camera permission as GestureControl (both request video),
// but uses an independent video element and canvas — MediaPipe handles its
// own camera via Camera utility, so these two don't conflict.
//
// References:
//   Gonzalez & Woods (2017). Digital Image Processing, 4th ed., §10.2
//   ITU-R BT.601 luminance formula: Y = 0.299R + 0.587G + 0.114B

export class CameraMotion {
  constructor({ sampleW = 80, sampleH = 60 } = {}) {
    this.sampleW = sampleW;
    this.sampleH = sampleH;
    this.canvas  = document.createElement('canvas');
    this.canvas.width  = sampleW;
    this.canvas.height = sampleH;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.video     = null;
    this.stream    = null;
    this.isStarted = false;

    this.prevLuma      = new Uint8Array(sampleW * sampleH);
    this.baseline      = 0;
    this.smoothedLevel = 0;

    this.metrics = { motionLevel: 0, active: false };
  }

  async start() {
    if (this.isStarted) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width:     { ideal: 640 },
        height:    { ideal: 480 },
        frameRate: { ideal: 30, max: 60 },
      },
      audio: false,
    });

    this.video = document.createElement('video');
    this.video.srcObject  = this.stream;
    this.video.playsInline = true;
    this.video.muted      = true;

    await new Promise((resolve, reject) => {
      this.video.onloadedmetadata = () => this.video.play().then(resolve).catch(reject);
      this.video.onerror = reject;
    });

    this._captureFrame(); // warm-up
    this.isStarted = true;
  }

  stop() {
    if (!this.isStarted) return;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.video     = null;
    this.stream    = null;
    this.isStarted = false;
    this.prevLuma.fill(0);
    this.baseline      = 0;
    this.smoothedLevel = 0;
    this.metrics = { motionLevel: 0, active: false };
  }

  _captureFrame() {
    if (!this.video || this.video.readyState < 2) return null;
    this.ctx.save();
    this.ctx.scale(-1, 1);
    this.ctx.drawImage(this.video, -this.sampleW, 0, this.sampleW, this.sampleH);
    this.ctx.restore();
    return this.ctx.getImageData(0, 0, this.sampleW, this.sampleH).data;
  }

  update() {
    if (!this.isStarted) return this.metrics;
    const pixels = this._captureFrame();
    if (!pixels) return this.metrics;

    const n = this.sampleW * this.sampleH;
    let sumSqDiff = 0;

    for (let i = 0; i < n; i++) {
      const base = i * 4;
      // ITU-R BT.601 integer luminance (shift avoids float division)
      const luma = (pixels[base] * 77 + pixels[base + 1] * 150 + pixels[base + 2] * 29) >> 8;
      const diff = luma - this.prevLuma[i];
      sumSqDiff += diff * diff;
      this.prevLuma[i] = luma;
    }

    const raw = Math.sqrt(sumSqDiff / n) / 255;

    // Adaptive baseline: tracks static scene drift slowly
    if (raw < this.baseline + 0.008) {
      this.baseline = this.baseline * 0.985 + raw * 0.015;
    } else {
      this.baseline = this.baseline * 0.999;
    }

    const usable     = Math.max(0, raw - this.baseline - 0.004);
    const normalised = Math.min(1, usable / 0.18);

    const alpha = normalised > this.smoothedLevel ? 0.35 : 0.08;
    this.smoothedLevel = this.smoothedLevel * (1 - alpha) + normalised * alpha;

    this.metrics = {
      motionLevel: this.smoothedLevel,
      active:      this.smoothedLevel > 0.02,
    };
    return this.metrics;
  }

  getMetrics() { return this.metrics; }
  dispose()    { this.stop(); }
}

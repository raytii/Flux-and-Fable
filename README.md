# Flux and Fable

**Interactive dual-hand gesture artwork** — MA Computational Arts, Goldsmiths, University of London, 2025–2026

A real-time browser-based artwork in which a two-dimensional XY spin-field lattice is shaped by the proximity of a viewer's open hands to a camera. The left hand governs **Entanglement** (coupling constant J); the right hand governs **Drift** (symmetry-breaking bias B). As hands draw near, the field coheres into ordered chromatic domains. As they withdraw, thermal noise fragments those domains and topological defects reappear. An FM synthesis engine continuously sonifies the field's physical state.

---

## File structure

```
flux-and-fable/
├── index.html          Main page
├── styles.css          Styles
├── README.md
└── src/
    ├── main.js             Main loop, gesture–field mapping, overlay drawing
    ├── GestureControl.js   Dual-hand MediaPipe proximity tracking
    ├── CameraMotion.js     Frame-differencing motion detection
    ├── SpinField.js        XY spin-field physics engine and bucket renderer
    ├── ToneDrone.js        Three-bus FM audio engine (Tone.js)
    └── MicInput.js         Microphone analysis (audio output only)
```

---

## How to run

1. Clone or download this repository
2. Open the root folder in VS Code
3. Install the **Live Server** extension (ritwickdey.liveserver)
4. Right-click `index.html` → **Open with Live Server**
5. Click the camera button to enable gesture input
6. Click the speaker button to enable audio (optional)

> Requires a modern browser with camera permission. Must run on `localhost` or HTTPS — MediaPipe requires a secure context.

---

## Gesture interaction

| Action | Effect |
|--------|--------|
| Left hand open palm, move closer | Entanglement rises → field orders into large coherent domains |
| Left hand move further away | Entanglement falls → field fragments into turbulent defects |
| Right hand open palm, move closer | Drift rises → symmetry-breaking bias increases |
| Right hand move further away | Drift falls |
| Hand movement across frame | Paints directional colour brushstrokes into the field |
| Close fist | Gesture pauses, parameter holds |
| Mouse drag on canvas | Direct field combing |
| Double-click canvas | Rift burst event |
| F key | Toggle fullscreen |

---

## Technical overview

- **SpinField.js** — Discrete XY model update (Kosterlitz–Thouless phase transition). 92×92 lattice, bucket renderer (~72 draw calls instead of ~8,464 per frame), six ambient event types.
- **GestureControl.js** — MediaPipe Hands (`maxNumHands: 2`). Palm bounding-box area maps to parameter via sub-linear power curve (t^0.68). Closed-fist filter, 600 ms release timeout, handedness inversion for mirrored camera coordinates.
- **CameraMotion.js** — Frame differencing on 80×60 downsampled canvas. ITU-R BT.601 luminance, adaptive baseline for lighting drift.
- **ToneDrone.js** — Three-bus FM synthesis: drone bus (continuous, tracks order parameter), event bus (ambient polyphonic chords), gesture bus (real-time lead synth).
- **MicInput.js** — RMS amplitude, spectral brightness, flux, onset detection. Used for audio timbre only — not for visual parameters.

---

## Tuning for exhibition

In `src/GestureControl.js`:

```js
const PALM_NEAR  = 0.14;   // hand ~25 cm from camera → parameter MAX (decrease to require closer hand)
const PALM_FAR   = 0.012;  // hand ~80 cm from camera → parameter MIN (increase to reach MIN sooner)
const CURVE_POWER = 0.68;  // < 1 = mid-range most sensitive; 1.0 = linear
const AREA_ALPHA  = 0.22;  // smoothing speed (higher = more responsive, more jitter)
```

---

## References

- Kosterlitz, J.M. & Thouless, D.J. (1973). Ordering, metastability and phase transitions in two-dimensional systems. *Journal of Physics C*, 6(7), 1181–1203.
- Lugaresi, C. et al. (2019). MediaPipe: A framework for building perception pipelines. arXiv:1906.08172.
- Mudd, T. (2018). XY Synth. *Experiments with Google*. https://experiments.withgoogle.com/xy-synth
- Tone.js: https://tonejs.github.io
- MediaPipe Hands: https://google.github.io/mediapipe/solutions/hands

---

## AI tools used

Claude (Anthropic, Claude Sonnet, 2024–2025) was used as a coding assistant during development for debugging, optimisation, and documentation. All conceptual and design decisions are the author's own.

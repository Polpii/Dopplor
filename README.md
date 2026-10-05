# Dopplor

An augmented mirror that draws your body back at you in light.

![Dopplor tracking body, hands and face](docs/tracking.gif)

Dopplor is a rewrite of [Second Self](https://www.paulpeterarslan.com/projects/second-self), an augmented mirror I built in 2021. The setup is the same: a screen sits behind a one-way mirror and a webcam watches you. The screen draws a neon version of your skeleton, hands and face on top of your reflection. Black pixels don't show through the glass, so all you see on the mirror is the light.

This version runs entirely in the browser.

## What it tracks

| Body | Face |
| --- | --- |
| ![Body](docs/body.png) | ![Face](docs/face.png) |

- **Body**: 33 points (MediaPipe Pose, lite / full / heavy)
- **Hands**: 21 points per hand
- **Face**: the 478-point mesh, plus the 52 blendshapes. I use them to make the face react: a smile turns the lips gold, an open mouth lights up, raised eyebrows glow, frowning turns them red, a closed eye switches its iris off.

## How it works

A few things that took some trial and error:

**Hands and face are searched near the body, not in the whole frame.** Out of the box, the hand and face models get the full webcam image shrunk down to ~200 px. That's fine for a selfie, but from two meters away your face is a few pixels wide and nothing gets detected. Instead, the body skeleton tells me where the head and wrists are, so I crop those regions at full resolution and feed the crops to the models (same idea as MediaPipe Holistic). The face now gets picked up from across the room.

**Fast hands.** The wrist crop is placed where the wrist is *going* (extrapolated from its speed), and grows when you move fast. If the hand still gets lost (motion blur), it stays attached to the wrist for half a second instead of vanishing.

**Nothing blocks the drawing.** Each model runs in its own Web Worker on the GPU. Camera frames are handed over as `VideoFrame`s, without copies. A busy worker skips frames instead of queueing them, so latency doesn't pile up.

**Smoothing** uses the One Euro filter: heavy smoothing when you're still (no jitter), light smoothing when you move (no lag).

**Rendering** is plain WebGL2, no engine. Every bone is an instanced quad shaded with a distance field. Everything is drawn into an HDR buffer, then bloomed with a mip chain and tone mapped. The background is clamped to true black, because on a one-way mirror even a faint grey haze shows up.

## Running it

You need Node 20+, Chrome or Edge, and a webcam.

```bash
npm install   # also copies the MediaPipe runtime and downloads the models into public/
npm run dev
```

Then open http://localhost:5173 and allow the camera. The first launch takes a few seconds while the GPU compiles the models; after that it's cached.

On a laptop with two GPUs, Windows usually runs the browser on the integrated one, which is several times slower. Set the browser to "High performance" in *Settings → System → Display → Graphics*. The debug panel shows which GPU is in use, and turns orange if it's the integrated one.

## Controls

| Key | |
| --- | --- |
| `C` | black screen / camera feed |
| `1` `2` `3` | toggle body / hands / face |
| `P` | cycle the body model: lite, full, heavy |
| `F` | fullscreen |
| `H` | hide the debug panel |

![Debug panel](docs/debug-panel.png)

The panel shows the GPU, the speed of each model, whether hands and face run on crops ("zoom") or on the full frame, and the expression currently detected. The UI is in French.

## Code

```
src/
  main.ts            camera loop, keyboard, debug panel
  scene.ts           tracking, smoothing, expressions
  vision/
    vision.worker.ts MediaPipe inference (one worker per model)
    roi.ts           where to look for hands and face, from the skeleton
    client.ts        main thread side of a worker
  render/
    neon-renderer.ts WebGL2 pipeline (segments, bloom, tone mapping)
    figures.ts       turns body / hands / face into glowing segments
    shaders.ts
scripts/
  setup-assets.mjs   fetches the models
```

## Not done yet

- Calibration to the actual reflection. Right now the overlay is aligned with the camera image, not with what your eyes see in the mirror (that needs eye tracking and the mirror geometry).
- One person at a time.
- Very fast hand moves still drop out on a 30 fps webcam. A 60 fps camera helps a lot.

## Credits

- [MediaPipe](https://ai.google.dev/edge/mediapipe) for the pose, hand and face models
- Bloom filters from Jorge Jimenez, *Next Generation Post Processing in Call of Duty: Advanced Warfare* (SIGGRAPH 2014)
- One Euro filter: Casiez, Roussel & Vogel, CHI 2012

The screenshots come from test videos played through a fake webcam, so no one had to stand in front of the camera.

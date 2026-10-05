// Zones de recherche des mains et du visage, déduites du squelette (comme MediaPipe Holistic).
// Les modèles mains/visage reçoivent alors un gros plan en pleine résolution au lieu de
// l'image entière réduite : le visage est détecté de loin, et les mains rapides sont retrouvées.
import { Scene, type Side, type Track } from "../scene";
import { STRIDE, type Roi } from "./protocol";

const NOSE = 0;
const EYES = [2, 5];
const EARS = [7, 8];
const MOUTH = [9, 10];
const SHOULDERS = [11, 12];
const ARM: Record<Side, { wrist: number; elbow: number; pinky: number; index: number }> = {
  left: { wrist: 15, elbow: 13, pinky: 17, index: 19 },
  right: { wrist: 16, elbow: 14, pinky: 18, index: 20 },
};
const MIN_VISIBILITY = 0.3;
/** La zone s'agrandit avec la vitesse : marge pour ~60 ms de mouvement. */
const MOTION_MARGIN_S = 0.06;

type Vec = [number, number];

/** Corps actuellement détecté (pas en cours de disparition), ou undefined. */
export function trackedBody(scene: Scene): Track | undefined {
  for (const body of scene.bodies) if (body.lostAt === null && body.hits >= 2) return body;
  return undefined;
}

/**
 * Une zone par main visible, centrée un peu au-delà du poignet vers les doigts.
 * Positions extrapolées à `time` : la zone attend la main là où elle va, pas là où elle était.
 */
export function handRois(body: Track, width: number, height: number, time: number): Roi[] {
  const at = (i: number): Vec => {
    const [x, y] = Scene.predict(body, i, time);
    return [x * width, y * height];
  };
  const shoulders = dist(at(SHOULDERS[0]), at(SHOULDERS[1]));
  const rois: Roi[] = [];
  for (const side of ["left", "right"] as const) {
    const arm = ARM[side];
    if (visibility(body, arm.wrist) < MIN_VISIBILITY) continue;
    const wrist = at(arm.wrist);
    const knuckles = mid(at(arm.index), at(arm.pinky));
    const forearm = dist(wrist, at(arm.elbow));
    const handLen = dist(wrist, knuckles);
    // Direction des doigts ; à défaut, le prolongement de l'avant-bras.
    let dir = sub(knuckles, wrist);
    if (Math.hypot(dir[0], dir[1]) < 2) dir = sub(wrist, at(arm.elbow));
    const n = normalize(dir);

    const speed = Scene.speed(body, arm.wrist) * width;
    const base = Math.max(handLen * 2.6, forearm * 1.1, shoulders * 0.55);
    const size = clamp(base + speed * MOTION_MARGIN_S, 64, Math.min(width, height) * 0.8);
    const cx = wrist[0] + n[0] * base * 0.3;
    const cy = wrist[1] + n[1] * base * 0.3;
    rois.push({ key: `${body.key}/${side}`, x: cx - size / 2, y: cy - size / 2, size });
  }
  return rois;
}

/** Zone du visage : centrée entre yeux, nez et bouche, dimensionnée sur la tête et les épaules. */
export function faceRois(body: Track, width: number, height: number, time: number): Roi[] {
  if (visibility(body, NOSE) < MIN_VISIBILITY) return [];
  const at = (i: number): Vec => {
    const [x, y] = Scene.predict(body, i, time);
    return [x * width, y * height];
  };
  const eyes = mid(at(EYES[0]), at(EYES[1]));
  const mouth = mid(at(MOUTH[0]), at(MOUTH[1]));
  const nose = at(NOSE);
  const cx = (eyes[0] + mouth[0] + nose[0]) / 3;
  const cy = (eyes[1] + mouth[1] + nose[1]) / 3;

  const head = Math.max(
    dist(at(EARS[0]), at(EARS[1])) * 2.0,
    dist(at(EYES[0]), at(EYES[1])) * 4.0,
    dist(at(SHOULDERS[0]), at(SHOULDERS[1])) * 0.6,
  );
  const speed = Scene.speed(body, NOSE) * width;
  const size = clamp(head + speed * MOTION_MARGIN_S, 80, Math.min(width, height));
  return [{ key: `${body.key}/face`, x: cx - size / 2, y: cy - size / 2, size }];
}

const visibility = (t: Track, i: number) => t.raw[i * STRIDE + 3];
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mid = (a: Vec, b: Vec): Vec => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const normalize = (v: Vec): Vec => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

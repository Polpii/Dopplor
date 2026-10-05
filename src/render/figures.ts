// Transforme la scène (corps, mains, visages) en segments lumineux.
import { FaceLandmarker, HandLandmarker } from "@mediapipe/tasks-vision";
import { Scene, type Side, type Track } from "../scene";
import { STRIDE, type Expression } from "../vision/protocol";
import { hexToRgb, type RGB, type SegmentBuffer } from "./segments";

interface Palette {
  left: RGB;
  right: RGB;
  center: RGB;
}

// Une palette par personne détectée.
const PALETTES: Palette[] = [
  { left: hexToRgb("#5ef2ff"), right: hexToRgb("#a78bfa"), center: hexToRgb("#cfe8ff") },
  { left: hexToRgb("#ff7ab6"), right: hexToRgb("#ffb86b"), center: hexToRgb("#ffe0ec") },
];

// Indices MediaPipe Pose (33 points). [a, b, côté, épaisseur relative]
type BodySide = Side | "center";
const BODY_BONES: [number, number, BodySide, number][] = [
  [11, 12, "center", 1], [11, 23, "left", 1], [12, 24, "right", 1], [23, 24, "center", 1],
  [11, 13, "left", 1], [13, 15, "left", 1], [12, 14, "right", 1], [14, 16, "right", 1],
  [23, 25, "left", 1], [25, 27, "left", 1], [24, 26, "right", 1], [26, 28, "right", 1],
  [27, 29, "left", 0.6], [29, 31, "left", 0.6], [27, 31, "left", 0.6],
  [28, 30, "right", 0.6], [30, 32, "right", 0.6], [28, 32, "right", 0.6],
];
// Main grossière du modèle corps : masquée quand le modèle mains a trouvé la main.
const BODY_HAND_BONES: [number, number, Side][] = [
  [15, 17, "left"], [15, 19, "left"], [17, 19, "left"], [15, 21, "left"],
  [16, 18, "right"], [16, 20, "right"], [18, 20, "right"], [16, 22, "right"],
];
const BODY_JOINTS: [number, Side][] = [
  [11, "left"], [13, "left"], [23, "left"], [25, "left"], [27, "left"],
  [12, "right"], [14, "right"], [24, "right"], [26, "right"], [28, "right"],
];
const BODY_WRIST: Record<Side, number> = { left: 15, right: 16 };
const HEAD_RING_SEGMENTS = 48;

const pairs = (c: { start: number; end: number }[]) => Uint16Array.from(c.flatMap((e) => [e.start, e.end]));
const HAND_EDGES = pairs(HandLandmarker.HAND_CONNECTIONS);
const HAND_TIPS = new Set([4, 8, 12, 16, 20]);
const FACE_MESH = pairs(FaceLandmarker.FACE_LANDMARKS_TESSELATION);
const FACE_OVAL = pairs(FaceLandmarker.FACE_LANDMARKS_FACE_OVAL);
const FACE_LIPS = pairs(FaceLandmarker.FACE_LANDMARKS_LIPS);
const FACE_EYES = pairs([...FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE]);
const FACE_BROWS = pairs([...FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW]);
const FACE_IRISES = pairs([...FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, ...FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS]);
// Arête et base du nez : rend le relief du visage lisible.
const FACE_NOSE = Uint16Array.from([168, 6, 6, 197, 197, 195, 195, 5, 5, 4, 98, 97, 97, 2, 2, 326, 326, 327]);
// Chaque iris avec les paupières (haut, bas) et les coins de son œil, pour mesurer l'ouverture.
const FACE_IRIS_EYES: [number, number, number, number, number][] = [
  [468, 159, 145, 33, 133],
  [473, 386, 374, 362, 263],
];
const FACE_MOUTH_TOP = 13;
const FACE_MOUTH_BOTTOM = 14;
const FACE_LEFT_CHEEK = 234;
const FACE_RIGHT_CHEEK = 454;

// Teintes d'expression.
const GOLD: RGB = hexToRgb("#ffc861");
const ANGER: RGB = hexToRgb("#ff4d5e");
const KISS: RGB = hexToRgb("#ff6fae");

/** Transformation image caméra normalisée → écran (px CSS) : x' = tx + sx·x, y' = ty + sy·y. */
export interface View {
  sx: number;
  tx: number;
  sy: number;
  ty: number;
}

export class FigureBuilder {
  private scratch = new Float32Array(0);
  private view: View = { sx: 1, tx: 0, sy: 1, ty: 0 };

  build(scene: Scene, now: number, view: View, out: SegmentBuffer): void {
    this.view = view;
    for (const body of scene.bodies) this.body(body, scene, now, out);
    for (const hand of scene.hands) this.hand(hand, scene, now, out);
    for (const face of scene.faces) this.face(face, now, out);
  }

  /** Projette tous les points d'un track dans un buffer partagé [x0, y0, x1, y1, …]. */
  private project(points: Float32Array): Float32Array {
    const n = points.length / STRIDE;
    if (this.scratch.length < n * 2) this.scratch = new Float32Array(n * 2);
    const s = this.scratch;
    const { sx, tx, sy, ty } = this.view;
    for (let i = 0; i < n; i++) {
      s[i * 2] = tx + sx * points[i * STRIDE];
      s[i * 2 + 1] = ty + sy * points[i * STRIDE + 1];
    }
    return s;
  }

  private body(body: Track, scene: Scene, now: number, out: SegmentBuffer): void {
    const fade = Scene.alpha(body, now);
    if (fade <= 0) return;
    const pal = PALETTES[body.color % PALETTES.length];
    const p = this.project(body.points);
    const vis = (i: number) => smoothstep(0.35, 0.85, body.points[i * STRIDE + 3]) * fade;
    const base = clamp(dist(p, 11, 12) * 0.022, 1.5, 5);
    const bone = (a: number, b: number, color: RGB, width: number, intensity: number) =>
      out.line(p[a * 2], p[a * 2 + 1], p[b * 2], p[b * 2 + 1], width, color, intensity);

    // Tête : un cercle quand le visage n'est pas suivi (sinon le maillage du visage la dessine).
    // Pas de cou : la tête flotte au-dessus des épaules.
    let face: Track | undefined;
    for (const f of scene.faces) if (f.owner === body.key && Scene.alpha(f, now) > 0) face = f;
    const headVis = Math.min(vis(7), vis(8));
    if (!face && headVis > 0) {
      const hx = (p[14] + p[16]) / 2;
      const hy = (p[15] + p[17]) / 2;
      const r = dist(p, 7, 8) * 0.75;
      for (let k = 0; k < HEAD_RING_SEGMENTS; k++) {
        const t0 = (k / HEAD_RING_SEGMENTS) * Math.PI * 2;
        const t1 = ((k + 1) / HEAD_RING_SEGMENTS) * Math.PI * 2;
        out.line(hx + Math.cos(t0) * r, hy + Math.sin(t0) * r, hx + Math.cos(t1) * r, hy + Math.sin(t1) * r, base * 0.8, pal.center, headVis);
      }
    }

    for (const [a, b, side, w] of BODY_BONES) {
      const v = Math.min(vis(a), vis(b));
      if (v > 0) bone(a, b, pal[side], base * w, v);
    }
    const hands = new Set<Side>();
    for (const h of scene.hands) if (h.owner === body.key && h.side && Scene.alpha(h, now) > 0) hands.add(h.side);
    for (const [a, b, side] of BODY_HAND_BONES) {
      const v = Math.min(vis(a), vis(b));
      if (v > 0 && !hands.has(side)) bone(a, b, pal[side], base * 0.45, v);
    }
    for (const [i, side] of BODY_JOINTS) {
      if (vis(i) > 0) out.dot(p[i * 2], p[i * 2 + 1], base * 2.2, pal[side], vis(i) * 1.2);
    }
    for (const side of ["left", "right"] as const) {
      const i = BODY_WRIST[side];
      if (vis(i) > 0 && !hands.has(side)) out.dot(p[i * 2], p[i * 2 + 1], base * 2.2, pal[side], vis(i) * 1.2);
    }
  }

  private hand(hand: Track, scene: Scene, now: number, out: SegmentBuffer): void {
    const a = Scene.alpha(hand, now);
    if (a <= 0) return;
    const color = PALETTES[hand.color % PALETTES.length][hand.side ?? "left"];
    const p = this.project(hand.points);
    // Main perdue (geste trop rapide, flou) : elle suit le poignet du squelette en attendant.
    const wrist = hand.lostAnchor && scene.wristOf(hand);
    if (hand.lostAnchor && wrist) {
      const dx = (wrist[0] - hand.lostAnchor[0]) * this.view.sx;
      const dy = (wrist[1] - hand.lostAnchor[1]) * this.view.sy;
      for (let i = 0; i < 21; i++) {
        p[i * 2] += dx;
        p[i * 2 + 1] += dy;
      }
    }
    const w = clamp(dist(p, 0, 9) * 0.03, 1, 4);

    this.edges(p, HAND_EDGES, w, color, a, out);
    for (let i = 0; i < 21; i++) {
      const tip = HAND_TIPS.has(i);
      out.dot(p[i * 2], p[i * 2 + 1], w * (tip ? 3 : 2), color, a * (tip ? 1.5 : 1));
    }
  }

  /**
   * Visage : maillage sculpté par la profondeur, traits du visage mis en lumière,
   * et réactions aux expressions (sourire doré, bouche qui s'illumine, sourcils qui s'allument…).
   */
  private face(face: Track, now: number, out: SegmentBuffer): void {
    const a = Scene.alpha(face, now);
    if (a <= 0) return;
    const pal = PALETTES[face.color % PALETTES.length];
    const pts = face.points;
    const p = this.project(pts);
    const size = dist(p, FACE_LEFT_CHEEK, FACE_RIGHT_CHEEK);
    const w = clamp(size * 0.006, 0.8, 3);
    const ex = (e: Expression) => Scene.expression(face, e);
    const smile = ex("smile");
    const jaw = ex("jawOpen");
    const browUp = ex("browUp");
    const browDown = ex("browDown");
    const eyeWide = ex("eyeWide");
    const pucker = ex("pucker");
    const cheekPuff = ex("cheekPuff");

    // 1. Maillage : les zones proches de la caméra (nez, pommettes) brillent plus que les bords.
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 2; i < pts.length; i += STRIDE) {
      zMin = Math.min(zMin, pts[i]);
      zMax = Math.max(zMax, pts[i]);
    }
    const zRange = Math.max(zMax - zMin, 1e-6);
    const meshWidth = Math.max(0.5, size * 0.002);
    const meshGain = a * (1 + cheekPuff * 1.5);
    for (let k = 0; k < FACE_MESH.length; k += 2) {
      const i = FACE_MESH[k];
      const j = FACE_MESH[k + 1];
      const near = 1 - ((pts[i * STRIDE + 2] + pts[j * STRIDE + 2]) / 2 - zMin) / zRange;
      out.line(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], meshWidth, pal.left, meshGain * (0.012 + 0.09 * near * near));
    }

    // 2. Structure : ovale et nez.
    this.edges(p, FACE_OVAL, w * 0.9, pal.left, a * 0.5, out);
    this.edges(p, FACE_NOSE, w * 0.7, pal.center, a * 0.45, out);

    // 3. Sourcils : s'allument quand on les lève, virent au rouge quand on les fronce.
    const browColor = mix(pal.center, ANGER, browDown * 0.9);
    this.edges(p, FACE_BROWS, w * (1 + browUp * 0.8), browColor, a * (0.7 + browUp * 1.5 + browDown * 0.8), out);

    // 4. Yeux et iris : l'iris s'éteint quand la paupière se ferme (clin d'œil visible).
    this.edges(p, FACE_EYES, w, pal.left, a * (0.9 + eyeWide), out);
    if (pts.length / STRIDE > 468) {
      this.edges(p, FACE_IRISES, w * 0.8, pal.right, a * 0.8, out);
      for (const [iris, top, bottom, c1, c2] of FACE_IRIS_EYES) {
        const openness = dist(p, top, bottom) / Math.max(dist(p, c1, c2), 1);
        const open = smoothstep(0.08, 0.2, openness);
        if (open > 0) out.dot(p[iris * 2], p[iris * 2 + 1], w * 2.6, pal.right, a * open * (1.5 + eyeWide));
      }
    }

    // 5. Bouche : dorée et plus vive avec le sourire, rose en bisou, lumière quand elle s'ouvre.
    const lipColor = mix(mix(pal.right, GOLD, smile), KISS, pucker * 0.8);
    this.edges(p, FACE_LIPS, w * (1 + smile * 0.6 + jaw * 0.5), lipColor, a * (1 + smile * 1.5 + jaw + pucker * 0.8), out);
    if (jaw > 0.12) {
      const mx = (p[FACE_MOUTH_TOP * 2] + p[FACE_MOUTH_BOTTOM * 2]) / 2;
      const my = (p[FACE_MOUTH_TOP * 2 + 1] + p[FACE_MOUTH_BOTTOM * 2 + 1]) / 2;
      const opening = dist(p, FACE_MOUTH_TOP, FACE_MOUTH_BOTTOM);
      out.dot(mx, my, opening * 0.9 + w * 2, lipColor, a * (jaw - 0.12) * 1.4);
    }
  }

  private edges(p: Float32Array, edges: Uint16Array, width: number, color: RGB, intensity: number, out: SegmentBuffer): void {
    for (let k = 0; k < edges.length; k += 2) {
      const i = edges[k];
      const j = edges[k + 1];
      out.line(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1], width, color, intensity);
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const dist = (p: Float32Array, i: number, j: number) => Math.hypot(p[i * 2] - p[j * 2], p[i * 2 + 1] - p[j * 2 + 1]);

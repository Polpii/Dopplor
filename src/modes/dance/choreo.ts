// Chorégraphie du mode danse : des poses clés posées sur les temps de la musique, le double qui
// passe de l'une à l'autre, et la note de la personne à chaque pose marquée.
//
// Repère des poses : celui du miroir (ce que voit la personne) ; x vers la droite de l'écran,
// y vers le bas, en largeurs d'épaules, origine au milieu des épaules. Dans un miroir, la main
// droite apparaît à droite : « R » est à droite de l'écran. On danse côte à côte face au miroir,
// comme dans une salle de danse : quand le double lève le bras droit, on lève le bras droit.
//
// Angles des membres (degrés), absolus : 0 = vers le bas, 90 = à l'horizontale vers l'extérieur,
// 180 = vers le haut, négatif = vers l'intérieur (devant le corps).
import { SONG_BARS } from "./music";

export interface KeyPose {
  aL: number; // bras gauche (épaule → coude)
  fL: number; // avant-bras gauche (coude → poignet)
  aR: number;
  fR: number;
  tL?: number; // cuisse gauche (hanche → genou)
  sL?: number; // tibia gauche (genou → cheville)
  tR?: number;
  sR?: number;
  /** Buste penché vers la droite de l'écran (degrés). */
  tilt?: number;
  /** Tout le corps décalé vers la droite (largeurs d'épaules). */
  sway?: number;
  /** Genoux pliés (descend le corps, largeurs d'épaules). */
  dip?: number;
  /** Les jambes comptent dans la note (sinon seulement les bras et le buste). */
  legs?: boolean;
}

const LEG = 6; // jambes légèrement écartées
const REST: KeyPose = { aL: 12, fL: 8, aR: 12, fR: 8 };
const HIPS: KeyPose = { aL: 42, fL: -55, aR: 42, fR: -55 };
const V: KeyPose = { aL: 150, fL: 155, aR: 150, fR: 155 };
const T: KeyPose = { aL: 90, fL: 90, aR: 90, fR: 90 };
const CACTUS: KeyPose = { aL: 90, fL: 180, aR: 90, fR: 180 };
const CACTUS_DOWN: KeyPose = { aL: 90, fL: 0, aR: 90, fR: 0 };
const WAVE_R: KeyPose = { aL: 90, fL: 45, aR: 90, fR: 135, tilt: -4 };
const DISCO_UP: KeyPose = { aL: 42, fL: -55, aR: 145, fR: 145, tilt: -8 };
const DISCO_DOWN: KeyPose = { aL: 42, fL: -55, aR: -25, fR: -35, tilt: 6, dip: 0.06 };
const PUSH_R: KeyPose = { aL: 30, fL: -100, aR: 90, fR: 90 };
const CLAP_UP: KeyPose = { aL: 165, fL: 195, aR: 165, fR: 195 };
const LOW: KeyPose = { aL: 50, fL: 58, aR: 50, fR: 58, dip: 0.1 };
const LEAN_R: KeyPose = { ...HIPS, sway: 0.12, tilt: -9 };
const LEG_R: KeyPose = { aL: 150, fL: 150, aR: 20, fR: 10, tR: 42, sR: 36, tilt: -6, legs: true };
const STAR: KeyPose = { aL: 130, fL: 130, aR: 130, fR: 130, tL: 22, sL: 22, tR: 22, sR: 22, legs: true };

/** La même pose de l'autre côté. */
function mirror(p: KeyPose): KeyPose {
  return {
    aL: p.aR, fL: p.fR, aR: p.aL, fR: p.fL,
    tL: p.tR, sL: p.sR, tR: p.tL, sR: p.sL,
    tilt: p.tilt !== undefined ? -p.tilt : undefined,
    sway: p.sway !== undefined ? -p.sway : undefined,
    dip: p.dip,
    legs: p.legs,
  };
}

interface Key {
  beat: number; // dans le mouvement (0 à 7)
  pose: KeyPose;
  hit?: boolean; // pose notée
  snap?: boolean; // arrivée sèche (le mouvement part au dernier moment)
}
interface Move {
  name: string;
  keys: Key[];
}

const MOVES: Record<string, Move> = {
  balance: { name: "Balance", keys: [0, 2, 4, 6].map((b, i) => ({ beat: b, pose: i % 2 ? LEAN_R : mirror(LEAN_R), hit: true })) },
  v: { name: "Bras en V", keys: [{ beat: 0, pose: V, hit: true, snap: true }, { beat: 2, pose: REST }, { beat: 4, pose: V, hit: true, snap: true }, { beat: 6, pose: REST }] },
  robot: {
    name: "Robot",
    keys: [CACTUS, CACTUS_DOWN, CACTUS, CACTUS_DOWN, T, CACTUS, T, CACTUS].map((pose, b) => ({ beat: b, pose, hit: true, snap: true })),
  },
  wave: { name: "Vague", keys: [0, 2, 4, 6].map((b, i) => ({ beat: b, pose: i % 2 ? mirror(WAVE_R) : WAVE_R, hit: true })) },
  discoR: {
    name: "Disco",
    keys: [0, 1, 2, 3, 4, 5, 6, 7].map((b) => (b % 2 ? { beat: b, pose: DISCO_DOWN, snap: true } : { beat: b, pose: DISCO_UP, hit: true, snap: true })),
  },
  discoL: {
    name: "Disco, à gauche",
    keys: [0, 1, 2, 3, 4, 5, 6, 7].map((b) => (b % 2 ? { beat: b, pose: mirror(DISCO_DOWN), snap: true } : { beat: b, pose: mirror(DISCO_UP), hit: true, snap: true })),
  },
  push: { name: "Pousse", keys: [0, 2, 4, 6].map((b, i) => ({ beat: b, pose: i % 2 ? mirror(PUSH_R) : PUSH_R, hit: true, snap: true })) },
  // Les poses « bras en bas » ne sont pas notées : rester immobile les réussirait.
  clap: { name: "Clap", keys: [0, 2, 4, 6].map((b, i) => ({ beat: b, pose: i % 2 ? LOW : CLAP_UP, hit: i % 2 === 0, snap: true })) },
  bigV: { name: "Grand V", keys: [{ beat: 0, pose: REST }, { beat: 3, pose: V, hit: true }, { beat: 5, pose: T, hit: true }, { beat: 7, pose: LOW }] },
  star: { name: "Étoile", keys: [{ beat: 0, pose: STAR, hit: true }, { beat: 2, pose: HIPS }, { beat: 4, pose: STAR, hit: true }, { beat: 6, pose: HIPS }] },
  leg: { name: "Jambe", keys: [{ beat: 0, pose: LEG_R, hit: true }, { beat: 2, pose: REST }, { beat: 4, pose: mirror(LEG_R), hit: true }, { beat: 6, pose: REST }] },
  finale: { name: "Final !", keys: [{ beat: 0, pose: STAR, hit: true, snap: true }] },
};

/** [mesure de départ, mouvement] : chaque mouvement dure 2 mesures (8 temps). */
const SCRIPT: [number, string][] = [
  [4, "balance"], [6, "v"], [8, "robot"], [10, "wave"],
  [12, "discoR"], [14, "discoL"], [16, "push"], [18, "clap"],
  [20, "bigV"], [22, "star"],
  [24, "leg"], [26, "robot"], [28, "discoR"], [30, "clap"],
  [32, "finale"],
];

export interface Hit {
  beat: number;
  pose: KeyPose;
  move: string;
}

interface AbsKey extends Key {
  abs: number;
}

export class Choreography {
  readonly hits: Hit[] = [];
  /** [temps de début, nom] des mouvements. */
  readonly moves: { beat: number; name: string }[] = [];
  private keys: AbsKey[] = [];

  constructor() {
    this.keys.push({ abs: 0, beat: 0, pose: REST }, { abs: 8, beat: 0, pose: REST }, { abs: 12, beat: 0, pose: HIPS });
    for (const [bar, id] of SCRIPT) {
      const move = MOVES[id];
      this.moves.push({ beat: bar * 4, name: move.name });
      for (const k of move.keys) {
        const abs = bar * 4 + k.beat;
        this.keys.push({ ...k, abs });
        if (k.hit) this.hits.push({ beat: abs, pose: k.pose, move: move.name });
      }
    }
    this.keys.push({ abs: SONG_BARS * 4, beat: 0, pose: STAR });
  }

  /** Pose du double au temps `beat` (fractionnaire), avec le rebond des genoux sur chaque temps. */
  poseAt(beat: number): KeyPose {
    const keys = this.keys;
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].abs <= beat) i++;
    const a = keys[i];
    const b = keys[Math.min(keys.length - 1, i + 1)];
    const u = b.abs > a.abs ? Math.min(1, Math.max(0, (beat - a.abs) / (b.abs - a.abs))) : 1;
    // Arrivée sèche : on tient la pose, puis on part au dernier moment ; sinon un mouvement souple.
    const k = b.snap ? easeOutCubic(Math.min(1, Math.max(0, (u - 0.5) / 0.5))) : easeInOutSine(u);
    const pose = lerpPose(a.pose, b.pose, k);
    // Rebond : les genoux plient sur chaque temps (on danse même quand les bras ne bougent pas).
    const phase = beat - Math.floor(beat);
    pose.dip = (pose.dip ?? 0) + 0.035 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2));
    return pose;
  }

  /** Mouvement en cours (nom) au temps `beat`. */
  moveAt(beat: number): string | null {
    let name: string | null = null;
    for (const m of this.moves) if (m.beat <= beat + 0.5) name = m.name;
    return name;
  }
}

/** Invitation quand on attend quelqu'un : le double lève les bras, pour montrer comment lancer. */
export function invitePose(beat: number): KeyPose {
  const cycle = beat % 8;
  const up = cycle < 4 ? easeInOutSine(Math.min(1, cycle / 1.5)) : 1 - easeInOutSine(Math.min(1, (cycle - 4) / 1.5));
  const pose = lerpPose(HIPS, V, up);
  const phase = beat - Math.floor(beat);
  pose.dip = 0.03 * (0.5 + 0.5 * Math.cos(phase * Math.PI * 2));
  return pose;
}

function lerpPose(a: KeyPose, b: KeyPose, k: number): KeyPose {
  const m = (x: number | undefined, y: number | undefined, d: number) => (x ?? d) + ((y ?? d) - (x ?? d)) * k;
  return {
    aL: m(a.aL, b.aL, 0), fL: m(a.fL, b.fL, 0), aR: m(a.aR, b.aR, 0), fR: m(a.fR, b.fR, 0),
    tL: m(a.tL, b.tL, LEG), sL: m(a.sL, b.sL, LEG / 2), tR: m(a.tR, b.tR, LEG), sR: m(a.sR, b.sR, LEG / 2),
    tilt: m(a.tilt, b.tilt, 0), sway: m(a.sway, b.sway, 0), dip: m(a.dip, b.dip, 0),
    legs: k < 0.5 ? a.legs : b.legs,
  };
}

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// --- Squelette du double ----------------------------------------------------------------------

const UPPER_ARM = 0.62;
const FOREARM = 0.58;
const THIGH = 0.9;
const SHIN = 0.85;
const TORSO = 1.55;

/** Les 33 points MediaPipe d'une pose (repère du miroir, largeurs d'épaules). */
export function skeleton(p: KeyPose): [number, number][] {
  const pts: [number, number][] = new Array(33).fill(0).map(() => [0, 0]);
  const rad = Math.PI / 180;
  const dir = (deg: number, side: number): [number, number] => [side * Math.sin(deg * rad), Math.cos(deg * rad)];
  const add = (a: [number, number], d: [number, number], len: number): [number, number] => [a[0] + d[0] * len, a[1] + d[1] * len];
  const sway = p.sway ?? 0;
  const dip = p.dip ?? 0;
  const tilt = (p.tilt ?? 0) * rad;
  const hip: [number, number] = [sway, TORSO + dip];
  // Haut du corps : tourné autour des hanches selon l'inclinaison du buste.
  const rot = (x: number, y: number): [number, number] => {
    const dx = x, dy = y - TORSO;
    return [hip[0] + dx * Math.cos(tilt) - dy * Math.sin(tilt), hip[1] + dx * Math.sin(tilt) + dy * Math.cos(tilt)];
  };
  // Tête : nez, yeux (intérieur, centre, extérieur), oreilles, bouche. Gauche = gauche de l'écran.
  pts[0] = rot(0, -0.55);
  pts[1] = rot(-0.05, -0.62); pts[2] = rot(-0.09, -0.62); pts[3] = rot(-0.13, -0.62);
  pts[4] = rot(0.05, -0.62); pts[5] = rot(0.09, -0.62); pts[6] = rot(0.13, -0.62);
  pts[7] = rot(-0.2, -0.57); pts[8] = rot(0.2, -0.57);
  pts[9] = rot(-0.06, -0.46); pts[10] = rot(0.06, -0.46);
  pts[11] = rot(-0.5, 0); pts[12] = rot(0.5, 0);
  for (const [side, s, e, w, pinky, index, thumb, a, f] of [
    [-1, 11, 13, 15, 17, 19, 21, p.aL, p.fL],
    [1, 12, 14, 16, 18, 20, 22, p.aR, p.fR],
  ] as const) {
    pts[e] = add(pts[s], dir(a, side), UPPER_ARM);
    pts[w] = add(pts[e], dir(f, side), FOREARM);
    const d = dir(f, side);
    const perp: [number, number] = [-d[1] * side, d[0] * side];
    pts[index] = add(add(pts[w], d, 0.16), perp, -0.04);
    pts[pinky] = add(add(pts[w], d, 0.14), perp, 0.05);
    pts[thumb] = add(add(pts[w], d, 0.08), perp, -0.09);
  }
  pts[23] = [hip[0] - 0.33, hip[1]];
  pts[24] = [hip[0] + 0.33, hip[1]];
  for (const [side, h, k, an, heel, toe, t, s] of [
    [-1, 23, 25, 27, 29, 31, p.tL ?? LEG, p.sL ?? LEG / 2],
    [1, 24, 26, 28, 30, 32, p.tR ?? LEG, p.sR ?? LEG / 2],
  ] as const) {
    // Genoux légèrement pliés quand on descend.
    pts[k] = add(pts[h], dir(t + dip * 60, side), THIGH);
    pts[an] = add(pts[k], dir(s - dip * 60, side), SHIN);
    pts[heel] = [pts[an][0] - side * 0.03, pts[an][1] + 0.06];
    pts[toe] = [pts[an][0] + side * 0.14, pts[an][1] + 0.08];
  }
  return pts;
}

// --- Note ---------------------------------------------------------------------------------------

/** Segments comparés : [début, fin, poids]. */
const ARMS: [number, number, number][] = [
  [11, 13, 1], [13, 15, 0.8], [12, 14, 1], [14, 16, 0.8],
];
const LEGS: [number, number, number][] = [
  [23, 25, 0.6], [25, 27, 0.5], [24, 26, 0.6], [26, 28, 0.5],
];
/** En dessous, un segment est parfait ; au-dessus de PERFECT + RANGE, il ne compte plus. */
const PERFECT_DEG = 20;
const RANGE_DEG = 50;

/**
 * Ressemblance (0–1) entre la personne et une pose : direction de chaque bras (et des jambes si
 * la pose les fait compter et qu'elles sont visibles), et l'inclinaison du buste quand la pose
 * penche. `user(i)` : point i de la personne dans le repère du miroir (px), ou null si mal vu.
 */
export function poseScore(user: (i: number) => [number, number] | null, pose: KeyPose): number {
  const target = skeleton(pose);
  const dir = (a: [number, number], b: [number, number]) => {
    const d = [b[0] - a[0], b[1] - a[1]];
    const n = Math.hypot(d[0], d[1]) || 1;
    return [d[0] / n, d[1] / n];
  };
  const segScore = (u: number[], t: number[]) => {
    const cos = Math.max(-1, Math.min(1, u[0] * t[0] + u[1] * t[1]));
    const deg = (Math.acos(cos) * 180) / Math.PI;
    return Math.max(0, Math.min(1, 1 - (deg - PERFECT_DEG) / RANGE_DEG));
  };
  let sum = 0;
  let weight = 0;
  const segs = pose.legs ? [...ARMS, ...LEGS] : ARMS;
  for (const [a, b, w] of segs) {
    const ua = user(a);
    const ub = user(b);
    const isLeg = a >= 23;
    if (!ua || !ub) {
      if (isLeg) continue; // jambes hors champ : on ne les compte pas
      weight += w; // bras mal vu : compte comme raté
      continue;
    }
    sum += w * segScore(dir(ua, ub), dir(target[a], target[b]));
    weight += w;
  }
  // Buste penché : milieu des hanches → milieu des épaules.
  if (Math.abs(pose.tilt ?? 0) >= 6) {
    const pts = [11, 12, 23, 24].map(user);
    if (pts.every(Boolean)) {
      const [l, r, hl, hr] = pts as [number, number][];
      const mid = (x: [number, number], y: [number, number]): [number, number] => [(x[0] + y[0]) / 2, (x[1] + y[1]) / 2];
      const u = dir(mid(hl, hr), mid(l, r));
      const t = dir(mid(target[23], target[24]), mid(target[11], target[12]));
      // Le buste penche peu : tolérance plus fine.
      const deg = (Math.acos(Math.max(-1, Math.min(1, u[0] * t[0] + u[1] * t[1]))) * 180) / Math.PI;
      sum += 0.8 * Math.max(0, Math.min(1, 1 - (deg - 4) / 12));
      weight += 0.8;
    }
  }
  return weight ? sum / weight : 0;
}

export type Rating = "parfait" | "super" | "bien" | "oups";
export const RATINGS: { rating: Rating; min: number; label: string; points: number }[] = [
  { rating: "parfait", min: 0.82, label: "Parfait !", points: 100 },
  { rating: "super", min: 0.66, label: "Super", points: 70 },
  { rating: "bien", min: 0.45, label: "Bien", points: 40 },
  { rating: "oups", min: -1, label: "Oups", points: 0 },
];
export const rate = (score: number) => RATINGS.find((r) => score >= r.min)!;

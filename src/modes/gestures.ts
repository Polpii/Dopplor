// Lecture des gestes de la main à partir des 21 points MediaPipe (repère image caméra, 0–1),
// et détection du geste d'appel du menu : lever la main ouverte, paume vers le miroir, et la
// tenir un instant (un anneau se remplit autour de la paume pendant ce temps).
import { Scene, type Track } from "../scene";
import { STRIDE } from "../vision/protocol";

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_TIP = 8;
const MIDDLE_BASE = 9;
/** [bout, articulation du milieu] de l'index, du majeur, de l'annulaire et de l'auriculaire. */
const FINGERS: [number, number][] = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];
const SHOULDER = { left: 11, right: 12 };

export interface HandState {
  track: Track;
  /** Nombre de doigts tendus (sans le pouce). */
  extended: number;
  /** Main ouverte : au moins trois doigts tendus (tolère un doigt mal vu). */
  open: boolean;
  /** Vrai poing : les quatre doigts repliés. Pointer de l'index n'est pas un poing. */
  fist: boolean;
  /** Doigts vers le haut (main levée, pas pendante ni à plat). */
  upright: boolean;
  /** Pouce et index qui se touchent. */
  pinch: boolean;
  /** Centre de la paume, bout de l'index (image caméra, 0–1). */
  palm: [number, number];
  index: [number, number];
  /** Centre de la paume en px de l'image caméra. */
  palmPx: [number, number];
  /** Taille de la paume (px de l'image) et largeur d'épaules (px), pour des seuils à l'échelle. */
  palmSize: number;
  bodyScale: number;
  /** Hauteur du poignet par rapport aux épaules, en largeurs d'épaules (négatif = au-dessus).
   * Sans corps suivi : depuis le haut de l'image, à la même échelle. */
  height: number;
  /** Vrai si la hauteur est mesurée par rapport aux épaules. */
  anchored: boolean;
}

type Vec = [number, number];

/** État de chaque main réellement détectée. `w`, `h` : taille de l'image caméra (px). */
export function handStates(scene: Scene, now: number, w: number, h: number): HandState[] {
  const states: HandState[] = [];
  for (const hand of scene.hands) {
    if (Scene.alpha(hand, now) < 0.9 || hand.lostAt !== null) continue;
    const at = (i: number): Vec => [hand.points[i * STRIDE] * w, hand.points[i * STRIDE + 1] * h];
    const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const wrist = at(WRIST);
    const mid = at(MIDDLE_BASE);
    const palmSize = Math.max(dist(wrist, mid), 1);
    // Un doigt est tendu si son bout est nettement plus loin du poignet que son articulation,
    // replié si son bout est revenu plus près du poignet que l'articulation.
    const extended = FINGERS.filter(([tip, pip]) => dist(at(tip), wrist) > dist(at(pip), wrist) * 1.15).length;
    const curled = FINGERS.filter(([tip, pip]) => dist(at(tip), wrist) < dist(at(pip), wrist) * 1.02).length;

    let bodyScale = palmSize * 3.5;
    let height = wrist[1] / bodyScale;
    let anchored = false;
    const body = hand.owner ? scene.tracks.pose.get(hand.owner) : undefined;
    if (body && hand.side) {
      const b = (i: number): Vec => [body.points[i * STRIDE] * w, body.points[i * STRIDE + 1] * h];
      bodyScale = Math.max(dist(b(11), b(12)), palmSize * 2);
      height = (wrist[1] - b(SHOULDER[hand.side])[1]) / bodyScale;
      anchored = true;
    }
    // Doigts vers le haut : poignet → base du majeur à moins de ~50° de la verticale.
    const up: Vec = [mid[0] - wrist[0], mid[1] - wrist[1]];
    const palmPx: Vec = [(mid[0] + wrist[0]) / 2, (mid[1] + wrist[1]) / 2];
    states.push({
      track: hand,
      extended,
      open: extended >= 3,
      fist: curled === 4,
      upright: up[1] < 0 && Math.abs(up[0]) < -up[1] * 1.2,
      pinch: dist(at(THUMB_TIP), at(INDEX_TIP)) < palmSize * 0.35,
      palm: [palmPx[0] / w, palmPx[1] / h],
      index: [hand.points[INDEX_TIP * STRIDE], hand.points[INDEX_TIP * STRIDE + 1]],
      palmPx,
      palmSize,
      bodyScale,
      height,
      anchored,
    });
  }
  return states;
}

/** Temps à tenir la main levée pour appeler le menu. */
export const SUMMON_MS = 800;
/** Hauteur maximale du poignet (largeurs d'épaules sous les épaules) : à peu près mi-poitrine. */
const SUMMON_HEIGHT = 0.7;
/** Immobile : la paume bouge de moins de ça (largeurs d'épaules) sur STILL_MS. */
const STILL_DISTANCE = 0.15;
const STILL_MS = 250;
/** Main qui bouge ou qui descend : la progression redescend (on renonce en bougeant). */
const DECAY_MS = 400;
/** Forme de la main mal vue un instant (un doigt caché, flou) : la progression attend sans reculer. */
const SHAPE_GRACE_MS = 350;

/**
 * Appel du menu : main ouverte, doigts vers le haut, levée au moins à mi-poitrine, et tenue
 * immobile ~0,9 s. Agiter la main, la lever en passant, la laisser pendre ouverte ou faire un
 * signe ne suffit pas : il faut la poser là et attendre. La progression est visible (anneau
 * autour de la paume), donc on comprend ce qui se passe et on peut renoncer en bougeant.
 */
export class PalmHold {
  private hands = new Map<string, { progress: number; last: number; shapeOk: number; trail: { t: number; x: number; y: number }[] }>();

  update(hands: HandState[], now: number): { hand: HandState | null; progress: number; triggered: HandState | null } {
    let best: { hand: HandState; progress: number } | null = null;
    let triggered: HandState | null = null;
    const seen = new Set<string>();
    for (const hand of hands) {
      const key = hand.track.key;
      seen.add(key);
      const s = this.hands.get(key) ?? { progress: 0, last: now, shapeOk: -Infinity, trail: [] };
      const dt = Math.min(100, now - s.last);
      s.last = now;
      s.trail.push({ t: now, x: hand.palmPx[0], y: hand.palmPx[1] });
      while (s.trail.length > 1 && now - s.trail[0].t > STILL_MS) s.trail.shift();
      const moved = Math.hypot(hand.palmPx[0] - s.trail[0].x, hand.palmPx[1] - s.trail[0].y) / hand.bodyScale;
      const raised = !hand.anchored || hand.height < SUMMON_HEIGHT;
      const observed = now - s.trail[0].t >= STILL_MS * 0.8;
      const placed = raised && observed && moved < STILL_DISTANCE;
      const shape = hand.open && hand.upright;
      if (shape) s.shapeOk = now;
      if (placed && shape) s.progress += dt / SUMMON_MS;
      else if (!placed || now - s.shapeOk > SHAPE_GRACE_MS) s.progress = Math.max(0, s.progress - dt / DECAY_MS);
      this.hands.set(key, s);
      if (s.progress >= 1) {
        triggered = hand;
        s.progress = 0;
      } else if (s.progress > 0 && (!best || s.progress > best.progress)) best = { hand, progress: s.progress };
    }
    for (const key of [...this.hands.keys()]) if (!seen.has(key)) this.hands.delete(key);
    if (triggered) for (const s of this.hands.values()) s.progress = 0;
    return { hand: best?.hand ?? null, progress: best?.progress ?? 0, triggered };
  }

  reset(): void {
    this.hands.clear();
  }
}

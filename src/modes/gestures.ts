// Lecture des gestes de la main à partir des 21 points MediaPipe (repère image caméra, 0–1),
// et détection du geste d'ouverture du menu (inspiré du « bloom » de la HoloLens) :
// la main monte fermée, puis s'ouvre d'un coup.
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
  open: boolean;
  closed: boolean;
  /** Pouce et index qui se touchent. */
  pinch: boolean;
  /** Centre de la paume, bout de l'index (image caméra, 0–1). */
  palm: [number, number];
  index: [number, number];
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
    const palmSize = Math.max(dist(wrist, at(MIDDLE_BASE)), 1);
    // Un doigt est tendu si son bout est nettement plus loin du poignet que son articulation.
    const extended = FINGERS.filter(([tip, pip]) => dist(at(tip), wrist) > dist(at(pip), wrist) * 1.15).length;

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
    const mid = at(MIDDLE_BASE);
    states.push({
      track: hand,
      extended,
      open: extended === 4,
      closed: extended <= 1,
      pinch: dist(at(THUMB_TIP), at(INDEX_TIP)) < palmSize * 0.35,
      palm: [(mid[0] + wrist[0]) / 2 / w, (mid[1] + wrist[1]) / 2 / h],
      index: [hand.points[INDEX_TIP * STRIDE], hand.points[INDEX_TIP * STRIDE + 1]],
      palmSize,
      bodyScale,
      height,
      anchored,
    });
  }
  return states;
}

/**
 * Geste d'ouverture du menu, en deux temps qui doivent s'enchaîner :
 *   1. la main monte, fermée (au moins 0,5 largeur d'épaules en moins d'une seconde) ;
 *   2. puis elle s'ouvre (fermée → ouverte en moins de 0,6 s), au niveau des épaules ou plus haut.
 * Lever une main déjà ouverte, ou l'ouvrir sans l'avoir montée, ne déclenche rien.
 */
export class BloomGesture {
  private history = new Map<string, { t: number; height: number; closed: boolean; open: boolean }[]>();

  /** Progression du geste (0 → 1) par main, et la main qui vient de le réussir. */
  update(hands: HandState[], now: number): { triggered: HandState | null; rising: HandState | null } {
    let triggered: HandState | null = null;
    let rising: HandState | null = null;
    const seen = new Set<string>();
    for (const hand of hands) {
      const key = hand.track.key;
      seen.add(key);
      const hist = this.history.get(key) ?? [];
      hist.push({ t: now, height: hand.height, closed: hand.closed, open: hand.open });
      while (hist.length && now - hist[0].t > 1600) hist.shift();
      this.history.set(key, hist);

      // Dernier instant où la main était fermée, et la montée qui l'a précédé.
      let lastClosed = -1;
      for (let i = hist.length - 1; i >= 0; i--) if (hist[i].closed) { lastClosed = i; break; }
      if (lastClosed < 0) continue;
      const closedAt = hist[lastClosed];
      let lowest = closedAt.height;
      for (let i = 0; i <= lastClosed; i++) if (closedAt.t - hist[i].t <= 1000) lowest = Math.max(lowest, hist[i].height);
      const rise = lowest - closedAt.height; // les hauteurs croissent vers le bas
      if (hand.closed && rise > 0.25) rising = hand;
      if (hand.open && rise >= 0.5 && now - closedAt.t <= 600 && (!hand.anchored || hand.height < 0.3)) {
        triggered = hand;
        this.history.set(key, []); // un seul déclenchement par geste
      }
    }
    for (const key of [...this.history.keys()]) if (!seen.has(key)) this.history.delete(key);
    return { triggered, rising };
  }
}

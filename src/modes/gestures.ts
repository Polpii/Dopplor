// Lecture des gestes de la main à partir des 21 points MediaPipe (repère image caméra, 0–1).
import { Scene, type Track } from "../scene";
import { STRIDE } from "../vision/protocol";

const WRIST = 0;
/** [bout, articulation du milieu] de l'index, du majeur, de l'annulaire et de l'auriculaire. */
const FINGERS: [number, number][] = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];
const INDEX_TIP = 8;
const MIDDLE_BASE = 9;
const SHOULDER = { left: 11, right: 12 };

export interface HandState {
  track: Track;
  /** Nombre de doigts tendus (sans le pouce). */
  extended: number;
  /** Main ouverte : les quatre doigts tendus. */
  open: boolean;
  /** Main levée : poignet au-dessus de l'épaule du même côté. */
  raised: boolean;
  /** Centre de la paume et bout de l'index (image caméra, 0–1). */
  palm: [number, number];
  index: [number, number];
}

const at = (t: Track, i: number): [number, number] => [t.points[i * STRIDE], t.points[i * STRIDE + 1]];
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** État de chaque main visible (et réellement détectée, pas en train de disparaître). */
export function handStates(scene: Scene, now: number): HandState[] {
  const states: HandState[] = [];
  for (const hand of scene.hands) {
    if (Scene.alpha(hand, now) < 0.9 || hand.lostAt !== null) continue;
    const wrist = at(hand, WRIST);
    // Un doigt est tendu si son bout est nettement plus loin du poignet que son articulation.
    const extended = FINGERS.filter(([tip, pip]) => dist(at(hand, tip), wrist) > dist(at(hand, pip), wrist) * 1.15).length;
    let raised = false;
    const body = hand.owner ? scene.tracks.pose.get(hand.owner) : undefined;
    if (body && hand.side) {
      const shoulderY = body.points[SHOULDER[hand.side] * STRIDE + 1];
      raised = wrist[1] < shoulderY;
    } else {
      raised = wrist[1] < 0.4; // sans corps suivi : haut de l'image
    }
    const palm = at(hand, MIDDLE_BASE);
    states.push({
      track: hand,
      extended,
      open: extended === 4,
      raised,
      palm: [(palm[0] + wrist[0]) / 2, (palm[1] + wrist[1]) / 2],
      index: at(hand, INDEX_TIP),
    });
  }
  return states;
}

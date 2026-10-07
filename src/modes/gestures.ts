// Lecture des gestes de la main à partir des 21 points MediaPipe, et détection du geste d'appel
// du menu : on tient le poing fermé un instant (il se charge), puis on ouvre la main d'un coup
// vers le haut (on lance le menu vers le ciel).
//
// La forme de la main se lit en 3D (MediaPipe donne une profondeur relative pour chaque point) :
// une main ouverte doigts vers la caméra paraît « écrasée » à plat ; en 2D elle ressemblerait à
// un poing. L'orientation de la paume, elle, n'est pas utilisée : de loin, la profondeur estimée
// est trop bruitée pour savoir de quel côté elle est tournée.
import { Scene, type Track } from "../scene";
import { STRIDE } from "../vision/protocol";

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_BASE = 5;
const INDEX_TIP = 8;
const MIDDLE_BASE = 9;
const PINKY_BASE = 17;
const TIPS = [4, 8, 12, 16, 20];
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
  /** Poing (trois doigts repliés suffisent). */
  closed: boolean;
  /** Distance moyenne des bouts des doigts au poignet, en tailles de paume : ~0,8 poing, ~2 main ouverte. */
  reach: number;
  /** Direction des doigts (poignet → bout du majeur) vers le haut de l'image, de -1 à 1. */
  fingersUp: number;
  /** Hauteur moyenne des bouts des doigts (px de l'image). */
  tipsY: number;
  /** Pouce et index qui se touchent. */
  pinch: boolean;
  /** Écartement des cinq bouts de doigts autour de leur centre, en tailles de paume :
   * ~0,25 doigts réunis en bouton, ~0,5 main plate doigts serrés, 0,7 à 1 main grande ouverte. */
  spread: number;
  /** Orientation de la paume vers le haut, de -1 (vers le sol) à 1 (vers le ciel). */
  palmUp: number;
  /** Centre de la paume, bout de l'index, centre des bouts de doigts (image caméra, 0–1). */
  palm: [number, number];
  index: [number, number];
  tips: [number, number];
  /** Poignet en px de l'image caméra. */
  wristPx: [number, number];
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
type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** État de chaque main réellement détectée. `w`, `h` : taille de l'image caméra (px). */
export function handStates(scene: Scene, now: number, w: number, h: number): HandState[] {
  const states: HandState[] = [];
  for (const hand of scene.hands) {
    if (Scene.alpha(hand, now) < 0.9 || hand.lostAt !== null) continue;
    // En px, la profondeur à la même échelle que x (comme MediaPipe la donne).
    const at = (i: number): Vec3 => [hand.points[i * STRIDE] * w, hand.points[i * STRIDE + 1] * h, hand.points[i * STRIDE + 2] * w];
    const dist = (a: Vec3, b: Vec3) => len(sub(a, b));
    const wrist = at(WRIST);
    const mid = at(MIDDLE_BASE);
    const palmSize = Math.max(dist(wrist, mid), 1);
    // Un doigt est tendu si son bout est nettement plus loin du poignet que son articulation,
    // replié si son bout est revenu plus près du poignet que l'articulation.
    const extended = FINGERS.filter(([tip, pip]) => dist(at(tip), wrist) > dist(at(pip), wrist) * 1.15).length;
    const curled = FINGERS.filter(([tip, pip]) => dist(at(tip), wrist) < dist(at(pip), wrist) * 1.02).length;
    const tips = TIPS.map(at);
    const c: Vec3 = [0, 1, 2].map((k) => tips.reduce((s, p) => s + p[k], 0) / tips.length) as Vec3;
    const spread = tips.reduce((s, p) => s + dist(p, c), 0) / tips.length / palmSize;
    // Normale de la paume (sortant de la paume) : son sens dépend de la main ; y de l'image vers le bas.
    let n = cross(sub(at(INDEX_BASE), wrist), sub(at(PINKY_BASE), wrist));
    if (hand.side === "left") n = [-n[0], -n[1], -n[2]];
    const palmUp = -n[1] / (len(n) || 1);
    const dir = sub(at(12), wrist);

    let bodyScale = palmSize * 3.5;
    let height = wrist[1] / bodyScale;
    let anchored = false;
    const body = hand.owner ? scene.tracks.pose.get(hand.owner) : undefined;
    if (body && hand.side) {
      const b = (i: number): Vec => [body.points[i * STRIDE] * w, body.points[i * STRIDE + 1] * h];
      bodyScale = Math.max(Math.hypot(b(11)[0] - b(12)[0], b(11)[1] - b(12)[1]), palmSize * 2);
      height = (wrist[1] - b(SHOULDER[hand.side])[1]) / bodyScale;
      anchored = true;
    }
    states.push({
      track: hand,
      extended,
      open: extended >= 3,
      fist: curled === 4,
      closed: curled >= 3,
      reach: FINGERS.reduce((sum, [tip]) => sum + dist(at(tip), wrist), 0) / 4 / palmSize,
      fingersUp: -dir[1] / (Math.hypot(dir[0], dir[1]) || 1),
      tipsY: (at(8)[1] + at(12)[1] + at(16)[1] + at(20)[1]) / 4,
      pinch: dist(at(THUMB_TIP), at(INDEX_TIP)) < palmSize * 0.35,
      spread,
      palmUp,
      palm: [(mid[0] + wrist[0]) / 2 / w, (mid[1] + wrist[1]) / 2 / h],
      index: [hand.points[INDEX_TIP * STRIDE], hand.points[INDEX_TIP * STRIDE + 1]],
      tips: [c[0] / w, c[1] / h],
      wristPx: [wrist[0], wrist[1]],
      palmSize,
      bodyScale,
      height,
      anchored,
    });
  }
  return states;
}

/**
 * Réglages du geste, mesurés sur 96 vidéos de LSF (4,5 min de signes) et sur des gestes simulés
 * à partir de vraies mains. Un poing qui s'ouvre vers le haut, c'est partout en langue des signes
 * (~60 fois en 4,5 min) ; mais les poings y sont toujours de passage. Exiger un poing tenu un
 * instant avant de l'ouvrir ramène ça à 5, et 95 % des vrais gestes passent.
 */
const HOLD_MS = 400; // poing tenu avant de lancer
const HOLD_STILL = 0.15; // pendant qu'on le tient, le poignet reste dans ce rayon (largeurs d'épaules)
/** Ouverture brusque : les doigts passent de « poing » à « main ouverte » en moins de ça. Une main
 * qui s'ouvre lentement ne lance rien. */
const FLICK_MS = 300;
const TIGHT_REACH = 1.1; // doigts encore serrés
const OPEN_REACH = 1.6; // doigts déployés
const TIPS_RISE = 0.3; // les bouts des doigts montent d'au moins ça (tailles de paume)
const WRIST_DROP = 0.05; // le poignet ne descend pas (tolérance, largeurs d'épaules)
const FINGERS_UP = 0.3; // main ouverte doigts vers le haut (vers le ciel)
const MAX_HEIGHT = 1.0; // main au-dessus des hanches

interface FistState {
  /** Début du poing tenu en cours (-1 : pas de poing). */
  since: number;
  /** Position du poignet au début du poing (immobilité). */
  x0: number;
  y0: number;
  /** Dernière image où les doigts étaient encore serrés (poing), et l'état à ce moment-là. */
  lastClosed: number;
  heldAtLast: boolean;
  tipsYAtLast: number;
  wristYAtLast: number;
  misses: number;
  /** Faux après une fermeture du menu au poing : il faut d'abord rouvrir la main. */
  armed: boolean;
}

/**
 * « Charger, lancer » : poing fermé tenu un instant, main levée (il se charge), puis la main
 * s'ouvre d'un coup, doigts vers le haut. Ouvrir la main lentement, vers le bas, sans l'avoir
 * tenue fermée, ou les poings de passage des signes ne déclenchent rien.
 */
export class BloomGesture {
  private hands = new Map<string, FistState>();
  private disarmed = new Set<string>();

  /** `charging` : la main dont le poing se charge, et où en est la charge (0 → 1). */
  update(hands: HandState[], now: number): { triggered: HandState | null; charging: { hand: HandState; charge: number } | null } {
    let triggered: HandState | null = null;
    let charging: { hand: HandState; charge: number } | null = null;
    const seen = new Set<string>();
    for (const hand of hands) {
      const key = hand.track.key;
      seen.add(key);
      let s = this.hands.get(key);
      if (!s) {
        s = { since: -1, x0: 0, y0: 0, lastClosed: -Infinity, heldAtLast: false, tipsYAtLast: 0, wristYAtLast: 0, misses: 0, armed: !this.disarmed.has(key) };
        this.hands.set(key, s);
      }
      const raised = !hand.anchored || hand.height < MAX_HEIGHT;
      const [x, y] = hand.wristPx;

      if (hand.closed && raised) {
        // Poing (re)commencé, ou qui a trop bougé : la charge repart de zéro.
        if (s.since < 0 || Math.hypot(x - s.x0, y - s.y0) / hand.bodyScale > HOLD_STILL) {
          s.since = now;
          s.x0 = x;
          s.y0 = y;
        }
        s.misses = 0;
      } else if (s.since >= 0 && ++s.misses > 1) s.since = -1; // une image ratée au milieu d'un poing est tolérée
      // Dernier instant où les doigts étaient encore serrés : point de départ du lancer.
      if (hand.reach <= TIGHT_REACH && raised && s.since >= 0) {
        s.lastClosed = now;
        s.heldAtLast = now - s.since >= HOLD_MS;
        s.tipsYAtLast = hand.tipsY;
        s.wristYAtLast = y;
      }
      if (hand.closed && raised) {
        const charge = Math.min(1, (now - s.since) / HOLD_MS);
        if (s.armed && (!charging || charge > charging.charge)) charging = { hand, charge };
        continue;
      }
      if (!hand.closed) {
        if (!s.armed && hand.open) s.armed = true;
        if (
          s.armed &&
          hand.open &&
          hand.reach >= OPEN_REACH &&
          raised &&
          s.heldAtLast &&
          now - s.lastClosed <= FLICK_MS &&
          (s.tipsYAtLast - hand.tipsY) / hand.palmSize >= TIPS_RISE &&
          (s.wristYAtLast - y) / hand.bodyScale >= -WRIST_DROP &&
          hand.fingersUp >= FINGERS_UP
        ) {
          triggered = hand;
          s.heldAtLast = false;
          s.since = -1;
        }
      }
    }
    for (const key of [...this.hands.keys()]) if (!seen.has(key)) this.hands.delete(key);
    for (const key of [...this.disarmed]) if (!seen.has(key)) this.disarmed.delete(key);
    return { triggered, charging: triggered ? null : charging };
  }

  /** Après une fermeture du menu au poing : les mains présentes doivent se rouvrir avant de relancer. */
  reset(): void {
    this.disarmed = new Set(this.hands.keys());
    this.hands.clear();
  }
}

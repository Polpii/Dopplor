// Lecture des gestes de la main à partir des 21 points MediaPipe, et détection du geste d'appel
// du menu (le « bloom » de la HoloLens) : main paume vers le ciel, bouts des doigts réunis, qui
// s'ouvre d'un coup en montant un peu.
//
// La forme de la main se lit en 3D (MediaPipe donne une profondeur relative pour chaque point) :
// une main paume vers le ciel, vue de face par la caméra, a les doigts dirigés vers le miroir et
// paraît toute « écrasée » à plat ; en 2D elle ressemblerait à un poing.
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
 * Réglages du geste, mesurés sur 96 vidéos de LSF (4,5 min de signes, pleines d'ouvertures de
 * main : 4 déclenchements, dont « livre » et « couscous » qui font presque le geste) et sur des
 * gestes simulés à partir de mains réelles (100 % reconnus, même une ouverture lente de 0,45 s).
 */
const BUD = 0.3; // doigts réunis
const OPEN = 0.7; // doigts écartés
const PALM_UP = 0.3; // paume tournée vers le ciel (au moins ~20°)
const RISE = 0.05; // la main monte un peu en s'ouvrant (largeurs d'épaules)
const WINDOW_MS = 500; // du bouton à la fleur
const MAX_HEIGHT = 0.9; // main au-dessus du bas de la poitrine
/** Bouton tenu ce temps : une petite lueur apparaît au bout des doigts (on sent que ça va s'ouvrir). */
const SEED_MS = 150;

/**
 * Le « bloom » : la main, bouts des doigts réunis, s'ouvre d'un coup paume vers le ciel en
 * montant légèrement. Ouvrir la main paume vers soi ou vers le sol, l'ouvrir lentement, ou lever
 * une main déjà ouverte ne déclenche rien.
 */
export class BloomGesture {
  private hands = new Map<string, { hist: { t: number; spread: number; y: number }[]; budSince: number }>();

  update(hands: HandState[], now: number): { triggered: HandState | null; seed: HandState | null } {
    let triggered: HandState | null = null;
    let seed: HandState | null = null;
    const seen = new Set<string>();
    for (const hand of hands) {
      const key = hand.track.key;
      seen.add(key);
      const s = this.hands.get(key) ?? { hist: [], budSince: -1 };
      s.hist.push({ t: now, spread: hand.spread, y: hand.wristPx[1] });
      while (s.hist.length && now - s.hist[0].t > WINDOW_MS) s.hist.shift();
      this.hands.set(key, s);
      const raised = !hand.anchored || hand.height < MAX_HEIGHT;

      if (hand.spread <= BUD && raised) {
        if (s.budSince < 0) s.budSince = now;
        if (now - s.budSince >= SEED_MS && hand.palmUp > -0.3) seed = hand;
      } else s.budSince = -1;

      if (hand.spread >= OPEN && hand.palmUp >= PALM_UP && raised) {
        const bloomed = s.hist.some((p) => p.spread <= BUD && (p.y - hand.wristPx[1]) / hand.bodyScale >= RISE);
        if (bloomed) {
          triggered = hand;
          s.hist = [];
        }
      }
    }
    for (const key of [...this.hands.keys()]) if (!seen.has(key)) this.hands.delete(key);
    return { triggered, seed: triggered ? null : seed };
  }

  reset(): void {
    this.hands.clear();
  }
}

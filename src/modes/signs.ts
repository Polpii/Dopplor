// Signes de langue des signes : enregistrement, comparaison et stockage.
//
// Un signe est enregistré une fois par quelqu'un qui le connaît : on garde le haut du corps et
// les deux mains image par image. Il sert ensuite à la fois de démonstration (le double doré le
// rejoue) et de référence : on compare ce que fait la personne au signe enregistré avec un
// alignement temporel (DTW), qui tolère qu'on signe plus vite ou plus lentement.
import type { Scene, Side, Track } from "../scene";
import { STRIDE } from "../vision/protocol";

/** Une image d'un signe, en coordonnées de l'image caméra (0–1). */
export interface SignFrame {
  /** Temps depuis le début du signe (ms). */
  t: number;
  /** Haut du corps : points 0 à 24 du squelette, [x, y, …]. */
  pose: number[];
  hands: Partial<Record<Side, number[]>>; // 21 points [x, y, …] par main présente
}

export interface Sign {
  id: string;
  label: string;
  created: string;
  /** Taille de l'image caméra à l'enregistrement (les distances se comparent en pixels). */
  width: number;
  height: number;
  frames: SignFrame[];
  /** Signe importé (bibliothèque LSF) : qui le signe, et sous quelle licence. */
  source?: { author: string; license: string; licenseUrl?: string; url: string };
  /** Fourni avec Dopplor (data/lsf) : ne peut pas être effacé. */
  bundled?: boolean;
}

const UPPER_BODY = 25;
const SHOULDER_L = 11;
const SHOULDER_R = 12;
/**
 * Une main plus bas que ça (en largeurs d'épaules sous les épaules) est au repos : elle ne fait
 * pas partie du signe. Même valeur que REST_BELOW dans scripts/import_lsf.py.
 */
const REST_BELOW = 1.35;
/** Cadence des signes enregistrés et comparés (images par seconde). */
export const SIGN_FPS = 15;

/** Image courante de la personne suivie (valeurs lissées, sans prédiction). */
export function captureFrame(scene: Scene, t: number): SignFrame | null {
  let body: Track | undefined;
  for (const b of scene.bodies) if (b.lostAt === null) body = b;
  if (!body) return null;
  const v = body.smoother.value;
  const pose: number[] = [];
  for (let i = 0; i < UPPER_BODY; i++) pose.push(v[i * STRIDE], v[i * STRIDE + 1]);
  const hands: SignFrame["hands"] = {};
  for (const h of scene.hands) {
    if (h.owner !== body.key || !h.side || h.lostAt !== null) continue;
    const hv = h.smoother.value;
    const pts: number[] = [];
    for (let i = 0; i < 21; i++) pts.push(hv[i * STRIDE], hv[i * STRIDE + 1]);
    hands[h.side] = pts;
  }
  return { t, pose, hands };
}

// --- Caractéristiques comparables d'une image ----------------------------------------------

/**
 * Pour chaque main : où elle est par rapport au corps (en largeurs d'épaules), et sa forme
 * (points par rapport au poignet, en tailles de paume). Indépendant de la taille de la personne
 * et de sa place dans l'image.
 */
export interface Features {
  hands: Partial<Record<Side, { place: [number, number]; shape: Float32Array }>>;
}

export function features(f: SignFrame, width: number, height: number): Features {
  const px = (arr: number[], i: number): [number, number] => [arr[i * 2] * width, arr[i * 2 + 1] * height];
  const l = px(f.pose, SHOULDER_L);
  const r = px(f.pose, SHOULDER_R);
  const center: [number, number] = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2];
  const scale = Math.max(Math.hypot(l[0] - r[0], l[1] - r[1]), 1);
  const out: Features = { hands: {} };
  for (const side of ["left", "right"] as const) {
    const pts = f.hands[side];
    if (!pts) continue;
    const wrist = px(pts, 0);
    const place: [number, number] = [(wrist[0] - center[0]) / scale, (wrist[1] - center[1]) / scale];
    if (place[1] > REST_BELOW) continue;
    const mid = px(pts, 9);
    const palm = Math.max(Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1]), 1);
    const shape = new Float32Array(40);
    for (let i = 1; i < 21; i++) {
      const p = px(pts, i);
      shape[(i - 1) * 2] = (p[0] - wrist[0]) / palm;
      shape[(i - 1) * 2 + 1] = (p[1] - wrist[1]) / palm;
    }
    out.hands[side] = { place, shape };
  }
  return out;
}

/** Le même signe fait de l'autre main (gauchers, vidéo en miroir). */
export function mirrored(f: Features): Features {
  const out: Features = { hands: {} };
  for (const side of ["left", "right"] as const) {
    const h = f.hands[side];
    if (!h) continue;
    const shape = h.shape.slice();
    for (let i = 0; i < shape.length; i += 2) shape[i] = -shape[i];
    out.hands[side === "left" ? "right" : "left"] = { place: [-h.place[0], h.place[1]], shape };
  }
  return out;
}

// Poids réglés sur la bibliothèque LSF (172 signes) avec des imitateurs simulés : autre
// morphologie, autre vitesse, décalés, forme des mains approximative, parfois de l'autre main.

/** Une main présente d'un côté et absente de l'autre coûte autant qu'une main très différente. */
const MISSING_HAND = 1.0;
const PLACE_WEIGHT = 0.5;
const SHAPE_WEIGHT = 0.4;

function frameDistance(a: Features, b: Features): number {
  let d = 0;
  for (const side of ["left", "right"] as const) {
    const ha = a.hands[side];
    const hb = b.hands[side];
    if (!ha && !hb) continue;
    if (!ha || !hb) {
      d += MISSING_HAND;
      continue;
    }
    const place = Math.hypot(ha.place[0] - hb.place[0], ha.place[1] - hb.place[1]);
    let shape = 0;
    for (let i = 0; i < 40; i += 2) shape += Math.hypot(ha.shape[i] - hb.shape[i], ha.shape[i + 1] - hb.shape[i + 1]);
    d += PLACE_WEIGHT * place + SHAPE_WEIGHT * (shape / 20);
  }
  return d;
}

/**
 * Distance entre un signe de référence et la fin de ce que fait la personne (DTW « sous-
 * séquence » : le signe peut commencer n'importe où dans la fenêtre récente). Moyenne par image.
 */
export function signDistance(template: Features[], live: Features[]): number {
  const n = template.length;
  const m = live.length;
  if (!n || !m) return Infinity;
  let prev = new Float32Array(m);
  let cur = new Float32Array(m);
  for (let j = 0; j < m; j++) prev[j] = frameDistance(template[0], live[j]); // début libre
  for (let i = 1; i < n; i++) {
    cur[0] = prev[0] + frameDistance(template[i], live[0]);
    for (let j = 1; j < m; j++) cur[j] = frameDistance(template[i], live[j]) + Math.min(prev[j], prev[j - 1], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  // Fin : on veut que le signe vienne d'être fait, donc dans les dernières images.
  let best = Infinity;
  for (let j = Math.max(0, m - 8); j < m; j++) best = Math.min(best, prev[j]);
  return best / n;
}

/**
 * Distance en dessous de laquelle le signe est réussi. Imitateurs simulés : 99 % de réussite
 * pour une imitation soignée, 68 à 88 % pour une approximative ; un autre signe passe 1 à 5 %.
 */
export const MATCH_DISTANCE = 0.55;
/** Distance typique d'un signe sans rapport (médiane des autres signes). */
const UNRELATED_DISTANCE = 1.2;

/** Distance → progression de la jauge, de 0 (sans rapport) à 1 (signe réussi). */
export const progress = (distance: number) =>
  Math.min(1, Math.max(0, (UNRELATED_DISTANCE - distance) / (UNRELATED_DISTANCE - MATCH_DISTANCE)));

/**
 * Chemin parcouru par la main qui bouge le plus (en largeurs d'épaules). Une pose tenue au bon
 * endroit ne suffit pas : il faut aussi faire le mouvement.
 */
export function travel(frames: Features[]): number {
  let best = 0;
  for (const side of ["left", "right"] as const) {
    let sum = 0;
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].hands[side];
      const b = frames[i].hands[side];
      if (a && b) sum += Math.hypot(b.place[0] - a.place[0], b.place[1] - a.place[1]);
    }
    best = Math.max(best, sum);
  }
  return best;
}

/** Part minimale du mouvement du modèle à refaire (imitateurs simulés : une pose immobile passe 10 % au lieu de 25 %). */
export const MIN_TRAVEL = 0.5;

export const hasHands = (f: Features) => f.hands.left !== undefined || f.hands.right !== undefined;

export function signFeatures(sign: Sign): Features[] {
  return sign.frames.map((f) => features(f, sign.width, sign.height)).filter(hasHands);
}

// --- Stockage --------------------------------------------------------------------------------

/**
 * Sur le PC du miroir, les signes sont gardés par le serveur Python (dossier signs/). Sans
 * serveur (développement dans le navigateur), dans le stockage local du navigateur.
 */
export class SignStore {
  private static KEY = "dopplor.signs";

  /** `api` : adresse du serveur Python ; null = stockage local du navigateur. */
  constructor(private api: string | null) {}

  private get local(): boolean {
    return this.api === null;
  }

  async list(): Promise<Sign[]> {
    if (this.local) return this.readLocal();
    const res = await fetch(`${this.api}/api/signs`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Sign[]) : [];
  }

  async save(sign: Sign): Promise<void> {
    if (this.local) {
      const all = this.readLocal().filter((s) => s.id !== sign.id);
      this.writeLocal([...all, sign]);
      return;
    }
    const res = await fetch(`${this.api}/api/signs`, { method: "POST", body: JSON.stringify(sign), headers: { "Content-Type": "application/json" } });
    if (!res.ok) throw new Error(`enregistrement refusé (${res.status})`);
  }

  async remove(id: string): Promise<void> {
    if (this.local) {
      this.writeLocal(this.readLocal().filter((s) => s.id !== id));
      return;
    }
    await fetch(`${this.api}/api/signs/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  private readLocal(): Sign[] {
    try {
      return JSON.parse(localStorage.getItem(SignStore.KEY) ?? "[]") as Sign[];
    } catch {
      return [];
    }
  }

  private writeLocal(signs: Sign[]): void {
    try {
      localStorage.setItem(SignStore.KEY, JSON.stringify(signs));
    } catch {
      // Stockage plein ou indisponible : le signe ne sera pas gardé.
    }
  }
}

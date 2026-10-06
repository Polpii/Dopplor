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
}

const UPPER_BODY = 25;
const SHOULDER_L = 11;
const SHOULDER_R = 12;
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
interface Features {
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
    const mid = px(pts, 9);
    const palm = Math.max(Math.hypot(mid[0] - wrist[0], mid[1] - wrist[1]), 1);
    const shape = new Float32Array(40);
    for (let i = 1; i < 21; i++) {
      const p = px(pts, i);
      shape[(i - 1) * 2] = (p[0] - wrist[0]) / palm;
      shape[(i - 1) * 2 + 1] = (p[1] - wrist[1]) / palm;
    }
    out.hands[side] = { place: [(wrist[0] - center[0]) / scale, (wrist[1] - center[1]) / scale], shape };
  }
  return out;
}

/** Une main présente d'un côté et absente de l'autre coûte autant qu'une main très différente. */
const MISSING_HAND = 1.2;

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
    d += place + (shape / 20) * 0.8;
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

/** Distance → ressemblance de 0 à 1 (1 = identique). */
export const similarity = (distance: number) => Math.exp(-distance / 0.55);

export function signFeatures(sign: Sign): Features[] {
  return sign.frames.filter((f) => Object.keys(f.hands).length > 0).map((f) => features(f, sign.width, sign.height));
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

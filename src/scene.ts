import { OneEuroBank } from "./one-euro";
import { EXPRESSIONS, STRIDE, type Detection, type Expression, type TaskKind } from "./vision/protocol";

export type Side = "left" | "right";

export interface Track {
  /** Identité stable tant que l'élément est suivi (ex. "pose-3", "hands-7"). */
  key: string;
  kind: TaskKind;
  /** Index de palette (hérité du corps pour les mains et visages). */
  color: number;
  /** Corps auquel appartient une main ou un visage. */
  owner: string | null;
  side?: Side;
  /** Latéralité donnée par MediaPipe ("Left" / "Right"), pour les mains. */
  label?: string;
  /** Identité imposée par une zone de recherche (clé "<corps>/<partie>") plutôt que par proximité. */
  zoned: boolean;
  /**
   * Points affichés, packés x, y, z, visibilité : les points lissés, avancés dans le temps
   * jusqu'au moment de l'affichage (voir `extrapolate`).
   */
  points: Float32Array;
  /** Moment (ms) de la dernière mise à jour, pour savoir de combien avancer les points. */
  updatedAt: number;
  smoother: OneEuroBank;
  /** Deux dernières détections brutes et leurs horodatages (ms) : servent à prédire le mouvement. */
  raw: Float32Array;
  rawPrev: Float32Array;
  rawTime: number;
  rawPrevTime: number;
  /** Visage : expressions lissées (voir EXPRESSIONS). */
  expressions?: Float32Array;
  /** Main perdue : position du poignet du corps au moment de la perte (la main le suit en attendant). */
  lostAnchor: [number, number] | null;
  /** Nombre de détections. On n'affiche qu'à partir de MIN_HITS (évite les faux positifs d'une image). */
  hits: number;
  /** Moment (ms) où l'élément est devenu visible, pour le fondu d'entrée. */
  shownAt: number;
  /** Moment (ms) du premier résultat qui ne contenait plus l'élément ; null s'il est détecté. */
  lostAt: number | null;
}

const MIN_HITS = 2;
/** Prédiction : on n'avance jamais de plus de 250 ms, ni de plus de 12 % de l'image. */
const MAX_LEAD_MS = 250;
const MAX_LEAD_SHIFT = 0.12;
/** Vitesses (largeur d'image par seconde) en dessous desquelles on ne prédit pas, puis pleinement. */
const PREDICT_MIN_SPEED = 0.04;
const PREDICT_FULL_SPEED = 0.2;
/**
 * Après une perte : maintien, puis fondu de sortie (ms). Les mains tiennent plus longtemps :
 * un geste rapide floute l'image, la main reste accrochée au poignet le temps d'être retrouvée.
 */
const HOLD_MS: Record<TaskKind, number> = { pose: 150, hands: 450, face: 250 };
const FADE_OUT_MS = 250;
const EXPRESSION_SMOOTHING = 0.5;
/**
 * Plage [repos, maximum] de chaque expression brute. Au repos, certains visages donnent déjà
 * 0,3–0,5 (ex. « sourcils froncés ») : on ne réagit qu'au-delà, à une expression vraiment marquée.
 */
const EXPRESSION_RANGES: Record<Expression, [number, number]> = {
  smile: [0.15, 0.7],
  jawOpen: [0.08, 0.6],
  blinkLeft: [0.35, 0.75],
  blinkRight: [0.35, 0.75],
  browUp: [0.25, 0.8],
  browDown: [0.45, 0.9],
  eyeWide: [0.2, 0.7],
  pucker: [0.3, 0.85],
  cheekPuff: [0.3, 0.8],
  frown: [0.3, 0.8],
};
const EXPRESSION_INDEX = Object.fromEntries(EXPRESSIONS.map((e, i) => [e, i])) as Record<Expression, number>;
const FADE_IN_MS = 120;

// [minCutoff, beta] pour des coordonnées normalisées. Les mains bougent vite : beta plus fort.
// Un peu moins lissé qu'avant : la prédiction compense le retard, et le lissage en ajoute.
// minCutoff bas = plus lisse à l'arrêt ; beta = réactivité quand ça bouge. Les mains tremblent
// le plus : lissage un peu plus fort, compensé par un beta élevé pour les gestes rapides.
const SMOOTHING: Record<TaskKind, [number, number]> = {
  pose: [1.0, 10],
  hands: [1.0, 25],
  face: [1.0, 12],
};

// Point de référence de chaque type (moyenne des indices) pour suivre et dédoublonner.
const ANCHOR: Record<TaskKind, number[]> = { pose: [11, 12, 23, 24], hands: [0, 9], face: [1] };
/** Distance max pour considérer qu'une détection est la suite d'un élément déjà suivi. */
// Corps : rayon large, une personne qui bouge vite reste la même personne après un décrochage.
const TRACK_RADIUS: Record<TaskKind, number> = { pose: 0.45, hands: 0.12, face: 0.15 };
/** En dessous de cette distance, deux détections du même type sont un doublon. */
const DUPLICATE_RADIUS: Record<TaskKind, number> = { pose: 0.05, hands: 0.03, face: 0.04 };

// Association des mains et visages aux corps.
const POSE_NOSE = 0;
const POSE_WRIST: Record<Side, number> = { left: 15, right: 16 };
const HAND_WRIST = 0;
const FACE_NOSE_TIP = 1;
const OWNER_RADIUS = 0.15;
const PALETTE_COUNT = 2;

/** Réglages d'une scène (par défaut : ceux du squelette vu par la caméra). */
export interface SceneOptions {
  smoothing?: Partial<Record<TaskKind, [number, number]>>;
  /** Vitesses (unités / s) en dessous desquelles on ne prédit pas, puis pleinement. */
  predictSpeed?: [number, number];
}

/**
 * Squelette calé sur le reflet (coordonnées écran) : la prédiction ne s'active que pour un vrai
 * mouvement rapide. Avec les seuils d'origine, le tremblement d'une image à l'autre passait pour
 * de la vitesse et était prolongé (rejoué sur un enregistrement : sauts doublés). Mesuré : petit
 * tremblement divisé par deux, sans retard en plus pendant un mouvement. Lissage du corps plus
 * réactif au mouvement (beta 30) : sur un bras simulé qui bouge (banc d'essai), dessin 3,2 cm
 * derrière la vraie position au lieu de 4,1 ; immobile, aussi stable (0,1 cm au pire).
 */
export const REFLECTED: SceneOptions = { predictSpeed: [0.25, 0.7], smoothing: { pose: [1.0, 30] } };

export class Scene {
  readonly tracks: Record<TaskKind, Map<string, Track>> = { pose: new Map(), hands: new Map(), face: new Map() };
  constructor(private options: SceneOptions = {}) {}
  /** Incrémenté à chaque changement : le rendu ne redessine que si nécessaire. */
  version = 0;
  private nextId = 0;

  get bodies(): Iterable<Track> {
    return this.tracks.pose.values();
  }
  get hands(): Iterable<Track> {
    return this.tracks.hands.values();
  }
  get faces(): Iterable<Track> {
    return this.tracks.face.values();
  }

  /** Intègre un résultat d'inférence : suivi par proximité, lissage, pertes. */
  update(kind: TaskKind, detections: Detection[], timestamp: number): void {
    const now = performance.now();
    const map = this.tracks[kind];
    const dets = dedupe(kind, detections);

    const usedDets = new Set<number>();
    const seen = new Set<Track>();
    // Détections par zone : leur clé donne directement l'identité.
    dets.forEach((d, i) => {
      if (!d.key) return;
      usedDets.add(i);
      const t = map.get(d.key);
      if (t) this.refresh(t, d, timestamp, now);
      seen.add(t ?? this.create(kind, d, timestamp, now));
    });

    // Les autres : appariement glouton détection ↔ élément suivi, du plus proche au plus lointain.
    const pairs: [number, number, Track][] = [];
    dets.forEach((d, i) => {
      if (d.key) return;
      for (const t of map.values()) {
        if (t.zoned) continue;
        const dist = anchorDistance(kind, d.points, t.points);
        if (dist < TRACK_RADIUS[kind]) pairs.push([dist, i, t]);
      }
    });
    pairs.sort((a, b) => a[0] - b[0]);

    for (const [, i, t] of pairs) {
      if (usedDets.has(i) || seen.has(t)) continue;
      usedDets.add(i);
      seen.add(t);
      this.refresh(t, dets[i], timestamp, now);
    }
    dets.forEach((d, i) => {
      if (!usedDets.has(i)) seen.add(this.create(kind, d, timestamp, now));
    });
    // Un élément n'est perdu que si un résultat arrive sans lui (pas au bout d'un délai fixe).
    for (const t of map.values()) {
      if (!seen.has(t) && t.lostAt === null) {
        t.lostAt = now;
        t.lostAnchor = this.wristOf(t);
      }
    }

    if (kind === "hands") this.assignHands();
    else if (kind === "face") this.assignFaces();
    // Personne, ni avant ni maintenant : rien n'a changé, pas besoin de redessiner.
    if (dets.length > 0 || map.size > 0) this.version++;
  }

  clear(kind: TaskKind): void {
    this.tracks[kind].clear();
    this.version++;
  }

  /** Opacité d'un élément : fondu d'entrée, puis maintien et fondu de sortie après une perte. */
  static alpha(t: Track, now: number): number {
    if (t.hits < MIN_HITS) return 0;
    let a = Math.min(1, (now - t.shownAt) / FADE_IN_MS);
    if (t.lostAt !== null) a *= clamp01(1 - (now - t.lostAt - HOLD_MS[t.kind]) / FADE_OUT_MS);
    return a;
  }

  /**
   * Compensation de latence : dessine chaque point là où il sera à l'affichage plutôt que là où
   * il était à la capture, en prolongeant sa vitesse. `leadMs` = latence à compenser au moment
   * où un résultat arrive ; on y ajoute le temps écoulé depuis. Les éléments perdus ne sont pas
   * prolongés (ils partiraient à la dérive).
   */
  extrapolate(now: number, leadMs: number): void {
    for (const map of Object.values(this.tracks)) {
      for (const t of map.values()) {
        const value = t.smoother.value;
        const lead = t.lostAt === null && leadMs > 0 ? Math.min(leadMs + now - t.updatedAt, MAX_LEAD_MS) / 1000 : 0;
        const v = t.smoother.velocity;
        for (let i = 0; i < value.length; i += STRIDE) {
          // Seulement en mouvement : à l'arrêt, la vitesse n'est que du bruit et la prolonger
          // ferait trembler le point. Transition douce entre les deux.
          const [lo, hi] = this.options.predictSpeed ?? [PREDICT_MIN_SPEED, PREDICT_FULL_SPEED];
          const k = lead * smoothstep(lo, hi, Math.hypot(v[i], v[i + 1]));
          t.points[i] = value[i] + clamp(v[i] * k, -MAX_LEAD_SHIFT, MAX_LEAD_SHIFT);
          t.points[i + 1] = value[i + 1] + clamp(v[i + 1] * k, -MAX_LEAD_SHIFT, MAX_LEAD_SHIFT);
          t.points[i + 2] = value[i + 2] + v[i + 2] * k;
          t.points[i + 3] = value[i + 3];
        }
      }
    }
  }

  get empty(): boolean {
    return this.tracks.pose.size + this.tracks.hands.size + this.tracks.face.size === 0;
  }

  /** Intensité d'une expression du visage, de 0 (repos) à 1 (très marquée). */
  static expression(face: Track, e: Expression): number {
    const v = face.expressions?.[EXPRESSION_INDEX[e]] ?? 0;
    const [lo, hi] = EXPRESSION_RANGES[e];
    const level = clamp01((v - lo) / (hi - lo));
    // Un grand sourire remonte les joues et abaisse les sourcils : MediaPipe y voit des
    // « sourcils froncés ». On ne fronce presque jamais en souriant : on l'atténue d'autant.
    return e === "browDown" ? level * (1 - Scene.expression(face, "smile")) : level;
  }

  /** Position brute (normalisée) du point i, extrapolée à `time` (ms) avec la vitesse récente. */
  static predict(t: Track, i: number, time: number): [number, number] {
    const x = t.raw[i * STRIDE];
    const y = t.raw[i * STRIDE + 1];
    const span = t.rawTime - t.rawPrevTime;
    if (span <= 0 || span > 200) return [x, y];
    const k = clamp(time - t.rawTime, 0, 100) / span;
    return [x + (x - t.rawPrev[i * STRIDE]) * k, y + (y - t.rawPrev[i * STRIDE + 1]) * k];
  }

  /** Vitesse brute du point i, en unités normalisées par seconde. */
  static speed(t: Track, i: number): number {
    const span = t.rawTime - t.rawPrevTime;
    if (span <= 0 || span > 200) return 0;
    const dx = t.raw[i * STRIDE] - t.rawPrev[i * STRIDE];
    const dy = t.raw[i * STRIDE + 1] - t.rawPrev[i * STRIDE + 1];
    return (Math.hypot(dx, dy) * 1000) / span;
  }

  /** Poignet du corps propriétaire d'une main (points lissés), ou null. */
  wristOf(hand: Track): [number, number] | null {
    if (hand.kind !== "hands" || !hand.owner || !hand.side) return null;
    const body = this.tracks.pose.get(hand.owner);
    if (!body) return null;
    const i = POSE_WRIST[hand.side];
    return [body.points[i * STRIDE], body.points[i * STRIDE + 1]];
  }

  /** Supprime les éléments disparus ; renvoie vrai si l'image doit être redessinée (fondu en cours). */
  prune(now: number): boolean {
    let changed = false;
    for (const map of Object.values(this.tracks)) {
      for (const [key, t] of map) {
        if (t.lostAt !== null && (t.hits < MIN_HITS || now - t.lostAt > HOLD_MS[t.kind] + FADE_OUT_MS)) {
          map.delete(key);
          changed = true;
          continue;
        }
        const a = Scene.alpha(t, now);
        if (a > 0 && a < 1) changed = true;
      }
    }
    return changed;
  }

  private create(kind: TaskKind, d: Detection, timestamp: number, now: number): Track {
    const [minCutoff, beta] = this.options.smoothing?.[kind] ?? SMOOTHING[kind];
    const smoother = new OneEuroBank(d.points.length, minCutoff, beta);
    smoother.filter(d.points, timestamp / 1000);
    const t: Track = {
      key: d.key ?? `${kind}-${this.nextId++}`,
      kind,
      color: kind === "pose" ? this.freeColor() : 0,
      owner: null,
      label: d.label,
      zoned: !!d.key,
      points: smoother.value.slice(),
      updatedAt: now,
      smoother,
      raw: d.points.slice(),
      rawPrev: d.points.slice(),
      rawTime: timestamp,
      rawPrevTime: timestamp,
      expressions: d.expressions?.slice(),
      hits: 1,
      shownAt: now,
      lostAt: null,
      lostAnchor: null,
    };
    if (d.key) {
      // Clé de zone "<corps>/<partie>" : propriétaire et côté sont connus d'avance.
      const [owner, part] = d.key.split("/");
      t.owner = owner;
      if (part === "left" || part === "right") t.side = part;
      t.color = this.tracks.pose.get(owner)?.color ?? 0;
    }
    this.tracks[kind].set(t.key, t);
    return t;
  }

  private refresh(t: Track, d: Detection, timestamp: number, now: number): void {
    t.hits++;
    if (t.hits === MIN_HITS) t.shownAt = now;
    t.lostAt = null;
    t.lostAnchor = null;
    t.label = d.label;
    t.smoother.filter(d.points, timestamp / 1000);
    t.points.set(t.smoother.value);
    t.updatedAt = now;
    t.rawPrev.set(t.raw);
    t.rawPrevTime = t.rawTime;
    t.raw.set(d.points);
    t.rawTime = timestamp;
    if (d.expressions) {
      if (!t.expressions) t.expressions = d.expressions.slice();
      else for (let i = 0; i < d.expressions.length; i++) t.expressions[i] += (d.expressions[i] - t.expressions[i]) * EXPRESSION_SMOOTHING;
    }
  }

  /** Première couleur non utilisée par un autre corps suivi : chaque personne garde la sienne. */
  private freeColor(): number {
    // Seuls les corps encore détectés réservent leur couleur (pas ceux en train de disparaître).
    const used = new Set([...this.tracks.pose.values()].filter((t) => t.lostAt === null).map((t) => t.color));
    for (let c = 0; c < PALETTE_COUNT; c++) if (!used.has(c)) return c;
    return this.tracks.pose.size % PALETTE_COUNT;
  }

  /** Chaque main est rattachée au poignet de corps le plus proche (personne + côté fiables). */
  private assignHands(): void {
    const candidates: { body: Track; side: Side; index: number }[] = [];
    for (const body of this.tracks.pose.values()) {
      for (const side of ["left", "right"] as const) candidates.push({ body, side, index: POSE_WRIST[side] });
    }
    const free = [...this.tracks.hands.values()].filter((h) => !h.zoned);
    const matches = matchToBodies(free, HAND_WRIST, candidates);
    for (const hand of this.tracks.hands.values()) {
      if (hand.zoned) {
        hand.color = this.tracks.pose.get(hand.owner!)?.color ?? hand.color;
        continue;
      }
      const m = matches.get(hand);
      hand.owner = m?.body.key ?? null;
      hand.color = m?.body.color ?? 0;
      // Sans corps : la latéralité de MediaPipe suppose une image en miroir, la nôtre ne l'est pas.
      hand.side = m?.side ?? (hand.label === "Left" ? "right" : "left");
    }
  }

  private assignFaces(): void {
    const candidates = [...this.tracks.pose.values()].map((body) => ({ body, side: undefined, index: POSE_NOSE }));
    const free = [...this.tracks.face.values()].filter((f) => !f.zoned);
    const matches = matchToBodies(free, FACE_NOSE_TIP, candidates);
    for (const face of this.tracks.face.values()) {
      if (face.zoned) {
        face.color = this.tracks.pose.get(face.owner!)?.color ?? face.color;
        continue;
      }
      const m = matches.get(face);
      face.owner = m?.body.key ?? null;
      face.color = m?.body.color ?? 0;
    }
  }
}

/** Appariement glouton un-pour-un entre des éléments et des points de corps. */
function matchToBodies<S>(
  items: Track[],
  itemIndex: number,
  candidates: { body: Track; side: S; index: number }[],
): Map<Track, { body: Track; side: S }> {
  const pairs: [number, Track, (typeof candidates)[number]][] = [];
  for (const item of items) {
    const x = item.points[itemIndex * STRIDE];
    const y = item.points[itemIndex * STRIDE + 1];
    for (const c of candidates) {
      const dist = Math.hypot(c.body.points[c.index * STRIDE] - x, c.body.points[c.index * STRIDE + 1] - y);
      if (dist < OWNER_RADIUS) pairs.push([dist, item, c]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const result = new Map<Track, { body: Track; side: S }>();
  const taken = new Set<(typeof candidates)[number]>();
  for (const [, item, c] of pairs) {
    if (result.has(item) || taken.has(c)) continue;
    result.set(item, { body: c.body, side: c.side });
    taken.add(c);
  }
  return result;
}

function anchor(kind: TaskKind, points: Float32Array): [number, number] {
  const idx = ANCHOR[kind];
  let x = 0;
  let y = 0;
  for (const i of idx) {
    x += points[i * STRIDE];
    y += points[i * STRIDE + 1];
  }
  return [x / idx.length, y / idx.length];
}

function anchorDistance(kind: TaskKind, a: Float32Array, b: Float32Array): number {
  const [ax, ay] = anchor(kind, a);
  const [bx, by] = anchor(kind, b);
  return Math.hypot(ax - bx, ay - by);
}

/** Supprime les détections quasi superposées (MediaPipe en renvoie parfois deux pour un même élément). */
function dedupe(kind: TaskKind, detections: Detection[]): Detection[] {
  const kept: Detection[] = [];
  for (const d of detections) {
    if (kept.every((k) => anchorDistance(kind, d.points, k.points) > DUPLICATE_RADIUS[kind])) kept.push(d);
  }
  return kept;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Menu des modes, piloté à la main et dessiné par le moteur néon (pas d'effets CSS coûteux).
//
//   Ouvrir : poing paume vers le ciel (il s'allume), qu'on ouvre d'un coup : le menu jaillit des
//            doigts (voir BloomGesture). Touche M.
//   Choisir : garder l'index sur un mode (~0,8 s) ou pincer pouce + index.
//   Fermer : fermer le poing et le garder fermé (le menu se replie dans la main).
//
// Le menu ne disparaît pas tout seul quand on baisse la main ou qu'elle sort du champ : il reste
// jusqu'à ce qu'on le ferme. Seule exception, plus personne devant le miroir pendant un moment.
// Les boutons restent à leur place (cibles fixes), le survol a une marge d'entrée et une marge de
// sortie différentes (pas de clignotement), et le curseur est légèrement aimanté.
import type { Scene } from "../scene";
import { hexToRgb, type RGB, type SegmentBuffer } from "../render/segments";
import { BloomGesture, handStates, type HandState } from "./gestures";

export interface MenuItem {
  id: string;
  label: string;
  /** Icône en traits, dans un carré [-1, 1]² (y vers le bas). */
  icon: Stroke[];
}

/** Polyligne [x0, y0, x1, y1, …] ou cercle { c: [x, y], r }. */
export type Stroke = number[] | { c: [number, number]; r: number };

/** État du menu ouvert, pour son apparence 3D (menu3d.ts). */
export interface MenuView {
  openedAt: number;
  fold: number;
  hovered: number | null;
  /** Avancée du choix par le doigt posé (0–1). */
  progress: number;
  active: boolean[];
}

/**
 * Bulles en 3D dans le reflet (menu3d.ts) : les gestes et le rythme restent ceux du menu, seules
 * la place et l'apparence des bulles changent. Sans 3D possible, le menu est dessiné à plat.
 */
export interface MenuStage {
  /** Place les bulles autour de la main qui ouvre ; faux si pas de 3D (pas calé, personne). */
  open(side: "left" | "right" | null, now: number): boolean;
  /** Où sont les bulles à l'écran (px CSS) et leur rayon. */
  positions(): { x: number; y: number; r: number }[];
  close(kind: "select" | "fold" | "away", index: number | null, now: number): void;
}

const DWELL_MS = 800;
const OPEN_MS = 560;
/** Poing tenu pour refermer, et délai après l'ouverture avant que le poing compte. */
const FOLD_MS = 600;
const FOLD_GRACE_MS = 700;
/** Plus personne devant le miroir : on range le menu. */
const AWAY_CLOSE_MS = 6000;
/** La main qui a ouvert le menu a disparu : une autre main peut prendre la main. */
const HAND_HANDOVER_MS = 1000;
/** Taille des boutons et rayon de l'arc, en fraction du plus petit côté de l'écran. */
const ITEM_RADIUS = 0.038;
const ARC_RADIUS = 0.13;
/** Écart entre deux bulles voisines sur l'arc. */
const ARC_STEP = (50 * Math.PI) / 180;

const COLOR: Record<string, RGB> = {
  idle: hexToRgb("#7fdcff"),
  /** Mode allumé : plus lumineux, blanc chaud. */
  active: hexToRgb("#fff1c9"),
  hover: hexToRgb("#ffffff"),
  progress: hexToRgb("#ffd36b"),
  cursor: hexToRgb("#5ef2ff"),
};

interface Placed {
  item: MenuItem;
  x: number;
  y: number;
  /** Rayon du bouton à l'écran (px). */
  r: number;
  label: HTMLElement;
}

export class Menu {
  private bloom = new BloomGesture();
  /** Lueur dans le poing paume vers le ciel (prêt à lancer), en px d'écran ; `level` suit la
   * présence du poing en douceur (apparition et disparition fondues). */
  private seed = { x: 0, y: 0, r: 0, level: 0, target: 0 };
  private isOpen = false;
  private openedAt = 0;
  private closedAt = -Infinity;
  /** Point d'où le menu éclot (la paume), et où il se replie. */
  private origin: [number, number] = [0, 0];
  private placed: Placed[] = [];
  private labels: HTMLElement;
  private hand: string | null = null;
  private handSeenAt = 0;
  private personSeenAt = 0;
  private cursor: [number, number] | null = null;
  /** Le survol ne compte qu'une fois le doigt sorti des boutons (sinon l'index, déjà levé à
   * l'ouverture, choisirait le bouton du milieu sans le vouloir). */
  private armed = false;
  private hovered: Placed | null = null;
  private hoverSince = 0;
  private fold = 0;
  private lastTrack = 0;
  private pinching = false;
  private flash: { x: number; y: number; at: number; kind: "select" | "close" } | null = null;
  private active = new Set<string>();
  /** Bulles en 3D dans le reflet (si possible à l'ouverture). */
  stage: MenuStage | null = null;
  private in3D = false;

  constructor(
    private items: MenuItem[],
    private toScreen: (x: number, y: number) => [number, number],
    private screen: () => [number, number],
    private frame: () => [number, number],
    private onSelect: (id: string) => void,
  ) {
    this.labels = document.createElement("div");
    this.labels.id = "menu-labels";
    document.body.append(this.labels);
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Vrai tant que le menu doit être redessiné (ouvert, appel en cours ou animation). */
  get animating(): boolean {
    return this.isOpen || this.seed.level > 0.01 || this.seed.target > 0 || (this.flash !== null && performance.now() - this.flash.at < 600);
  }

  /** Modes allumés : leur bulle brille davantage (la choisir à nouveau les éteint). */
  setActive(ids: Iterable<string>): void {
    this.active = new Set(ids);
  }

  /** Touche M : ouvre au centre de l'écran, ou ferme. */
  toggle(now = performance.now()): void {
    if (this.isOpen) this.close(now, "away");
    else {
      const [sw, sh] = this.screen();
      this.show(now, [sw / 2, sh * 0.45], [sw / 2, sh * 0.45], 0, null);
    }
  }

  /** Dernier état des mains (diagnostic du geste, enregistrement sur le miroir). */
  lastHands: HandState[] = [];

  /** Geste d'ouverture en pause (ex. la fée est posée sur une main tendue paume vers le ciel). */
  paused: () => boolean = () => false;

  update(scene: Scene, now: number): void {
    const [w, h] = this.frame();
    const hands = handStates(scene, now, w, h);
    this.lastHands = hands;
    for (const b of scene.bodies) if (b.lostAt === null) this.personSeenAt = now;
    if (!this.isOpen) {
      // En pause : rien ne s'arme ; il faudra refaire le geste en entier ensuite.
      const paused = this.paused();
      if (paused) this.bloom.reset();
      const { triggered, ready: seed } = paused ? { triggered: null, ready: null } : this.bloom.update(hands, now);
      const ready = now - this.closedAt > 800;
      if (triggered && ready) {
        this.seed.target = 0;
        this.seed.level = 0;
        this.show(now, this.toScreen(...triggered.palm), this.toScreen(...triggered.tips), this.palmOnScreen(triggered), triggered.track.key);
        return;
      }
      this.seed.target = seed && ready ? 1 : 0;
      if (seed && ready) {
        const [x, y] = this.toScreen(...seed.palm);
        const r = this.palmOnScreen(seed) * 1.1;
        // La lueur suit les doigts sans à-coups.
        const k = this.seed.level < 0.05 ? 1 : 0.5;
        this.seed.x += (x - this.seed.x) * k;
        this.seed.y += (y - this.seed.y) * k;
        this.seed.r += (r - this.seed.r) * k;
      }
      this.seed.level += (this.seed.target - this.seed.level) * (this.seed.target ? 0.5 : 0.25);
      return;
    }
    this.track(hands, now);
  }

  /** Taille de la paume à l'écran (px CSS). */
  private palmOnScreen(hand: HandState): number {
    const [w] = this.frame();
    const a = this.toScreen(...hand.palm);
    const b = this.toScreen(hand.palm[0] + 0.01, hand.palm[1]);
    const unit = Math.min(...this.screen());
    return Math.max(unit * 0.03, (hand.palmSize * Math.hypot(b[0] - a[0], b[1] - a[1])) / (0.01 * w));
  }

  // --- Ouverture / fermeture ------------------------------------------------------------------

  /** `center` : la paume (l'arc se place au-dessus) ; `from` : le point d'où les bulles éclosent. */
  private show(now: number, center: [number, number], from: [number, number], palm: number, hand: string | null): void {
    const [x, y] = center;
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    // L'arc passe au-dessus des doigts levés : le bout de l'index ne doit pas tomber sur un bouton.
    const r = Math.max(ARC_RADIUS * unit, palm * 3);
    const margin = (ITEM_RADIUS + 0.04) * unit;
    // Arc au-dessus de la main, gardé dans l'écran.
    const n = this.items.length;
    const spread = (ARC_STEP * (n - 1)) / 2;
    const cx = Math.min(sw - r * Math.sin(spread) - margin, Math.max(r * Math.sin(spread) + margin, x));
    const cy = Math.min(sh - margin, Math.max(r + margin, y));
    this.labels.innerHTML = "";
    this.placed = this.items.map((item, i) => {
      const a = -spread + ARC_STEP * i;
      const px = cx + Math.sin(a) * r;
      const py = cy - Math.cos(a) * r;
      const label = document.createElement("div");
      label.className = "menu-label";
      label.textContent = item.label;
      label.style.opacity = "0";
      label.style.transform = `translate(${px}px, ${py - (ITEM_RADIUS + 0.025) * unit}px) translate(-50%, -100%)`;
      this.labels.append(label);
      return { item, x: px, y: py, r: ITEM_RADIUS * unit, label };
    });
    // En 3D si possible : les bulles sont posées dans le reflet, près de la main.
    const side = hand?.split("/")[1];
    this.in3D = this.stage?.open(side === "left" || side === "right" ? side : null, now) ?? false;
    if (this.in3D) this.syncStage();
    this.isOpen = true;
    this.openedAt = now;
    this.origin = from;
    this.hand = hand;
    this.handSeenAt = now;
    this.personSeenAt = now;
    this.armed = false;
    this.hovered = null;
    this.cursor = null;
    this.fold = 0;
    this.lastTrack = now;
    this.pinching = true; // un pincement déjà en cours ne doit pas valider tout de suite
    if (!this.in3D) this.labels.classList.add("visible");
  }

  /** Bulles 3D : leur place à l'écran (la tête bouge, la perspective aussi). */
  private syncStage(): void {
    const pos = this.stage!.positions();
    this.placed.forEach((p, i) => {
      p.x = pos[i].x;
      p.y = pos[i].y;
      p.r = pos[i].r;
    });
  }

  /** Pour l'apparence des bulles 3D. */
  view(now: number): MenuView {
    const hovered = this.hovered ? this.placed.indexOf(this.hovered) : null;
    return {
      openedAt: this.openedAt,
      fold: this.fold,
      hovered,
      progress: this.hovered ? Math.min(1, (now - this.hoverSince) / DWELL_MS) : 0,
      active: this.items.map((it) => this.active.has(it.id)),
    };
  }

  private close(now: number, kind: "select" | "fold" | "away", index: number | null = null): void {
    if (this.in3D && this.isOpen) this.stage!.close(kind, index, now);
    this.isOpen = false;
    this.closedAt = now;
    this.hovered = null;
    this.cursor = null;
    this.fold = 0;
    this.bloom.reset();
    this.labels.classList.remove("visible");
  }

  // --- Pointage ---------------------------------------------------------------------------------

  private track(hands: HandState[], now: number): void {
    const dt = Math.min(100, now - this.lastTrack);
    this.lastTrack = now;
    if (now - this.personSeenAt > AWAY_CLOSE_MS) return this.close(now, "away");
    if (this.in3D) this.syncStage();

    // La main qui a ouvert le menu le pilote ; si elle a disparu un moment, n'importe quelle main.
    let hand = hands.find((h) => h.track.key === this.hand);
    if (!hand && (this.hand === null || now - this.handSeenAt > HAND_HANDOVER_MS)) hand = hands[0];
    if (!hand) {
      // Main baissée ou hors champ : le menu attend, sans curseur.
      this.cursor = null;
      this.hovered = null;
      this.fold = Math.max(0, this.fold - dt / 250);
      return;
    }
    this.hand = hand.track.key;
    this.handSeenAt = now;

    // Poing tenu : le menu se replie dans la main. Relâcher avant la fin l'annule.
    if (hand.fist && now - this.openedAt > FOLD_GRACE_MS) this.fold = Math.min(1, this.fold + dt / FOLD_MS);
    else this.fold = Math.max(0, this.fold - dt / 250);
    if (this.fold >= 1) {
      const [x, y] = this.toScreen(...hand.palm);
      this.flash = { x, y, at: now, kind: "close" };
      return this.close(now, "fold");
    }
    if (this.fold > 0) {
      this.origin = this.toScreen(...hand.palm);
      this.hovered = null;
      this.cursor = null;
      return;
    }

    const raw = this.toScreen(...hand.index);
    const d = (p: Placed) => Math.hypot(raw[0] - p.x, raw[1] - p.y);
    if (!this.armed && this.placed.every((p) => d(p) > p.r * 1.8)) this.armed = true;
    const ready = this.armed && now - this.openedAt > OPEN_MS;

    // Survol avec hystérésis : on entre à 1,3 rayon, on ne sort qu'à 1,8 rayon.
    if (this.hovered && d(this.hovered) > this.hovered.r * 1.8) this.hovered = null;
    if (!this.hovered && ready) {
      const near = this.placed.reduce<Placed | null>((best, p) => (d(p) < p.r * 1.3 && (!best || d(p) < d(best)) ? p : best), null);
      if (near) {
        this.hovered = near;
        this.hoverSince = now;
      }
    }
    // Curseur légèrement aimanté vers le bouton survolé.
    this.cursor = this.hovered ? [raw[0] + (this.hovered.x - raw[0]) * 0.35, raw[1] + (this.hovered.y - raw[1]) * 0.35] : raw;

    const pinchStart = hand.pinch && !this.pinching;
    this.pinching = hand.pinch;
    if (this.hovered && (now - this.hoverSince >= DWELL_MS || pinchStart)) {
      const chosen = this.hovered;
      this.flash = { x: chosen.x, y: chosen.y, at: now, kind: "select" };
      this.close(now, "select", this.placed.indexOf(chosen));
      this.onSelect(chosen.item.id);
    }
  }

  // --- Dessin (segments néon, en px CSS) -----------------------------------------------------------

  draw(out: SegmentBuffer, now: number): void {
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const itemR = ITEM_RADIUS * unit;
    const width = Math.max(1.5, unit * 0.0025);

    // En 3D, les bulles sont dessinées dans le reflet (menu3d.ts) : ici, seulement la lueur dans
    // le poing et le curseur.
    if (this.flash && this.in3D) this.flash = null;
    if (this.flash) {
      const t = (now - this.flash.at) / 600;
      if (t >= 1) this.flash = null;
      else if (this.flash.kind === "select") {
        // Validation : un anneau doré qui s'élargit et s'éteint.
        ring(out, this.flash.x, this.flash.y, itemR * (1 + t * 1.2), 0, 1, width * 1.4, COLOR.progress, 1.6 * (1 - t));
      } else {
        // Fermeture : un anneau qui se resserre dans le poing.
        ring(out, this.flash.x, this.flash.y, itemR * 1.4 * (1 - easeOut(t)), 0, 1, width * 1.2, COLOR.idle, 1.2 * (1 - t));
      }
    }

    if (this.seed.level > 0.01) {
      // Poing paume vers le ciel : une petite lueur qui respire, prête à jaillir.
      const { x, y, level } = this.seed;
      const r = Math.max(this.seed.r, width * 8);
      const breath = 1 + 0.08 * Math.sin(now / 120);
      out.dot(x, y, width * 3.5 * breath, COLOR.cursor, 1.4 * level);
      ring(out, x, y, r * breath, 0, 1, width * 1.1, COLOR.cursor, 0.8 * level);
    }
    if (!this.isOpen) return;
    if (this.in3D) {
      if (this.cursor) {
        out.dot(this.cursor[0], this.cursor[1], width * 4, COLOR.cursor, 1.6);
        ring(out, this.cursor[0], this.cursor[1], width * 5, 0, 1, width * 0.8, COLOR.cursor, 0.6);
      }
      return;
    }

    // Éclosion : une onde part du bout des doigts, et les bulles en sortent l'une après l'autre,
    // avec un léger dépassement avant de se poser. Repli : elles y retournent.
    const t = Math.min(1, (now - this.openedAt) / OPEN_MS);
    if (t < 1 && this.fold === 0) {
      const wave = easeOut(Math.min(1, t * 1.6));
      ring(out, this.origin[0], this.origin[1], itemR * (0.3 + 1.6 * wave), 0, 1, width * 1.2, COLOR.cursor, 1.4 * (1 - wave));
    }
    const fold = easeIn(this.fold);
    this.placed.forEach((p, i) => {
      const k = easeOutBack(Math.min(1, Math.max(0, t * 1.4 - i * 0.14))) * (1 - fold);
      if (k <= 0.01) {
        if (p.label.style.opacity !== "0") p.label.style.opacity = "0";
        return;
      }
      const x = this.origin[0] + (p.x - this.origin[0]) * k;
      const y = this.origin[1] + (p.y - this.origin[1]) * k;
      const hovered = p === this.hovered;
      const on = this.active.has(p.item.id);
      const color = hovered ? COLOR.hover : on ? COLOR.active : COLOR.idle;
      const r = itemR * (hovered ? 1.12 : 1) * (0.4 + 0.6 * k);
      // Allumé : anneau plus lumineux et doublé d'un halo intérieur, icône plus vive.
      ring(out, x, y, r, 0, 1, width * (on ? 1.4 : 1), color, hovered ? 1.3 : on ? 1.5 : 0.6);
      if (on) ring(out, x, y, r * 0.86, 0, 1, width * 0.6, color, 0.45);
      for (const s of p.item.icon) icon(out, s, x, y, r * 0.48, width * 0.9, color, hovered ? 1.4 : on ? 1.5 : 0.75);
      if (hovered) {
        const progress = Math.min(1, (now - this.hoverSince) / DWELL_MS);
        ring(out, x, y, r * 1.25, 0, progress, width * 1.6, COLOR.progress, 1.5);
      }
      // Les noms n'apparaissent qu'une fois le bouton en place (écrire le DOM seulement si ça change).
      const opacity = (Math.min(1, Math.max(0, k * 2 - 1)) * (hovered || on ? 1 : 0.6)).toFixed(2);
      if (p.label.style.opacity !== opacity) p.label.style.opacity = opacity;
    });
    if (this.cursor) {
      out.dot(this.cursor[0], this.cursor[1], width * 4, COLOR.cursor, 1.6);
      ring(out, this.cursor[0], this.cursor[1], width * 5, 0, 1, width * 0.8, COLOR.cursor, 0.6);
    }
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
const easeIn = (t: number) => t * t;
/** Arrive un peu au-delà puis revient se poser (éclosion souple). */
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

/** Arc de cercle de `from` à `to` (fractions de tour, départ en haut, sens horaire). */
function ring(out: SegmentBuffer, cx: number, cy: number, r: number, from: number, to: number, width: number, color: RGB, intensity: number): void {
  if (intensity <= 0 || r <= 0 || to <= from) return;
  const steps = Math.max(2, Math.ceil(48 * (to - from)));
  for (let i = 0; i < steps; i++) {
    const a0 = (from + ((to - from) * i) / steps) * Math.PI * 2 - Math.PI / 2;
    const a1 = (from + ((to - from) * (i + 1)) / steps) * Math.PI * 2 - Math.PI / 2;
    out.line(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, width, color, intensity);
  }
}

function icon(out: SegmentBuffer, s: Stroke, cx: number, cy: number, scale: number, width: number, color: RGB, intensity: number): void {
  if (!Array.isArray(s)) {
    ring(out, cx + s.c[0] * scale, cy + s.c[1] * scale, s.r * scale, 0, 1, width, color, intensity);
    return;
  }
  for (let i = 0; i + 3 < s.length; i += 2) {
    out.line(cx + s[i] * scale, cy + s[i + 1] * scale, cx + s[i + 2] * scale, cy + s[i + 3] * scale, width, color, intensity);
  }
}

/** Icônes en traits (carré [-1, 1]²). */
export const ICONS: Record<string, Stroke[]> = {
  cube: [
    [-0.55, -0.25, 0.05, -0.25, 0.05, 0.6, -0.55, 0.6, -0.55, -0.25],
    [-0.55, -0.25, -0.15, -0.65, 0.5, -0.65, 0.05, -0.25],
    [0.5, -0.65, 0.5, 0.2, 0.05, 0.6],
  ],
  fairy: [
    { c: [0, 0], r: 0.14 },
    [0.1, -0.08, 0.45, -0.62, 0.72, -0.42, 0.14, -0.02],
    [-0.1, -0.08, -0.45, -0.62, -0.72, -0.42, -0.14, -0.02],
    [0.1, 0.1, 0.42, 0.48, 0.22, 0.6, 0.06, 0.14],
    [-0.1, 0.1, -0.42, 0.48, -0.22, 0.6, -0.06, 0.14],
    [-0.2, 0.55, -0.32, 0.72],
    [0.3, 0.75, 0.4, 0.88],
  ],
  dance: [
    { c: [0.12, -0.7], r: 0.2 },
    [0.08, -0.48, -0.08, 0.2],
    [0.05, -0.36, 0.62, -0.88],
    [0.05, -0.36, -0.55, -0.05],
    [-0.08, 0.2, -0.5, 0.88],
    [-0.08, 0.2, 0.38, 0.48, 0.3, 0.9],
  ],
  skeleton: [
    { c: [0, -0.68], r: 0.22 },
    [0, -0.42, 0, 0.25],
    [-0.55, -0.15, 0, -0.3, 0.55, -0.15],
    [-0.4, 0.85, 0, 0.25, 0.4, 0.85],
  ],
  hand: [
    [-0.55, 0.15, -0.55, -0.35],
    [-0.25, 0.05, -0.25, -0.75],
    [0.05, 0.05, 0.05, -0.85],
    [0.35, 0.05, 0.35, -0.7],
    [0.62, 0.15, 0.62, -0.45],
    [-0.55, 0.15, -0.45, 0.6, 0, 0.85, 0.45, 0.6, 0.62, 0.15],
  ],
};

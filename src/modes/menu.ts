// Menu des modes, piloté à la main et dessiné par le moteur néon (pas d'effets CSS coûteux).
//
//   Ouvrir : monter la main fermée puis l'ouvrir (voir BloomGesture), ou la touche M.
//   Choisir : garder l'index sur un mode (~0,7 s) ou pincer pouce + index.
//   Fermer : fermer le poing, baisser la main, ou ne rien faire quelques secondes.
//
// Le menu s'ouvre en arc au-dessus de la main, à portée de doigt. Le survol a une marge d'entrée
// et une marge de sortie différentes (pas de clignotement), et le curseur est légèrement aimanté.
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

const DWELL_MS = 700;
const OPEN_MS = 280;
const IDLE_CLOSE_MS = 8000;
const NO_HAND_CLOSE_MS = 1500;
const FIST_CLOSE_MS = 350;
/** Taille des boutons et rayon de l'arc, en fraction du plus petit côté de l'écran. */
const ITEM_RADIUS = 0.038;
const ARC_RADIUS = 0.13;
const ARC_SPREAD = (55 * Math.PI) / 180;

const COLOR: Record<string, RGB> = {
  idle: hexToRgb("#7fdcff"),
  current: hexToRgb("#a78bfa"),
  hover: hexToRgb("#ffffff"),
  progress: hexToRgb("#ffd36b"),
  cursor: hexToRgb("#5ef2ff"),
};

interface Placed {
  item: MenuItem;
  x: number;
  y: number;
  label: HTMLElement;
}

export class Menu {
  private bloom = new BloomGesture();
  private isOpen = false;
  private openedAt = 0;
  private closedAt = -Infinity;
  private placed: Placed[] = [];
  private labels: HTMLElement;
  private hand: string | null = null;
  private cursor: [number, number] | null = null;
  private hovered: Placed | null = null;
  private hoverSince = 0;
  private lastActivity = 0;
  private lastHandAt = 0;
  private fistSince = 0;
  private pinching = false;
  private flash: { x: number; y: number; at: number } | null = null;
  private current = "";

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

  /** Vrai tant que le menu doit être redessiné (ouvert ou en animation). */
  get animating(): boolean {
    return this.isOpen || (this.flash !== null && performance.now() - this.flash.at < 500);
  }

  setCurrent(id: string): void {
    this.current = id;
  }

  /** Touche M : ouvre au centre de l'écran, ou ferme. */
  toggle(now = performance.now()): void {
    if (this.isOpen) this.close(now);
    else {
      const [sw, sh] = this.screen();
      this.show(now, sw / 2, sh * 0.45, null);
    }
  }

  update(scene: Scene, now: number): void {
    const [w, h] = this.frame();
    const hands = handStates(scene, now, w, h);
    if (hands.length) this.lastHandAt = now;
    if (!this.isOpen) {
      const { triggered } = this.bloom.update(hands, now);
      if (triggered && now - this.closedAt > 600) {
        const [x, y] = this.toScreen(...triggered.palm);
        this.show(now, x, y, triggered.track.key);
      }
      return;
    }
    this.track(hands, now);
  }

  // --- Ouverture / fermeture ------------------------------------------------------------------

  private show(now: number, x: number, y: number, hand: string | null): void {
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const r = ARC_RADIUS * unit;
    const margin = (ITEM_RADIUS + 0.04) * unit;
    // Arc au-dessus de la main, gardé dans l'écran.
    const cx = Math.min(sw - r * Math.sin(ARC_SPREAD) - margin, Math.max(r * Math.sin(ARC_SPREAD) + margin, x));
    const cy = Math.min(sh - margin, Math.max(r + margin, y));
    const n = this.items.length;
    this.labels.innerHTML = "";
    this.placed = this.items.map((item, i) => {
      const a = n === 1 ? 0 : -ARC_SPREAD + (2 * ARC_SPREAD * i) / (n - 1);
      const px = cx + Math.sin(a) * r;
      const py = cy - Math.cos(a) * r;
      const label = document.createElement("div");
      label.className = "menu-label";
      label.textContent = item.label;
      label.style.transform = `translate(${px}px, ${py - (ITEM_RADIUS + 0.025) * unit}px) translate(-50%, -100%)`;
      this.labels.append(label);
      return { item, x: px, y: py, label };
    });
    this.isOpen = true;
    this.openedAt = now;
    this.lastActivity = now;
    this.hand = hand;
    this.hovered = null;
    this.cursor = null;
    this.fistSince = 0;
    this.pinching = true; // un pincement déjà en cours ne doit pas valider tout de suite
    this.labels.classList.add("visible");
  }

  private close(now: number): void {
    this.isOpen = false;
    this.closedAt = now;
    this.hovered = null;
    this.cursor = null;
    this.labels.classList.remove("visible");
  }

  // --- Pointage ---------------------------------------------------------------------------------

  private track(hands: HandState[], now: number): void {
    const hand = hands.find((h) => h.track.key === this.hand) ?? (this.hand === null ? hands[0] : undefined);
    if (!hand) {
      this.cursor = null;
      if (now - this.lastHandAt > NO_HAND_CLOSE_MS) this.close(now);
      return;
    }
    this.hand = hand.track.key;

    // Poing fermé un instant : on referme le menu.
    if (hand.closed) {
      this.fistSince ||= now;
      if (now - this.fistSince > FIST_CLOSE_MS && now - this.openedAt > 500) return this.close(now);
    } else this.fistSince = 0;
    // Main baissée bien en dessous des épaules : on referme aussi.
    if (hand.anchored && hand.height > 1.2) return this.close(now);

    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const raw = this.toScreen(...hand.index);
    const itemR = ITEM_RADIUS * unit;

    // Survol avec hystérésis : on entre à 1,3 rayon, on ne sort qu'à 1,8 rayon.
    const d = (p: Placed) => Math.hypot(raw[0] - p.x, raw[1] - p.y);
    if (this.hovered && d(this.hovered) > itemR * 1.8) this.hovered = null;
    if (!this.hovered) {
      const near = this.placed.reduce<Placed | null>((best, p) => (d(p) < itemR * 1.3 && (!best || d(p) < d(best)) ? p : best), null);
      if (near) {
        this.hovered = near;
        this.hoverSince = now;
        this.lastActivity = now;
      }
    }
    // Curseur légèrement aimanté vers le bouton survolé.
    this.cursor = this.hovered ? [raw[0] + (this.hovered.x - raw[0]) * 0.35, raw[1] + (this.hovered.y - raw[1]) * 0.35] : raw;

    const pinchStart = hand.pinch && !this.pinching;
    this.pinching = hand.pinch;
    if (this.hovered && (now - this.hoverSince >= DWELL_MS || pinchStart)) {
      const chosen = this.hovered;
      this.flash = { x: chosen.x, y: chosen.y, at: now };
      this.close(now);
      this.onSelect(chosen.item.id);
      return;
    }
    if (now - this.lastActivity > IDLE_CLOSE_MS) this.close(now);
  }

  // --- Dessin (segments néon, en px CSS) -----------------------------------------------------------

  draw(out: SegmentBuffer, now: number): void {
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const itemR = ITEM_RADIUS * unit;
    const width = Math.max(1.5, unit * 0.0025);

    if (this.flash) {
      // Validation : un anneau doré qui s'élargit et s'éteint.
      const t = (now - this.flash.at) / 500;
      if (t < 1) ring(out, this.flash.x, this.flash.y, itemR * (1 + t * 1.2), 0, 1, width * 1.4, COLOR.progress, 1.6 * (1 - t));
      else this.flash = null;
    }
    if (!this.isOpen) return;

    // Éclosion : les boutons sortent de la main, l'un après l'autre.
    const t = Math.min(1, (now - this.openedAt) / OPEN_MS);
    this.placed.forEach((p, i) => {
      const k = easeOut(Math.min(1, Math.max(0, t * 1.4 - i * 0.15)));
      if (k <= 0) return;
      const hovered = p === this.hovered;
      const color = hovered ? COLOR.hover : p.item.id === this.current ? COLOR.current : COLOR.idle;
      const r = itemR * (hovered ? 1.12 : 1) * k;
      ring(out, p.x, p.y, r, 0, 1, width, color, hovered ? 1.3 : 0.75);
      for (const s of p.item.icon) icon(out, s, p.x, p.y, r * 0.48, width * 0.9, color, hovered ? 1.4 : 0.9);
      if (hovered) {
        const progress = Math.min(1, (now - this.hoverSince) / DWELL_MS);
        ring(out, p.x, p.y, r * 1.25, 0, progress, width * 1.6, COLOR.progress, 1.5);
      }
      const opacity = (k * (hovered ? 1 : 0.7)).toFixed(2);
      if (p.label.style.opacity !== opacity) p.label.style.opacity = opacity; // écrire le DOM seulement si ça change
    });
    if (this.cursor) {
      out.dot(this.cursor[0], this.cursor[1], width * 4, COLOR.cursor, 1.6);
      ring(out, this.cursor[0], this.cursor[1], width * 5, 0, 1, width * 0.8, COLOR.cursor, 0.6);
    }
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Arc de cercle de `from` à `to` (fractions de tour, départ en haut, sens horaire). */
function ring(out: SegmentBuffer, cx: number, cy: number, r: number, from: number, to: number, width: number, color: RGB, intensity: number): void {
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
  close: [
    [-0.55, -0.55, 0.55, 0.55],
    [0.55, -0.55, -0.55, 0.55],
  ],
};

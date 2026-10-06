// Menu des modes, piloté à la main et dessiné par le moteur néon (pas d'effets CSS coûteux).
//
//   Ouvrir : lever la main ouverte, paume vers le miroir, et la tenir ~1 s (voir PalmHold) ;
//            un anneau se remplit autour de la paume, le menu éclot quand il est plein. Touche M.
//   Choisir : garder l'index sur un mode (~0,8 s) ou pincer pouce + index.
//   Fermer : fermer le poing et le garder fermé (le menu se replie dans la main), ou « Fermer ».
//
// Le menu ne disparaît pas tout seul quand on baisse la main ou qu'elle sort du champ : il reste
// jusqu'à ce qu'on le ferme. Seule exception, plus personne devant le miroir pendant un moment.
// Les boutons restent à leur place (cibles fixes), le survol a une marge d'entrée et une marge de
// sortie différentes (pas de clignotement), et le curseur est légèrement aimanté.
import type { Scene } from "../scene";
import { hexToRgb, type RGB, type SegmentBuffer } from "../render/segments";
import { PalmHold, handStates, type HandState } from "./gestures";

export interface MenuItem {
  id: string;
  label: string;
  /** Icône en traits, dans un carré [-1, 1]² (y vers le bas). */
  icon: Stroke[];
}

/** Polyligne [x0, y0, x1, y1, …] ou cercle { c: [x, y], r }. */
export type Stroke = number[] | { c: [number, number]; r: number };

const DWELL_MS = 800;
const OPEN_MS = 420;
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
  private summon = new PalmHold();
  /** Appel en cours (anneau autour de la paume), en px d'écran. */
  private summoning: { x: number; y: number; r: number; progress: number } | null = null;
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

  /** Vrai tant que le menu doit être redessiné (ouvert, appel en cours ou animation). */
  get animating(): boolean {
    return this.isOpen || this.summoning !== null || (this.flash !== null && performance.now() - this.flash.at < 600);
  }

  setCurrent(id: string): void {
    this.current = id;
  }

  /** Touche M : ouvre au centre de l'écran, ou ferme. */
  toggle(now = performance.now()): void {
    if (this.isOpen) this.close(now);
    else {
      const [sw, sh] = this.screen();
      this.show(now, sw / 2, sh * 0.45, 0, null);
    }
  }

  update(scene: Scene, now: number): void {
    const [w, h] = this.frame();
    const hands = handStates(scene, now, w, h);
    for (const b of scene.bodies) if (b.lostAt === null) this.personSeenAt = now;
    if (!this.isOpen) {
      const { hand, progress, triggered } = this.summon.update(hands, now);
      if (triggered && now - this.closedAt > 800) {
        const [x, y] = this.toScreen(...triggered.palm);
        this.summoning = null;
        this.show(now, x, y, this.palmOnScreen(triggered), triggered.track.key);
      } else if (hand && progress > 0.2 && now - this.closedAt > 800) {
        const [x, y] = this.toScreen(...hand.palm);
        // L'anneau part de zéro une fois l'intention claire, et se remplit jusqu'à l'ouverture.
        this.summoning = { x, y, r: this.palmOnScreen(hand) * 1.25, progress: (progress - 0.2) / 0.8 };
      } else this.summoning = null;
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

  private show(now: number, x: number, y: number, palm: number, hand: string | null): void {
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    // L'arc passe au-dessus des doigts levés : le bout de l'index ne doit pas tomber sur un bouton.
    const r = Math.max(ARC_RADIUS * unit, palm * 3);
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
      label.style.opacity = "0";
      label.style.transform = `translate(${px}px, ${py - (ITEM_RADIUS + 0.025) * unit}px) translate(-50%, -100%)`;
      this.labels.append(label);
      return { item, x: px, y: py, label };
    });
    this.isOpen = true;
    this.openedAt = now;
    this.origin = [x, y];
    this.hand = hand;
    this.handSeenAt = now;
    this.personSeenAt = now;
    this.armed = false;
    this.hovered = null;
    this.cursor = null;
    this.fold = 0;
    this.lastTrack = now;
    this.pinching = true; // un pincement déjà en cours ne doit pas valider tout de suite
    this.labels.classList.add("visible");
  }

  private close(now: number): void {
    this.isOpen = false;
    this.closedAt = now;
    this.hovered = null;
    this.cursor = null;
    this.fold = 0;
    this.summon.reset();
    this.labels.classList.remove("visible");
  }

  // --- Pointage ---------------------------------------------------------------------------------

  private track(hands: HandState[], now: number): void {
    const dt = Math.min(100, now - this.lastTrack);
    this.lastTrack = now;
    if (now - this.personSeenAt > AWAY_CLOSE_MS) return this.close(now);

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
      return this.close(now);
    }
    if (this.fold > 0) {
      this.origin = this.toScreen(...hand.palm);
      this.hovered = null;
      this.cursor = null;
      return;
    }

    const [sw, sh] = this.screen();
    const itemR = ITEM_RADIUS * Math.min(sw, sh);
    const raw = this.toScreen(...hand.index);
    const d = (p: Placed) => Math.hypot(raw[0] - p.x, raw[1] - p.y);
    if (!this.armed && this.placed.every((p) => d(p) > itemR * 1.8)) this.armed = true;
    const ready = this.armed && now - this.openedAt > OPEN_MS;

    // Survol avec hystérésis : on entre à 1,3 rayon, on ne sort qu'à 1,8 rayon.
    if (this.hovered && d(this.hovered) > itemR * 1.8) this.hovered = null;
    if (!this.hovered && ready) {
      const near = this.placed.reduce<Placed | null>((best, p) => (d(p) < itemR * 1.3 && (!best || d(p) < d(best)) ? p : best), null);
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
      this.close(now);
      this.onSelect(chosen.item.id);
    }
  }

  // --- Dessin (segments néon, en px CSS) -----------------------------------------------------------

  draw(out: SegmentBuffer, now: number): void {
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const itemR = ITEM_RADIUS * unit;
    const width = Math.max(1.5, unit * 0.0025);

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

    if (this.summoning) {
      // Appel : un cercle discret autour de la paume, et un arc qui se remplit.
      const { x, y, r, progress } = this.summoning;
      const fade = Math.min(1, progress * 5);
      ring(out, x, y, r, 0, 1, width * 0.8, COLOR.idle, 0.35 * fade);
      ring(out, x, y, r, 0, progress, width * 1.6, COLOR.cursor, 1.3 * fade);
    }
    if (!this.isOpen) return;

    // Éclosion : les boutons sortent de la paume, l'un après l'autre. Repli : ils y retournent.
    const t = Math.min(1, (now - this.openedAt) / OPEN_MS);
    const fold = easeIn(this.fold);
    this.placed.forEach((p, i) => {
      const k = easeOut(Math.min(1, Math.max(0, t * 1.5 - i * 0.18))) * (1 - fold);
      if (k <= 0.01) {
        if (p.label.style.opacity !== "0") p.label.style.opacity = "0";
        return;
      }
      const x = this.origin[0] + (p.x - this.origin[0]) * k;
      const y = this.origin[1] + (p.y - this.origin[1]) * k;
      const hovered = p === this.hovered;
      const color = hovered ? COLOR.hover : p.item.id === this.current ? COLOR.current : COLOR.idle;
      const r = itemR * (hovered ? 1.12 : 1) * (0.4 + 0.6 * k);
      ring(out, x, y, r, 0, 1, width, color, hovered ? 1.3 : 0.75);
      for (const s of p.item.icon) icon(out, s, x, y, r * 0.48, width * 0.9, color, hovered ? 1.4 : 0.9);
      if (hovered) {
        const progress = Math.min(1, (now - this.hoverSince) / DWELL_MS);
        ring(out, x, y, r * 1.25, 0, progress, width * 1.6, COLOR.progress, 1.5);
      }
      // Les noms n'apparaissent qu'une fois le bouton en place (écrire le DOM seulement si ça change).
      const opacity = (Math.max(0, k * 2 - 1) * (hovered ? 1 : 0.7)).toFixed(2);
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

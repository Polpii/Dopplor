// Menu des modes, piloté à la main :
//   - lever une main ouverte au-dessus de l'épaule et la garder ~0,7 s ouvre le menu
//     (un anneau néon se remplit autour de la main) ;
//   - l'index devient un curseur ; rester posé ~0,9 s sur un mode le choisit.
// Touche M : ouvrir / fermer au clavier.
import type { Scene } from "../scene";
import { handStates } from "./gestures";

export interface MenuItem {
  id: string;
  label: string;
  /** SVG (24×24, trait) affiché au centre de la pastille. */
  icon: string;
}

const SUMMON_MS = 700;
const DWELL_MS = 900;
/** Après une fermeture, la main est encore levée : on attend avant de pouvoir rouvrir. */
const COOLDOWN_MS = 1500;
const IDLE_CLOSE_MS = 12000;
const NO_HAND_CLOSE_MS = 2500;
const HOVER_MARGIN = 30;

const RING = `<svg class="ring" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" /></svg>`;

export class Menu {
  private root: HTMLElement;
  private cursor: HTMLElement;
  private summon: HTMLElement;
  private buttons = new Map<string, HTMLElement>();
  private isOpen = false;
  private raisedSince = new Map<string, number>();
  private closedAt = -Infinity;
  private openedAt = 0;
  private lastHandAt = 0;
  private hovered: string | null = null;
  private hoverSince = 0;
  private activeHand: string | null = null;

  constructor(
    items: MenuItem[],
    private toScreen: (x: number, y: number) => [number, number],
    private onSelect: (id: string) => void,
  ) {
    this.root = document.createElement("div");
    this.root.id = "menu";
    this.root.className = "hidden";
    this.root.innerHTML = `<div class="menu-title">Modes</div><div class="menu-items"></div>
      <div class="menu-hint">Pointe un mode avec l'index et garde-le</div>`;
    const list = this.root.querySelector(".menu-items")!;
    for (const item of items) {
      const el = document.createElement("div");
      el.className = "menu-item";
      el.innerHTML = `${RING}<span class="icon">${item.icon}</span><span class="label">${item.label}</span>`;
      list.append(el);
      this.buttons.set(item.id, el);
    }
    this.cursor = document.createElement("div");
    this.cursor.id = "hand-cursor";
    this.summon = document.createElement("div");
    this.summon.id = "summon";
    this.summon.innerHTML = RING;
    document.body.append(this.root, this.cursor, this.summon);
  }

  get open(): boolean {
    return this.isOpen;
  }

  /** Mode courant, mis en évidence dans le menu. */
  setCurrent(id: string): void {
    for (const [itemId, el] of this.buttons) el.classList.toggle("current", itemId === id);
  }

  toggle(now = performance.now()): void {
    if (this.isOpen) this.close(now);
    else this.show(now, null);
  }

  update(scene: Scene, now: number): void {
    const hands = handStates(scene, now);
    if (hands.length) this.lastHandAt = now;
    if (this.isOpen) this.track(hands, now);
    else this.watchSummon(hands, now);
  }

  // --- Ouverture : main ouverte levée ---------------------------------------------------

  private watchSummon(hands: ReturnType<typeof handStates>, now: number): void {
    let best: { progress: number; palm: [number, number]; key: string } | null = null;
    const seen = new Set<string>();
    for (const h of hands) {
      seen.add(h.track.key);
      if (!(h.open && h.raised) || now - this.closedAt < COOLDOWN_MS) {
        this.raisedSince.delete(h.track.key);
        continue;
      }
      const since = this.raisedSince.get(h.track.key) ?? now;
      this.raisedSince.set(h.track.key, since);
      const progress = (now - since) / SUMMON_MS;
      if (!best || progress > best.progress) best = { progress, palm: h.palm, key: h.track.key };
    }
    for (const key of [...this.raisedSince.keys()]) if (!seen.has(key)) this.raisedSince.delete(key);

    if (!best) {
      this.summon.classList.remove("visible");
      return;
    }
    const [x, y] = this.toScreen(...best.palm);
    this.summon.style.transform = `translate(${x}px, ${y}px)`;
    this.summon.style.setProperty("--p", String(Math.min(1, best.progress)));
    this.summon.classList.add("visible");
    if (best.progress >= 1) this.show(now, best.key);
  }

  private show(now: number, hand: string | null): void {
    this.isOpen = true;
    this.openedAt = now;
    this.hoverSince = now;
    this.hovered = null;
    this.activeHand = hand;
    this.raisedSince.clear();
    this.summon.classList.remove("visible");
    this.root.classList.remove("hidden");
  }

  private close(now: number): void {
    this.isOpen = false;
    this.closedAt = now;
    this.hovered = null;
    this.root.classList.add("hidden");
    this.cursor.classList.remove("visible");
    for (const el of this.buttons.values()) el.classList.remove("hover");
  }

  // --- Choix : l'index sert de curseur ----------------------------------------------------

  private track(hands: ReturnType<typeof handStates>, now: number): void {
    const hand = hands.find((h) => h.track.key === this.activeHand) ?? hands.find((h) => h.raised) ?? hands[0];
    if (!hand) {
      this.cursor.classList.remove("visible");
      if (now - this.lastHandAt > NO_HAND_CLOSE_MS) this.close(now);
      return;
    }
    this.activeHand = hand.track.key;
    const [x, y] = this.toScreen(...hand.index);
    this.cursor.style.transform = `translate(${x}px, ${y}px)`;
    this.cursor.classList.add("visible");

    let over: string | null = null;
    for (const [id, el] of this.buttons) {
      const r = el.getBoundingClientRect();
      if (x > r.left - HOVER_MARGIN && x < r.right + HOVER_MARGIN && y > r.top - HOVER_MARGIN && y < r.bottom + HOVER_MARGIN) over = id;
    }
    if (over !== this.hovered) {
      this.hovered = over;
      this.hoverSince = now;
    }
    for (const [id, el] of this.buttons) {
      const active = id === over;
      el.classList.toggle("hover", active);
      el.style.setProperty("--p", active ? String(Math.min(1, (now - this.hoverSince) / DWELL_MS)) : "0");
    }
    if (over && now - this.hoverSince >= DWELL_MS) {
      const el = this.buttons.get(over)!;
      el.classList.add("chosen");
      setTimeout(() => el.classList.remove("chosen"), 600);
      this.close(now);
      this.onSelect(over);
      return;
    }
    if (!over && now - Math.max(this.openedAt, this.hoverSince) > IDLE_CLOSE_MS) this.close(now);
  }
}

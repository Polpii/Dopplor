// Mode fée : une petite fée lumineuse vit derrière le miroir. Elle tourne autour du reflet de la
// personne et, quand elle passe derrière elle, elle disparaît derrière son reflet (le serveur
// envoie la silhouette du reflet, avec sa distance, voir server/occlusion.py). Lever la main :
// elle vient s'y poser. Personne : elle flâne au milieu du miroir et attend.
//
// Tout se passe en 3D dans l'espace du reflet (derrière la vitre), vu depuis l'œil de la
// personne : la fée est exactement là où elle serait si elle volait à côté de son reflet.
import * as THREE from "three";
import type { Occlusion } from "../../vision/source";
import { Fairy } from "./fairy";
import { MirrorWorld, reflected } from "./world";

/** Main levée (poignet au-dessus de l'épaule) tenue ce temps : la fée vient s'y poser. */
const HAND_UP_MS = 350;
/** Tour autour du corps (rad/s), rayon (m). */
const ORBIT_SPEED = 0.95;
const ORBIT_RADIUS = 0.42;
/** Ressort qui la tire vers sa cible : raideur, amortissement (un peu sous l'amorti : elle vole). */
const STIFFNESS = 10;
const DAMPING = 0.75;

type Mood = "wander" | "orbit" | "hand";

export class FairyMode {
  readonly id = "fairy";
  private canvas: HTMLCanvasElement;
  private hint: HTMLElement;
  private world: MirrorWorld | null = null;
  private fairy: Fairy | null = null;
  private active = false;
  private pos = new THREE.Vector3(0.3, -0.5, -1.5);
  private vel = new THREE.Vector3();
  private angle = 0;
  private last = 0;
  private start = 0;
  private mood: Mood = "wander";
  private handSince: Record<"lw" | "rw", number> = { lw: 0, rw: 0 };
  private hand: "lw" | "rw" | null = null;
  private dart = new THREE.Vector3();
  private nextDart = 0;
  private chest: THREE.Vector3 | null = null;
  private audio: AudioContext | null = null;

  constructor(
    private occlusion: () => Occlusion | null,
    private setOcclusion: (on: boolean) => void,
    /** Taille de l'écran (m) d'après la calibration, en attendant le serveur. */
    private screenSize: () => [number, number, number] | null,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "fairy-canvas";
    this.canvas.className = "hidden";
    this.hint = document.createElement("div");
    this.hint.id = "fairy-hint";
    this.hint.className = "hidden";
    document.body.append(this.canvas, this.hint);
    window.addEventListener("resize", () => this.world?.resize());
  }

  get animating(): boolean {
    return this.active;
  }

  enter(now = performance.now()): void {
    this.active = true;
    this.setOcclusion(true);
    if (!this.world) {
      this.world = new MirrorWorld(this.canvas);
      this.fairy = new Fairy(this.world.shared);
      this.world.scene.add(...this.fairy.objects);
    }
    this.canvas.classList.remove("hidden");
    this.hint.classList.remove("hidden");
    this.start = now;
    this.last = now;
    this.mood = "wander";
    this.hand = null;
    this.setHint("Une fée vit derrière le miroir…");
  }

  exit(): void {
    this.active = false;
    this.setOcclusion(false);
    this.canvas.classList.add("hidden");
    this.hint.classList.add("hidden");
    this.world?.clear();
  }

  /** Une image : comportement, animation, rendu. À chaque rafraîchissement de l'écran. */
  frame(now: number): void {
    if (!this.active || !this.world || !this.fairy) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const t = (now - this.start) / 1000;
    const occ = this.occlusion();
    this.world.update(occ, now, this.screenSize());
    if (!this.world.ready) return;

    const present = occ !== null && now - occ.at < 600;
    const target = this.target(occ, present, now, t, dt);
    // Petits élans, comme un insecte : de temps en temps, un coup d'aile de côté.
    if (now > this.nextDart) {
      this.nextDart = now + 700 + Math.random() * 1600;
      this.dart.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08);
    }
    this.dart.multiplyScalar(Math.exp(-dt * 3));
    target.add(this.dart);
    // Ressort vers la cible.
    const acc = target.clone().sub(this.pos).multiplyScalar(STIFFNESS).addScaledVector(this.vel, -2 * Math.sqrt(STIFFNESS) * DAMPING);
    this.vel.addScaledVector(acc, dt);
    this.pos.addScaledVector(this.vel, dt);
    // Vol stationnaire : un léger tremblé vertical.
    const shown = this.pos.clone().add(new THREE.Vector3(0, 0.006 * Math.sin(t * 17), 0));
    this.fairy.update(shown, this.vel, t, dt);
    this.world.render();
  }

  private target(occ: Occlusion | null, present: boolean, now: number, t: number, dt: number): THREE.Vector3 {
    if (!present || !occ) {
      if (this.mood !== "wander") this.setHint("Une fée vit derrière le miroir…");
      this.mood = "wander";
      this.hand = null;
      this.chest = null;
      // Flâne au milieu du miroir, un peu derrière la vitre.
      const [sw, sh] = occ?.screen ?? [0.62, 1.1];
      return new THREE.Vector3(sw / 2 + 0.12 * Math.sin(t * 0.7), -sh * 0.42 + 0.08 * Math.sin(t * 1.1), -1.2 + 0.2 * Math.sin(t * 0.4));
    }
    const b = occ.body;
    const chest = reflected(b.chest);
    this.chest = this.chest ? this.chest.lerp(chest, 0.2) : chest;
    const head = reflected(b.head);
    const hips = reflected(b.hips);

    // Main levée ?
    for (const side of ["lw", "rw"] as const) {
      const wrist = reflected(b[side]);
      const shoulder = reflected(side === "lw" ? b.ls : b.rs);
      const up = occ.vis[side] && wrist.y > shoulder.y + 0.04;
      this.handSince[side] = up ? this.handSince[side] || now : 0;
    }
    const raised = (["lw", "rw"] as const).filter((s) => this.handSince[s] && now - this.handSince[s] > HAND_UP_MS);
    if (this.hand && !raised.includes(this.hand)) this.hand = null;
    if (!this.hand && raised.length) this.hand = raised.sort((a, c) => this.handSince[a] - this.handSince[c])[0];

    if (this.hand) {
      const wrist = reflected(b[this.hand]);
      if (this.mood !== "hand") {
        this.mood = "hand";
        this.setHint("");
      }
      // Au-dessus de la paume, petits cercles ; quand elle arrive : éclat et carillon.
      const spot = wrist.clone().add(new THREE.Vector3(0.03 * Math.cos(t * 3), 0.1 + 0.015 * Math.sin(t * 4), 0.03 * Math.sin(t * 3)));
      if (this.pos.distanceTo(spot) < 0.06 && this.vel.length() < 0.5 && !this.landed) {
        this.landed = true;
        this.fairy?.sparkle();
        this.chime();
      }
      return spot;
    }
    this.landed = false;
    if (this.mood !== "orbit") {
      this.mood = "orbit";
      this.setHint("Lève la main : elle viendra s'y poser");
    }
    // Autour du corps : un tour en ~6 s, rayon et hauteur qui varient (de la taille au-dessus
    // de la tête). Derrière (z plus loin que la poitrine) : cachée par le reflet.
    this.angle += dt * ORBIT_SPEED * (1 + 0.25 * Math.sin(t * 0.31));
    const r = ORBIT_RADIUS * (1 + 0.2 * Math.sin(t * 0.37));
    const k = 0.5 + 0.5 * Math.sin(t * 0.23 + 1.3);
    const y = hips.y + (head.y + 0.12 - hips.y) * k;
    const c = this.chest;
    return new THREE.Vector3(c.x + r * Math.cos(this.angle), y, c.z + r * Math.sin(this.angle));
  }

  private landed = false;

  private setHint(text: string): void {
    if (this.hint.textContent !== text) this.hint.textContent = text;
    this.hint.classList.toggle("empty", text === "");
  }

  /** Petit carillon cristallin (deux notes aiguës qui s'éteignent). */
  private chime(): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const t0 = ctx.currentTime + 0.01;
      [1568, 2093, 2637].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.07);
        g.gain.linearRampToValueAtTime(0.08, t0 + i * 0.07 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.07 + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + i * 0.07);
        o.stop(t0 + i * 0.07 + 0.65);
      });
    } catch {
      // Pas de son : tant pis.
    }
  }
}

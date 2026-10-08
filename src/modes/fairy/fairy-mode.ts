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
/** Ressort qui la tire vers sa cible : raideur, amortissement (un peu sous l'amorti : elle vole). */
const STIFFNESS = 10;
const DAMPING = 0.75;

type Mood = "wander" | "orbit" | "hand";
type Path = "ellipse" | "saddle" | "spiral" | "visit";
const PATHS: Path[] = ["ellipse", "saddle", "spiral", "visit"];
/** Vitesse de chaque figure (rad/s). */
const PATH_SPEED: Record<Path, number> = { ellipse: 1.0, saddle: 0.85, spiral: 1.2, visit: 0.7 };
/** Passage d'une figure à l'autre (ms). */
const PATH_BLEND_MS = 1800;
/**
 * Taille selon la profondeur : plus grande devant la personne (plus près), plus petite derrière,
 * en plus de la perspective (trop faible seule pour qu'on sente qu'elle s'éloigne).
 */
const DEPTH_SCALE = 1.5;
const SCALE_MIN = 0.5;
const SCALE_MAX = 1.8;

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
    const ahead = this.chest ? this.pos.z - this.chest.z : 0; // > 0 : devant la personne
    const scale = THREE.MathUtils.clamp(1 + ahead * DEPTH_SCALE, SCALE_MIN, SCALE_MAX);
    this.fairy.update(shown, this.vel, t, dt, scale);
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
    // Autour du corps, suivant une figure qui change toutes les 7 à 11 s (en fondu) ; derrière
    // (plus loin que la poitrine) : cachée par le reflet.
    if (now - this.pathSince > this.pathFor) {
      this.prevPath = this.path;
      const others = PATHS.filter((p) => p !== this.path);
      this.path = others[Math.floor(Math.random() * others.length)];
      this.pathSince = now;
      this.pathFor = 7000 + Math.random() * 4000;
      if (Math.random() < 0.4) this.dir = -this.dir;
    }
    this.angle += dt * this.dir * PATH_SPEED[this.path] * (1 + 0.2 * Math.sin(t * 0.31));
    const body = { c: this.chest, head, hips };
    const next = this.pathPoint(this.path, body, t, (now - this.pathSince) / 1000);
    const k = Math.min(1, (now - this.pathSince) / PATH_BLEND_MS);
    if (k >= 1 || !this.prevPath) return next;
    const prev = this.pathPoint(this.prevPath, body, t, Infinity);
    return prev.lerp(next, k * k * (3 - 2 * k));
  }

  /**
   * Un point de la figure en cours (repère Three, derrière la vitre : z négatif ; plus loin que
   * la poitrine = derrière la personne). `since` : secondes depuis le début de la figure.
   */
  private pathPoint(path: Path, b: { c: THREE.Vector3; head: THREE.Vector3; hips: THREE.Vector3 }, t: number, since: number): THREE.Vector3 {
    const a = this.angle;
    const { c, head, hips } = b;
    const mid = (hips.y + head.y) / 2;
    const top = head.y + 0.2;
    switch (path) {
      case "ellipse": {
        // Ellipse profonde et inclinée : monte d'un côté, descend de l'autre.
        const rx = 0.48 + 0.06 * Math.sin(t * 0.3);
        const rz = 0.72;
        return new THREE.Vector3(c.x + rx * Math.cos(a), mid + 0.24 * Math.sin(a + 0.9), c.z + rz * Math.sin(a));
      }
      case "saddle": {
        // Boucle en selle : deux bosses par tour, haut devant et derrière, bas sur les côtés.
        return new THREE.Vector3(c.x + 0.52 * Math.sin(a), mid + 0.1 - 0.3 * Math.cos(2 * a), c.z + 0.62 * Math.cos(a));
      }
      case "spiral": {
        // Spirale : monte de la taille au-dessus de la tête, puis redescend (en 9 s).
        const u = 0.5 - 0.5 * Math.cos((Math.min(since, 1e6) / 9) * Math.PI * 2);
        return new THREE.Vector3(c.x + 0.42 * Math.cos(a), hips.y - 0.05 + (top - hips.y + 0.05) * u, c.z + 0.6 * Math.sin(a));
      }
      case "visit": {
        // Visite : passe tout près devant le visage, puis repart large derrière.
        const front = Math.max(0, Math.cos(a));
        return new THREE.Vector3(c.x + 0.55 * Math.sin(a) * (1 - 0.6 * front), head.y - 0.05 - 0.25 * (1 - front), c.z + 0.28 * front - 0.6 * (1 - front) * Math.abs(Math.sin(a * 0.5)));
      }
    }
  }

  private landed = false;
  private path: Path = "ellipse";
  private prevPath: Path | null = null;
  private pathSince = 0;
  private pathFor = 9000;
  private dir = 1;

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

// Mode fée : une petite fée lumineuse vit derrière le miroir. Elle tourne autour du reflet de la
// personne et, quand elle passe derrière elle, elle disparaît derrière son reflet (le serveur
// envoie la silhouette du reflet, avec sa distance, voir server/occlusion.py). Personne : elle
// flâne au milieu du miroir et attend.
//
// Main à plat, paume vers le ciel : elle la remarque (petit tour sur elle-même), vient en
// spirale et s'y pose, ailes lentes, lueur qui respire, petits sauts de temps en temps. Elle
// suit la main. Approcher l'autre main à plat : elle saute dessus. Fermer la main, la retourner
// ou la baisser : elle s'envole ; un geste brusque : elle s'envole d'un coup, effrayée.
//
// Tout se passe en 3D dans l'espace du reflet (derrière la vitre), vu depuis l'œil de la
// personne : la fée est exactement là où elle serait si elle volait à côté de son reflet.
import * as THREE from "three";
import type { Scene } from "../../scene";
import type { Occlusion } from "../../vision/source";
import { handStates } from "../gestures";
import { Fairy } from "./fairy";
import { MirrorWorld, reflected } from "./world";

/** Ressort qui la tire vers sa cible : raideur, amortissement (un peu sous l'amorti : elle vole). */
const STIFFNESS = 10;
const DAMPING = 0.75;
/** Posée : elle suit la main de près. */
const PERCH_STIFFNESS = 80;

type Mood = "wander" | "orbit" | "notice" | "approach" | "perched" | "takeoff" | "fall" | "recover";
type Path = "ellipse" | "saddle" | "spiral" | "visit";
type Side = "left" | "right";
const PATHS: Path[] = ["ellipse", "saddle", "spiral", "visit"];
/** Vitesse de chaque figure (rad/s). */
const PATH_SPEED: Record<Path, number> = { ellipse: 1.0, saddle: 0.85, spiral: 1.2, visit: 0.7 };
/** Passage d'une figure à l'autre (ms). */
const PATH_BLEND_MS = 1800;
/**
 * Taille selon la profondeur, en plus de la perspective (qui fait déjà ~1,4 fois plus grand
 * devant que derrière) : juste un peu, sinon trop grande devant et minuscule derrière.
 */
const DEPTH_SCALE = 0.25;
const SCALE_MIN = 0.9;
const SCALE_MAX = 1.0;
/** Posée sur une main (tout près, devant) : plus petite. */
const PERCH_SCALE = 0.6;
/** Volume du corps qu'elle contourne : demi-largeur (épaules, bras), demi-épaisseur (m). */
const BODY_HALF_WIDTH = 0.4;
const BODY_HALF_DEPTH = 0.3;
/** Devant la personne, elle s'approche moins qu'elle ne s'éloigne derrière (m). */
const FRONT_DEPTH = 0.45;

/** Main à plat : doigts tendus, paume vers le ciel, entre les hanches et la tête, tenue un instant. */
const FLAT_REACH = 1.45;
const FLAT_UP = 0.3;
const FLAT_MS = 300;
/** La main n'est plus tendue (fermée, retournée, baissée, perdue) depuis ce temps : elle s'envole. */
const LEAVE_MS = 900;
/** Paume encore assez vers le ciel pour la garder (au-dessous : retournée). */
const HOLD_UP = -0.15;
/** Main qui bouge plus vite que ça (m/s) : elle s'envole d'un coup. */
const STARTLE_SPEED = 1.6;
/** Elle remarque la main, puis vient en spirale (ms). */
const NOTICE_MS = 450;
const APPROACH_MS = 1500;
const HOP_MS = 650;
/** Posée à cette hauteur au-dessus du centre de la paume (m). */
const PERCH_HEIGHT = 0.04;
/** Autre main à plat à moins de ça de la première (m) : elle saute dessus. */
const HOP_TO_OTHER = 0.25;
const TAKEOFF_MS = 900;
/**
 * Main retirée sous elle (baissée vite, perdue, retournée) : elle tombe (gravité douce, elle
 * tournoie, ailes presque arrêtées), puis se rattrape et remonte en vol.
 */
const FALL_MS = 520;
const FALL_GRAVITY = 3.2;
const RECOVER_MS = 900;
/**
 * Main retirée : elle descend vite (m/s) ET se retrouve nettement plus bas que d'habitude (m).
 * La position de la paume tremble (mains petites à 2 m) : la vitesse seule faisait tomber la
 * fée sur une simple secousse de la mesure.
 */
const DROP_SPEED = 0.6;
const DROP_DEPTH = 0.12;
/** Posée (ou en train d'arriver) : sa lumière n'est pas cachée par la main qui la porte (m). */
const PERCH_BIAS = 0.25;

const UP = new THREE.Vector3(0, 1, 0);
const smooth = (k: number) => k * k * (3 - 2 * k);

interface HandInfo {
  /** À plat depuis (performance.now()), 0 sinon. */
  flatSince: number;
  /** Plus à plat depuis. */
  notFlatSince: number;
  ups: number[];
  palm: THREE.Vector3 | null;
  palmAt: number;
  speed: number;
  /** Vitesse verticale de la paume (m/s, > 0 vers le haut), et sa hauteur habituelle. */
  vy: number;
  restY: number;
  /** Poing (elle s'envole d'un bond plutôt que de tomber). */
  closed: boolean;
}

export class FairyMode {
  readonly id = "fairy";
  private canvas: HTMLCanvasElement;
  private world: MirrorWorld | null = null;
  private fairy: Fairy | null = null;
  private active = false;
  private pos = new THREE.Vector3(0.3, -0.5, -1.5);
  private vel = new THREE.Vector3();
  private angle = 0;
  private last = 0;
  private start = 0;
  private mood: Mood = "wander";
  private moodSince = 0;
  private dart = new THREE.Vector3();
  private nextDart = 0;
  private chest: THREE.Vector3 | null = null;
  private audio: AudioContext | null = null;
  private path: Path = "ellipse";
  private prevPath: Path | null = null;
  private pathSince = 0;
  private pathFor = 9000;
  private dir = 1;
  /** Main portant la fée (ou visée), et d'où elle part pour y venir. */
  private perch: Side | null = null;
  private from = new THREE.Vector3();
  private fromAngle = 0;
  private nextHop = 0;
  private hopAt = 0;
  private rest = 0;
  private recoverTo = new THREE.Vector3();
  /** Quand elle a quitté une main pour la dernière fois. */
  private leftHandAt = -Infinity;
  private hands: Record<Side, HandInfo> = {
    left: { flatSince: 0, notFlatSince: 0, ups: [], palm: null, palmAt: 0, speed: 0, vy: 0, restY: 0, closed: false },
    right: { flatSince: 0, notFlatSince: 0, ups: [], palm: null, palmAt: 0, speed: 0, vy: 0, restY: 0, closed: false },
  };

  constructor(
    private scene: Scene,
    private frameSize: () => [number, number],
    private occlusion: () => Occlusion | null,
    private setOcclusion: (on: boolean) => void,
    /** Taille de l'écran (m) d'après la calibration, en attendant le serveur. */
    private screenSize: () => [number, number, number] | null,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.id = "fairy-canvas";
    this.canvas.className = "hidden";
    document.body.append(this.canvas);
    window.addEventListener("resize", () => this.world?.resize());
  }

  get animating(): boolean {
    return this.active;
  }

  /** Vrai quand elle doit laisser les mains tranquilles (menu ouvert). */
  busy: () => boolean = () => false;

  /** Elle s'occupe d'une main (la voit, y vient, y est posée, vient d'en partir). */
  get holdsHand(): boolean {
    if (!this.active) return false;
    if (this.mood === "approach" || this.mood === "perched" || this.mood === "fall" || this.mood === "recover") return true;
    return performance.now() - this.leftHandAt < 800;
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
    this.start = now;
    this.last = now;
    this.setMood("wander", now);
    this.perch = null;
  }

  exit(): void {
    this.active = false;
    this.setOcclusion(false);
    this.canvas.classList.add("hidden");
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
    this.watchHands(occ, present, now);
    const target = this.target(occ, present, now, t, dt);
    const perched = this.mood === "perched";
    // Petits élans, comme un insecte : de temps en temps, un coup d'aile de côté (pas posée).
    if (now > this.nextDart) {
      this.nextDart = now + 700 + Math.random() * 1600;
      this.dart.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08);
    }
    this.dart.multiplyScalar(Math.exp(-dt * 3));
    if (this.mood === "orbit" || this.mood === "wander") target.add(this.dart);
    const since = now - this.moodSince;
    if (this.mood === "fall") {
      // Elle tombe : gravité douce, un peu de frottement de l'air ; puis elle se rattrape.
      this.vel.y -= FALL_GRAVITY * dt;
      this.vel.multiplyScalar(Math.exp(-dt * 0.8));
      this.pos.addScaledVector(this.vel, dt);
      if (since > FALL_MS) {
        this.recoverTo.copy(this.pos).add(new THREE.Vector3((Math.random() - 0.5) * 0.2, 0.3, 0));
        this.setMood("recover", now);
      }
    } else {
      // Ressort vers la cible (raide quand elle est posée ou qu'elle arrive ; mou au début du
      // rattrapage, le temps que les ailes reprennent).
      const k = perched
        ? PERCH_STIFFNESS
        : this.mood === "approach"
          ? THREE.MathUtils.lerp(STIFFNESS, PERCH_STIFFNESS, smooth(Math.min(1, since / APPROACH_MS)))
          : this.mood === "recover"
            ? THREE.MathUtils.lerp(0.5, STIFFNESS, smooth(Math.min(1, since / RECOVER_MS)))
            : STIFFNESS;
      const acc = target.clone().sub(this.pos).multiplyScalar(k).addScaledVector(this.vel, -2 * Math.sqrt(k) * DAMPING);
      this.vel.addScaledVector(acc, dt);
      this.pos.addScaledVector(this.vel, dt);
    }

    // Repos : posée 1 ; en chute, ailes presque arrêtées, qui reprennent en se rattrapant.
    const recovering = this.mood === "recover" ? smooth(Math.min(1, since / RECOVER_MS)) : 1;
    const restTarget = perched ? 1 : this.mood === "fall" ? 0.6 : this.mood === "recover" ? 0.6 * (1 - recovering) : 0;
    this.rest += (restTarget - this.rest) * (1 - Math.exp(-dt * (this.mood === "fall" ? 8 : 4)));
    const tumble = this.mood === "fall" ? 1 - since / FALL_MS : this.mood === "recover" ? Math.max(0, 0.4 - since / RECOVER_MS) : 0;
    const arriving = this.mood === "approach" ? smooth(Math.min(1, (now - this.moodSince) / APPROACH_MS)) : 0;
    this.world.shared.uBias.value = PERCH_BIAS * Math.max(this.rest, arriving);
    this.world.shared.uSolid.value = Math.max(0.01, -this.pos.z);
    // Vol stationnaire : un léger tremblé vertical (pas posée).
    const shown = this.pos.clone().add(new THREE.Vector3(0, 0.006 * Math.sin(t * 17) * (1 - this.rest), 0));
    const ahead = this.chest ? this.pos.z - this.chest.z : 0; // > 0 : devant la personne
    const scale = THREE.MathUtils.clamp(1 + ahead * DEPTH_SCALE, SCALE_MIN, SCALE_MAX) * (1 - (1 - PERCH_SCALE) * this.rest);
    this.fairy.update(shown, this.vel, t, dt, scale, this.rest, tumble);
    this.world.render();
  }

  // --- Les mains --------------------------------------------------------------------------------

  /** Main à plat, paume vers le ciel ? Et où est chaque paume (reflet, repère Three), à quelle vitesse. */
  private watchHands(occ: Occlusion | null, present: boolean, now: number): void {
    const [w, h] = this.frameSize();
    const states = handStates(this.scene, now, w, h);
    for (const side of ["left", "right"] as const) {
      const info = this.hands[side];
      const s = states.find((x) => x.track.side === side);
      if (s) info.ups = [...info.ups, s.palmUp].slice(-3);
      // Orientation de la paume bruitée (mains petites à 2 m) : la plus haute des 3 dernières.
      // Pour venir : vraie main à plat. Pour rester : main pas fermée, pas retournée, pas
      // baissée (un doigt mal vu une image ne doit pas la faire partir).
      const up = info.ups.length ? Math.max(...info.ups) : -1;
      const flat = !!s && present && s.extended >= 3 && s.reach >= FLAT_REACH && up >= FLAT_UP && s.anchored && Math.abs(s.height) < 1.2;
      const holding = !!s && present && !s.closed && up > HOLD_UP && s.anchored && s.height < 1.4;
      info.closed = !!s && s.closed;
      info.flatSince = flat ? info.flatSince || now : 0;
      info.notFlatSince = holding ? 0 : info.notFlatSince || now;
      if (occ && present) {
        const palm = reflected(side === "left" ? occ.body.lp : occ.body.rp);
        if (info.palm && occ.at !== info.palmAt) {
          const dt = Math.max(0.01, (occ.at - info.palmAt) / 1000);
          info.speed += (palm.distanceTo(info.palm) / dt - info.speed) * 0.5;
          info.vy += ((palm.y - info.palm.y) / dt - info.vy) * 0.3;
          // Hauteur habituelle de la main : suit lentement (une main qu'on baisse doucement
          // emporte la fée avec elle).
          info.restY += (palm.y - info.restY) * (1 - Math.exp(-dt / 0.6));
        }
        if (!info.palm) info.restY = palm.y;
        if (occ.at !== info.palmAt) info.palm = palm;
        info.palmAt = occ.at;
      } else {
        info.palm = null;
        info.speed = 0;
        info.vy = 0;
      }
    }
  }

  private flatFor(side: Side, now: number): number {
    const f = this.hands[side].flatSince;
    return f ? now - f : 0;
  }

  /** Où elle se pose sur la paume de cette main (avec un petit saut de temps en temps). */
  private perchSpot(side: Side, now: number): THREE.Vector3 | null {
    const palm = this.hands[side].palm;
    if (!palm) return null;
    const hop = now - this.hopAt < HOP_MS ? Math.sin((Math.PI * (now - this.hopAt)) / HOP_MS) * 0.03 : 0;
    return palm.clone().addScaledVector(UP, PERCH_HEIGHT + hop);
  }

  // --- Comportement -----------------------------------------------------------------------------

  private setMood(mood: Mood, now: number): void {
    this.mood = mood;
    this.moodSince = now;
  }

  private target(occ: Occlusion | null, present: boolean, now: number, t: number, dt: number): THREE.Vector3 {
    if (!present || !occ) {
      if (this.mood === "perched") this.fall(now);
      if (this.mood === "fall") return this.pos.clone();
      if (this.mood !== "takeoff" || now - this.moodSince > TAKEOFF_MS) this.setMood("wander", now);
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
    const since = now - this.moodSince;

    switch (this.mood) {
      case "perched": {
        const side = this.perch!;
        const info = this.hands[side];
        const other: Side = side === "left" ? "right" : "left";
        const spot = this.perchSpot(side, now);
        // Main retirée sous elle (descend vite, perdue) : elle tombe. Geste brusque vers le haut
        // ou de côté : elle s'envole d'un coup. Main fermée : elle s'envole d'un bond. Main
        // retournée ou baissée doucement : elle tombe aussi.
        if (!spot || (info.vy < -DROP_SPEED && info.palm!.y < info.restY - DROP_DEPTH)) return this.fall(now);
        if (info.speed > STARTLE_SPEED) return this.takeoff(now, true);
        if (info.notFlatSince && now - info.notFlatSince > LEAVE_MS) return info.closed ? this.takeoff(now, false) : this.fall(now);
        // L'autre main à plat tout près : elle saute dessus.
        const otherPalm = this.hands[other].palm;
        if (this.flatFor(other, now) > FLAT_MS && otherPalm && otherPalm.distanceTo(info.palm!) < HOP_TO_OTHER) {
          this.goTo(other, now, true);
          return spot;
        }
        if (now > this.nextHop) {
          this.hopAt = now;
          this.nextHop = now + 2200 + Math.random() * 2500;
        }
        return spot;
      }
      case "notice": {
        // Elle a vu la main : petit tour sur elle-même, sur place.
        const spot = this.perchSpot(this.perch!, now);
        const gone = this.hands[this.perch!].notFlatSince;
        if (!spot || (gone && now - gone > LEAVE_MS)) return this.backToOrbit(now, head, hips, t, dt);
        if (since > NOTICE_MS) {
          this.from.copy(this.pos);
          this.fromAngle = Math.atan2(this.pos.z - spot.z, this.pos.x - spot.x);
          this.setMood("approach", now);
        }
        const a = (since / NOTICE_MS) * Math.PI * 2;
        return this.from.clone().add(new THREE.Vector3(0.035 * Math.cos(a), 0.035 * Math.sin(a), 0));
      }
      case "approach": {
        // En spirale vers la paume : le rayon et la hauteur fondent à l'arrivée.
        const spot = this.perchSpot(this.perch!, now);
        const info = this.hands[this.perch!];
        if (!spot || (info.notFlatSince && now - info.notFlatSince > LEAVE_MS)) return this.backToOrbit(now, head, hips, t, dt);
        const u = Math.min(1, since / APPROACH_MS);
        const e = smooth(u);
        const r = Math.max(0.05, this.from.distanceTo(spot)) * (1 - e) * 0.6;
        const a = this.fromAngle + u * Math.PI * 1.6;
        const out = spot.clone().add(new THREE.Vector3(r * Math.cos(a), 0.12 * (1 - e) * Math.sin(Math.PI * u) + r * 0.3, r * Math.sin(a)));
        if (u >= 1 && this.pos.distanceTo(spot) < 0.04) {
          this.setMood("perched", now);
          this.nextHop = now + 1800;
          this.fairy?.sparkle(30, 1.2);
          this.chime([1568, 2093, 2637]);
        }
        return out;
      }
      case "takeoff":
        if (since > TAKEOFF_MS) this.setMood("orbit", now);
        return this.pos.clone().addScaledVector(this.vel, 0.15);
      case "fall":
        return this.pos.clone();
      case "recover":
        if (since > RECOVER_MS) this.setMood("orbit", now);
        return this.recoverTo.clone();
      default:
        // Main à plat tenue : elle la remarque (la plus haute des deux si elles le sont toutes les
        // deux). Pas quand le menu est ouvert : la main qui l'a ouvert est à plat, paume au ciel.
        for (const side of ["right", "left"] as const) {
          if (!this.busy() && this.flatFor(side, now) > FLAT_MS && this.hands[side].palm) {
            this.goTo(side, now, false);
            return this.pos.clone();
          }
        }
        if (this.mood !== "orbit") this.setMood("orbit", now);
        return this.orbit(head, hips, now, t, dt);
    }
  }

  /** Vers une main : la remarque d'abord (ou, si elle saute d'une main à l'autre, directement). */
  private goTo(side: Side, now: number, hop: boolean): void {
    this.perch = side;
    this.from.copy(this.pos);
    this.fairy?.sparkle(hop ? 8 : 14, 0.8);
    if (hop) {
      const spot = this.perchSpot(side, now)!;
      this.fromAngle = Math.atan2(this.pos.z - spot.z, this.pos.x - spot.x);
      this.setMood("approach", now);
      this.moodSince = now - APPROACH_MS * 0.55; // un saut : la fin de l'approche seulement
    } else {
      this.setMood("notice", now);
      this.chime([2349, 2637]);
    }
  }

  /** Plus de main sous elle : elle tombe (puis se rattrape, voir frame). */
  private fall(now: number): THREE.Vector3 {
    this.vel.set(this.vel.x * 0.3, Math.min(0, this.vel.y), this.vel.z * 0.3);
    this.perch = null;
    this.leftHandAt = now;
    this.setMood("fall", now);
    return this.pos.clone();
  }

  /** Elle s'envole : d'un bond (main fermée), ou d'un coup (geste brusque). */
  private takeoff(now: number, startled: boolean): THREE.Vector3 {
    this.vel.addScaledVector(UP, startled ? 1.6 : 0.7).add(new THREE.Vector3((Math.random() - 0.5) * (startled ? 1.2 : 0.4), 0, (Math.random() - 0.5) * 0.4));
    this.fairy?.sparkle(startled ? 45 : 20, startled ? 2.2 : 1.0);
    this.chime(startled ? [2637, 2093, 1568] : [1760, 2349]);
    this.perch = null;
    this.leftHandAt = now;
    this.setMood("takeoff", now);
    return this.pos.clone();
  }

  private backToOrbit(now: number, head: THREE.Vector3, hips: THREE.Vector3, t: number, dt: number): THREE.Vector3 {
    this.perch = null;
    this.leftHandAt = now;
    this.setMood("orbit", now);
    return this.orbit(head, hips, now, t, dt);
  }

  /**
   * Autour du corps, suivant une figure qui change toutes les 7 à 11 s (en fondu) ; derrière
   * (plus loin que la poitrine) : cachée par le reflet.
   */
  private orbit(head: THREE.Vector3, hips: THREE.Vector3, now: number, t: number, dt: number): THREE.Vector3 {
    if (now - this.pathSince > this.pathFor) {
      this.prevPath = this.path;
      const others = PATHS.filter((p) => p !== this.path);
      this.path = others[Math.floor(Math.random() * others.length)];
      this.pathSince = now;
      this.pathFor = 7000 + Math.random() * 4000;
      if (Math.random() < 0.4) this.dir = -this.dir;
    }
    this.angle += dt * this.dir * PATH_SPEED[this.path] * (1 + 0.2 * Math.sin(t * 0.31));
    const body = { c: this.chest!, head, hips };
    const next = this.pathPoint(this.path, body, t, (now - this.pathSince) / 1000);
    const k = Math.min(1, (now - this.pathSince) / PATH_BLEND_MS);
    const out = k >= 1 || !this.prevPath ? next : this.pathPoint(this.prevPath, body, t, Infinity).lerp(next, smooth(k));
    return this.outsideBody(out, head, hips);
  }

  /**
   * Jamais dans le corps : entre les hanches et le haut de la tête, la cible est repoussée hors
   * d'un ovale autour de la poitrine (épaules, bras le long du corps, épaisseur du buste). Dedans,
   * elle était à la même distance que le corps : à moitié cachée, un effet bizarre.
   */
  private outsideBody(p: THREE.Vector3, head: THREE.Vector3, hips: THREE.Vector3): THREE.Vector3 {
    const c = this.chest!;
    if (p.y < hips.y - 0.15 || p.y > head.y + 0.15) return p;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const e = (dx / BODY_HALF_WIDTH) ** 2 + (dz / BODY_HALF_DEPTH) ** 2;
    if (e >= 1) return p;
    const k = 1 / Math.sqrt(Math.max(e, 1e-4));
    return new THREE.Vector3(c.x + dx * k, p.y, c.z + dz * k);
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
    // Profondeur : loin derrière, moins loin devant (elle ne vient pas trop près de la vitre).
    const depth = (z: number, behind: number) => c.z + z * (z > 0 ? FRONT_DEPTH : behind);
    switch (path) {
      case "ellipse": {
        // Ellipse profonde et inclinée : monte d'un côté, descend de l'autre.
        const rx = 0.48 + 0.06 * Math.sin(t * 0.3);
        return new THREE.Vector3(c.x + rx * Math.cos(a), mid + 0.24 * Math.sin(a + 0.9), depth(Math.sin(a), 0.72));
      }
      case "saddle":
        // Boucle en selle : deux bosses par tour, haut devant et derrière, bas sur les côtés.
        return new THREE.Vector3(c.x + 0.52 * Math.sin(a), mid + 0.1 - 0.3 * Math.cos(2 * a), depth(Math.cos(a), 0.62));
      case "spiral": {
        // Spirale : monte de la taille au-dessus de la tête, puis redescend (en 9 s).
        const u = 0.5 - 0.5 * Math.cos((Math.min(since, 1e6) / 9) * Math.PI * 2);
        return new THREE.Vector3(c.x + 0.42 * Math.cos(a), hips.y - 0.05 + (top - hips.y + 0.05) * u, depth(Math.sin(a), 0.6));
      }
      case "visit": {
        // Visite : passe devant le visage, puis repart large derrière.
        const front = Math.max(0, Math.cos(a));
        return new THREE.Vector3(c.x + 0.55 * Math.sin(a) * (1 - 0.6 * front), head.y - 0.05 - 0.25 * (1 - front), c.z + 0.25 * front - 0.6 * (1 - front) * Math.abs(Math.sin(a * 0.5)));
      }
    }
  }

  /** Petites notes cristallines qui s'éteignent. */
  private chime(notes: number[]): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const t0 = ctx.currentTime + 0.01;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.07);
        g.gain.linearRampToValueAtTime(0.07, t0 + i * 0.07 + 0.01);
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

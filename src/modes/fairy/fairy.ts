// La fée : une boule de lumière bleutée, quatre ailes qui battent vite, une traînée d'étincelles.
// (Clin d'œil aux fées compagnes des jeux d'aventure ; dessin et sons originaux.)
import * as THREE from "three";
import { glowMaterial, sparkMaterial, wingMaterial, type SharedUniforms } from "./world";

const SPARKS = 480;
/** Battement des ailes (Hz) : en vol, posée (lent, comme un papillon qui se repose). */
const FLAP_HZ = 13;
const REST_FLAP_HZ = 1.6;

export class Fairy {
  readonly group = new THREE.Group();
  /** Lumière (halo, lueur, cœur) : toujours face à l'œil. */
  private body = new THREE.Group();
  /** Ailes : tournent avec la fée (cap, tangage, roulis) ; on la voit de profil, de dos… */
  private rig = new THREE.Group();
  private yaw = 0;
  private pitch = 0;
  private roll = 0;
  private halo: THREE.Mesh;
  private core: THREE.Mesh;
  private glow: THREE.Mesh;
  private wings: { pivot: THREE.Group; base: number; side: number; lift: number }[] = [];
  private sparks: THREE.Points;
  private sparkPos = new Float32Array(SPARKS * 3);
  private sparkVel = new Float32Array(SPARKS * 3);
  private sparkLife = new Float32Array(SPARKS);
  private sparkSize = new Float32Array(SPARKS);
  private sparkAge = new Float32Array(SPARKS);
  private sparkDur = new Float32Array(SPARKS);
  private nextSpark = 0;
  private spawnDebt = 0;
  /** Éclat (0–1) : quand elle se pose sur une main, quand elle salue. */
  private flash = 0;
  /** Opacité de toute la fée (apparition / disparition avec le menu). */
  readonly fade = { value: 1 };
  private flapPhase = 0;

  constructor(world: SharedUniforms) {
    // Ses matériaux ont leur propre fondu ; le reste (silhouette, écran…) est partagé.
    const shared: SharedUniforms = { ...world, uFade: this.fade };
    const blue = new THREE.Color(0.45, 0.8, 1.0);
    const white = new THREE.Color(1, 1, 1);
    const quad = (size: number) => new THREE.PlaneGeometry(size, size);
    // Halo large et doux, lueur moyenne, cœur blanc.
    this.halo = new THREE.Mesh(quad(0.34), glowMaterial(shared, blue, 3.0, 0.55));
    this.glow = new THREE.Mesh(quad(0.12), glowMaterial(shared, blue.clone().lerp(white, 0.3), 3.5, 1.4));
    this.core = new THREE.Mesh(quad(0.045), glowMaterial(shared, white, 2.5, 2.2));
    this.body.add(this.halo, this.glow, this.core);

    // Ailes : deux grandes en haut, deux petites en bas, attachées au centre.
    const wingColor = new THREE.Color(0.75, 0.92, 1.0);
    for (const [side, lift, length, width] of [
      [1, 0.5, 0.13, 0.085],
      [-1, 0.5, 0.13, 0.085],
      [1, -0.5, 0.09, 0.06],
      [-1, -0.5, 0.09, 0.06],
    ] as const) {
      const geo = new THREE.PlaneGeometry(length, width);
      geo.translate(length / 2, 0, 0); // pivot à la pointe
      const mesh = new THREE.Mesh(geo, wingMaterial(shared, wingColor));
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.scale.x = side; // aile gauche : symétrique
      this.rig.add(pivot);
      this.wings.push({ pivot, base: 0, side, lift });
    }
    this.rig.rotation.order = "YXZ";
    this.group.add(this.rig, this.body);

    // Étincelles : dans le monde (elles restent là où la fée est passée).
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.sparkPos, 3));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.sparkLife, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.sparkSize, 1));
    this.sparks = new THREE.Points(geo, sparkMaterial(shared, new THREE.Color(0.55, 0.85, 1.0)));
    this.sparks.frustumCulled = false;
  }

  /** À ajouter à la scène (les étincelles ne suivent pas la fée). */
  get objects(): THREE.Object3D[] {
    return [this.sparks, this.group];
  }

  /** Éclat bref (posée sur une main, bonjour). */
  sparkle(amount = 40, energy = 1.6): void {
    this.flash = 1;
    for (let i = 0; i < amount; i++) this.spawn(this.group.position, energy);
  }

  /** Gerbe d'étincelles ailleurs qu'autour d'elle (une bulle qui éclot, qui éclate). */
  burstAt(at: THREE.Vector3, amount: number, energy: number): void {
    for (let i = 0; i < amount; i++) this.spawn(at, energy);
  }

  /**
   * Place la fée et anime ailes, lueur et étincelles. `scale` : taille (profondeur) ; `rest` :
   * 0 en vol, 1 posée (ailes lentes et ouvertes, lueur qui respire, presque pas d'étincelles).
   */
  update(position: THREE.Vector3, velocity: THREE.Vector3, t: number, dt: number, scale = 1, rest = 0, tumble = 0): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
    // Orientation : face à sa route (de profil quand elle file sur le côté, de face quand elle
    // vient vers nous) ; posée, elle regarde vers nous en tournant un peu la tête. Elle penche
    // dans les virages et pique du nez en accélérant. `tumble` : elle tournoie (chute).
    const flat = Math.hypot(velocity.x, velocity.z);
    const look = flat > 0.12 && rest < 0.5 ? Math.atan2(velocity.x, velocity.z) : 0.45 * Math.sin(t * 0.6) * rest;
    const k = 1 - Math.exp(-dt * (flat > 0.12 ? 6 : 2.5));
    this.yaw += Math.atan2(Math.sin(look - this.yaw), Math.cos(look - this.yaw)) * k;
    this.pitch += (THREE.MathUtils.clamp(flat * 0.35, 0, 0.45) * (1 - rest) - this.pitch) * k;
    this.roll += (THREE.MathUtils.clamp(-velocity.x * 0.6, -0.5, 0.5) * (1 - rest) - this.roll) * k;
    this.rig.rotation.set(this.pitch + tumble * 0.6 * Math.sin(t * 9), this.yaw, this.roll + tumble * Math.sin(t * 7));
    this.flapPhase += dt * Math.PI * 2 * THREE.MathUtils.lerp(FLAP_HZ, REST_FLAP_HZ, rest);
    const flap = Math.sin(this.flapPhase);
    for (const w of this.wings) {
      // Les ailes tournent autour de l'axe vertical (elles se replient vers l'arrière) et
      // pointent un peu vers le haut ou le bas. Posée : amplitude réduite, ailes plus relevées.
      // (Aile gauche : le miroir en x inverse le sens des deux rotations.)
      const amp = THREE.MathUtils.lerp(0.75, 0.45, rest);
      const fold = (0.35 + amp * (0.5 + 0.5 * flap)) * (w.lift > 0 ? 1 : 0.8);
      w.pivot.rotation.set(0, fold * w.side, w.lift * (0.9 + 0.35 * rest) * w.side);
    }
    this.flash = Math.max(0, this.flash - dt * 1.6);
    // Posée : la lueur respire lentement.
    const breath = rest * 0.18 * Math.sin(t * 2.2);
    const pulse = 1 + 0.08 * (1 - rest) * Math.sin(t * 5.3) + breath + 0.6 * this.flash;
    this.halo.scale.setScalar(pulse * (1 + 0.15 * this.flash));
    this.glow.scale.setScalar(1 + 0.05 * Math.sin(t * 9.1) + 0.3 * this.flash);

    // Traînée : plus elle va vite, plus elle sème.
    const speed = velocity.length();
    this.spawnDebt += dt * (25 * (1 - 0.8 * rest) + 90 * Math.min(1, speed / 0.8));
    while (this.spawnDebt >= 1) {
      this.spawnDebt -= 1;
      this.spawn(position, 1);
    }
    for (let i = 0; i < SPARKS; i++) {
      if (this.sparkDur[i] <= 0) continue;
      this.sparkAge[i] += dt;
      const k = this.sparkAge[i] / this.sparkDur[i];
      if (k >= 1) {
        this.sparkDur[i] = 0;
        this.sparkLife[i] = 0;
        continue;
      }
      this.sparkVel[i * 3 + 1] -= 0.12 * dt; // retombent doucement
      for (let a = 0; a < 3; a++) this.sparkPos[i * 3 + a] += this.sparkVel[i * 3 + a] * dt;
      this.sparkLife[i] = (1 - k) * (0.6 + 0.4 * Math.sin(this.sparkAge[i] * 30 + i)); // scintillent
    }
    const g = this.sparks.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  private spawn(at: THREE.Vector3, energy: number): void {
    const i = this.nextSpark;
    this.nextSpark = (i + 1) % SPARKS;
    const r = () => (Math.random() - 0.5) * 2;
    this.sparkPos.set([at.x + r() * 0.015, at.y + r() * 0.015, at.z + r() * 0.015], i * 3);
    this.sparkVel.set([r() * 0.06 * energy, r() * 0.06 * energy - 0.02, r() * 0.06 * energy], i * 3);
    this.sparkAge[i] = 0;
    this.sparkDur[i] = 0.5 + Math.random() * 0.7;
    this.sparkSize[i] = 0.006 + Math.random() * 0.01;
    this.sparkLife[i] = 1;
  }
}

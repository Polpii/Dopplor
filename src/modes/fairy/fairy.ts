// La fée : une boule de lumière bleutée, quatre ailes qui battent vite, une traînée d'étincelles.
// (Clin d'œil aux fées compagnes des jeux d'aventure ; dessin et sons originaux.)
import * as THREE from "three";
import { glowMaterial, sparkMaterial, wingMaterial, type SharedUniforms } from "./world";

const SPARKS = 220;
/** Battement des ailes (Hz). */
const FLAP_HZ = 13;

export class Fairy {
  readonly group = new THREE.Group();
  private body = new THREE.Group();
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

  constructor(shared: SharedUniforms) {
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
      [1, 0.55, 0.13, 0.07],
      [-1, 0.55, 0.13, 0.07],
      [1, -0.45, 0.09, 0.05],
      [-1, -0.45, 0.09, 0.05],
    ] as const) {
      const geo = new THREE.PlaneGeometry(length, width);
      geo.translate(length / 2, 0, 0); // pivot à la pointe
      const mesh = new THREE.Mesh(geo, wingMaterial(shared, wingColor));
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.scale.x = side; // aile gauche : symétrique
      this.body.add(pivot);
      this.wings.push({ pivot, base: 0, side, lift });
    }
    this.group.add(this.body);

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
  sparkle(): void {
    this.flash = 1;
    for (let i = 0; i < 40; i++) this.spawn(this.group.position, 1.6);
  }

  /** Place la fée et anime ailes, lueur et étincelles. `scale` : taille (profondeur). */
  update(position: THREE.Vector3, velocity: THREE.Vector3, t: number, dt: number, scale = 1): void {
    this.group.position.copy(position);
    this.group.scale.setScalar(scale);
    // Penche dans le sens où elle vole, comme un insecte.
    this.body.rotation.z = THREE.MathUtils.clamp(-velocity.x * 0.6, -0.5, 0.5);
    const flap = Math.sin(t * Math.PI * 2 * FLAP_HZ);
    for (const w of this.wings) {
      // Les ailes tournent autour de l'axe vertical (elles se replient vers l'arrière) et
      // pointent un peu vers le haut ou le bas.
      // (Aile gauche : le miroir en x inverse le sens des deux rotations.)
      const fold = (0.35 + 0.75 * (0.5 + 0.5 * flap)) * (w.lift > 0 ? 1 : 0.8);
      w.pivot.rotation.set(0, fold * w.side, w.lift * 0.9 * w.side);
    }
    this.flash = Math.max(0, this.flash - dt * 1.6);
    const pulse = 1 + 0.08 * Math.sin(t * 5.3) + 0.6 * this.flash;
    this.halo.scale.setScalar(pulse * (1 + 0.15 * this.flash));
    this.glow.scale.setScalar(1 + 0.05 * Math.sin(t * 9.1) + 0.3 * this.flash);

    // Traînée : plus elle va vite, plus elle sème.
    const speed = velocity.length();
    this.spawnDebt += dt * (25 + 90 * Math.min(1, speed / 0.8));
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

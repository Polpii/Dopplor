// Mode bulles : de belles bulles bleu néon, bien rondes, flottent dans la pièce du reflet comme de
// vraies bulles (dérive lente et courbe) ; on les éclate du bout du doigt. Pop : la bulle gonfle
// d'un coup dans un éclair, puis éclate en gouttelettes qui retombent en scintillant, un anneau
// néon s'élargit, et ça fait « pop ». Une nouvelle bulle naît ailleurs.
//
// Les bulles sont fixes dans l'espace du reflet, comme de vrais objets : une bulle près de la
// table reste près de la table dans le reflet. Si la personne se décale, elles glissent à l'écran
// (chacune selon sa distance) et d'autres entrent dans le champ : elles occupent un grand volume
// (~4 m de large) autour de l'endroit où le mode a commencé. Celles de derrière, plus petites,
// passent derrière le corps. On les touche là où le doigt les recouvre dans le reflet dessiné.
import * as THREE from "three";
import type { MirrorWorld, SharedUniforms } from "../fairy/world";

/** Une main dans le reflet dessiné : bouts des doigts (px CSS). */
export interface Fingertips {
  tips: [number, number][];
}

const COLOR = new THREE.Color("#2f8dff");
/** Volume des bulles dans le reflet (m) : largeur, et profondeur autour du reflet de la personne
 * (devant + / derrière −). ~9 bulles dans le champ de l'écran. */
const WIDTH = 4;
const COUNT = 30;
const FRONT = 0.5;
const BACK = 0.7;
/** Rayon (m) : petites derrière, grosses devant (en plus de la perspective). */
const R_BACK = 0.045;
const R_FRONT = 0.085;
/** Dérive (m/s). */
const DRIFT = 0.06;
const GROW_MS = 700;
const POP_MS = 140;
const SPARKS = 600;
const RINGS = 8;

const OCCLUSION = /* glsl */ `
uniform sampler2D uOcc;
uniform vec2 uRes;
uniform float uScale;
uniform float uHasOcc;
uniform vec2 uCell;
uniform float uSolid;
// Bord franc : la bulle est cachée derrière le corps (même une jambe), elle ne s'y fond pas.
float visible() {
  if (uHasOcc < 0.5) return 1.0;
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec2 o = texture2D(uOcc, uv).rg;
  float cover = smoothstep(0.35, 0.65, o.g);
  if (cover < 0.002) return 1.0;
  float behind = 1.0 - smoothstep(-0.01, 0.01, o.r * 255.0 * uScale - uSolid);
  return 1.0 - cover * behind;
}`;

/** Distance d'un point (px, py) au segment [a, b]. */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Bulle bleu néon, bien ronde : bord lumineux, remplissage plus dense vers le bord, reflet. */
function bubbleMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    // Jamais découpées par le corps : le bord du masque se voyait sur les bulles.
    uniforms: { ...shared, uHasOcc: { value: 0 }, uSolid: { value: 1 }, uColor: { value: COLOR }, uPop: { value: 0 }, uAppear: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${OCCLUSION}
      uniform vec3 uColor;
      uniform float uPop;
      uniform float uAppear;
      varying vec2 vUv;
      void main() {
        // Quad de 3 rayons : la bulle a un rayon 1/1,5 du demi-côté.
        vec2 p = (vUv * 2.0 - 1.0) * 1.5;
        float r = length(p) / (1.0 + 0.25 * uPop);
        float inside = 1.0 - smoothstep(0.985, 1.0, r);
        float rim = exp(-pow((r - 0.975) / 0.045, 2.0));
        float halo = exp(-pow(max(0.0, r - 1.0) / 0.2, 2.0)) * 0.5;
        float body = inside * (0.1 + 0.4 * pow(r, 3.0));
        // Reflet brillant en haut à gauche, un petit en bas à droite.
        float shine = inside * (exp(-dot(p - vec2(-0.4, 0.42), p - vec2(-0.4, 0.42)) * 26.0) * 0.85 + exp(-dot(p - vec2(0.42, -0.5), p - vec2(0.42, -0.5)) * 70.0) * 0.35);
        float flash = uPop * 1.5;
        vec3 col = uColor * (body + rim * 1.9 + halo) + vec3(1.0) * (shine + rim * 0.2 + flash * (inside * 0.5 + rim));
        float alpha = clamp(body + rim + halo + shine + flash * inside, 0.0, 1.0);
        float v = visible() * uAppear * (1.0 - smoothstep(0.6, 1.0, uPop));
        gl_FragColor = vec4(col * v, alpha * v);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Gouttelettes du pop : points ronds qui retombent et scintillent. */
function sparkMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uColor: { value: COLOR } },
    vertexShader: /* glsl */ `
      uniform vec2 uRes;
      attribute float aSize;
      attribute float aLife;
      varying float vLife;
      void main() {
        vLife = aLife;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = aSize * aLife * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vLife;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 3.5) * vLife;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.4 * vLife) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uColor: { value: COLOR } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uAlpha;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        float a = exp(-pow((r - 0.85) / 0.05, 2.0)) * uAlpha;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.3) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

interface Bubble {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Place et vitesse dans le reflet (m, m/s), rayon (m). */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  r: number;
  phase: number;
  bornAt: number;
  poppedAt: number;
}

export class BubbleMode {
  readonly id = "bubbles";
  private active = false;
  private group = new THREE.Group();
  private bubbles: Bubble[] = [];
  private last = 0;
  private needSpawn = false;
  private audio: AudioContext | null = null;
  private sparks: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private sPos = new Float32Array(SPARKS * 3);
  private sVel = new Float32Array(SPARKS * 3);
  private sLife = new Float32Array(SPARKS);
  private sSize = new Float32Array(SPARKS);
  private sAge = new Float32Array(SPARKS);
  private sDur = new Float32Array(SPARKS);
  private nextSpark = 0;
  /** Volume des bulles dans le reflet (fixé à l'entrée dans le mode). */
  private box = new THREE.Box3();
  private fixedEye = new THREE.Vector3();
  /** Bouts des doigts à l'image précédente : un geste rapide qui traverse une bulle l'éclate. */
  private prevTips: [number, number][] = [];
  private rings: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; at: number; r: number }[] = [];

  constructor(
    private world: MirrorWorld,
    private hands: () => Fingertips[],
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < COUNT; i++) {
      const mesh = new THREE.Mesh(quad, bubbleMaterial(world.shared));
      this.group.add(mesh);
      this.bubbles.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), r: 0.05, phase: Math.random() * 100, bornAt: 0, poppedAt: 0 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.sPos, 3));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.sLife, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.sSize, 1));
    this.sparks = new THREE.Points(geo, sparkMaterial());
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);
    for (let i = 0; i < RINGS; i++) {
      const mesh = new THREE.Mesh(quad, ringMaterial());
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, at: -Infinity, r: 0.05 });
    }
    this.group.visible = false;
    world.scene.add(this.group);
  }

  get on(): boolean {
    return this.active;
  }

  get visible(): boolean {
    return this.active;
  }

  enter(now = performance.now()): void {
    this.active = true;
    this.group.visible = true;
    this.last = now;
    this.needSpawn = true;
    this.prevTips = [];
    // Vue fixe : les bulles restent où elles sont à l'écran quand on bouge la tête (elles ne
    // suivent plus le regard ; elles dérivent seulement, comme de vraies bulles).
    this.world.viewEye = () => {
      const [sw, sh] = this.world.screenMeters;
      return this.fixedEye.set(sw / 2, -sh * 0.3, 2);
    };
  }

  exit(): void {
    this.active = false;
    this.group.visible = false;
    this.world.viewEye = null;
  }

  /** Point de l'écran (px CSS) → 3D à la profondeur `z` (Three), sur le regard de l'œil. */
  private unproject(x: number, y: number, z: number): THREE.Vector3 {
    const [sw, sh, gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    const glass = new THREE.Vector3((x / window.innerWidth) * sw, -(y / window.innerHeight) * sh, -gap);
    return eye.clone().lerp(glass, (z - eye.z) / (glass.z - eye.z));
  }

  /**
   * Le volume des bulles dans le reflet : centré sur ce que montre l'écran, ~4 m de large,
   * de la hauteur vue à l'écran, et en profondeur autour de son reflet. Fixe ensuite (la pièce).
   */
  private makeBox(): void {
    const eye = this.world.camera.position;
    const body = -eye.z;
    // Centré sur ce que montre l'écran (dans un miroir, quelqu'un à droite voit le reflet de gauche).
    const center = this.unproject(window.innerWidth / 2, window.innerHeight / 2, body).x;
    const top = this.unproject(window.innerWidth / 2, window.innerHeight * 0.06, body).y;
    const bottom = this.unproject(window.innerWidth / 2, window.innerHeight * 0.95, body).y;
    this.box.min.set(center - WIDTH / 2, bottom, body - BACK);
    this.box.max.set(center + WIDTH / 2, top, body + FRONT);
  }

  /** Rayon selon la profondeur : petites derrière, grosses devant. */
  private radiusAt(z: number): number {
    const k = (z - this.box.min.z) / (this.box.max.z - this.box.min.z);
    return (R_BACK + (R_FRONT - R_BACK) * Math.min(1, Math.max(0, k))) * (0.85 + Math.random() * 0.3);
  }

  /** Une bulle naît (grossit doucement) quelque part dans le volume, loin des doigts et des autres. */
  private respawn(b: Bubble, now: number, delay: number, avoid: THREE.Vector3[]): void {
    let best = { p: new THREE.Vector3(), score: -Infinity };
    for (let k = 0; k < 10; k++) {
      const p = new THREE.Vector3(
        THREE.MathUtils.lerp(this.box.min.x, this.box.max.x, Math.random()),
        THREE.MathUtils.lerp(this.box.min.y, this.box.max.y, Math.random()),
        THREE.MathUtils.lerp(this.box.min.z, this.box.max.z, Math.random()),
      );
      let score = Infinity;
      for (const o of this.bubbles) if (o !== b && !o.poppedAt) score = Math.min(score, o.pos.distanceTo(p) - o.r);
      for (const a of avoid) score = Math.min(score, a.distanceTo(p) - 0.15);
      if (score > best.score) best = { p, score };
    }
    b.pos.copy(best.p);
    b.r = this.radiusAt(b.pos.z);
    const a = Math.random() * Math.PI * 2;
    b.vel.set(Math.cos(a) * DRIFT * 0.5, Math.sin(a) * DRIFT * 0.5, (Math.random() - 0.5) * DRIFT * 0.3);
    b.bornAt = now + delay;
    b.poppedAt = 0;
  }

  frame(now: number): void {
    if (!this.active || !this.world.ready) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    const t = now / 1000;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tips = this.hands().flatMap((h) => h.tips);
    if (this.needSpawn) {
      this.needSpawn = false;
      this.makeBox();
      this.bubbles.forEach((b, i) => this.respawn(b, now, (i % 10) * 90, []));
    }
    for (const b of this.bubbles) {
      const u = b.mesh.material.uniforms;
      if (b.poppedAt) {
        const k = (now - b.poppedAt) / POP_MS;
        u.uPop.value = Math.min(1, k);
        if (k >= 1) {
          u.uAppear.value = 0;
          this.respawn(b, now, 600 + Math.random() * 1400, [b.pos.clone()]);
        }
        this.place(b);
        continue;
      }
      if (now < b.bornAt) {
        u.uAppear.value = 0;
        continue;
      }
      // Dérive de vraie bulle : un courant d'air doux et changeant, des courbes lentes.
      b.vel.x += (Math.sin(t * 0.37 + b.phase) + 0.6 * Math.sin(t * 0.83 + b.phase * 1.7)) * DRIFT * 0.6 * dt;
      b.vel.y += (Math.cos(t * 0.41 + b.phase * 1.3) + 0.6 * Math.sin(t * 0.67 + b.phase * 0.7)) * DRIFT * 0.6 * dt;
      b.vel.z += Math.sin(t * 0.29 + b.phase * 0.5) * DRIFT * 0.25 * dt;
      // Elles s'écartent doucement des voisines.
      for (const o of this.bubbles) {
        if (o === b || o.poppedAt || now < o.bornAt) continue;
        const d = b.pos.clone().sub(o.pos);
        const l = d.length();
        const min = b.r + o.r + 0.02;
        if (l > 0 && l < min) b.vel.addScaledVector(d.divideScalar(l), (min - l) * 3 * dt);
      }
      b.vel.multiplyScalar(Math.exp(-dt * 0.6));
      if (b.vel.length() > DRIFT) b.vel.setLength(DRIFT);
      b.pos.addScaledVector(b.vel, dt);
      // Rebonds mous aux limites du volume.
      for (const a of ["x", "y", "z"] as const) {
        if (b.pos[a] < this.box.min[a]) b.vel[a] = Math.abs(b.vel[a]) * 0.6;
        if (b.pos[a] > this.box.max[a]) b.vel[a] = -Math.abs(b.vel[a]) * 0.6;
      }
      b.pos.clamp(this.box.min, this.box.max);
      // Naissance : elle grossit doucement (avec un léger rebond).
      const g = Math.min(1, (now - b.bornAt) / GROW_MS);
      u.uAppear.value = Math.min(1, g * 2);
      u.uPop.value = 0;
      this.place(b, easeOutBack(g));
      // Un doigt dessus (dans le reflet) : pop. Zone de toucher généreuse (au moins ~4 % de la
      // hauteur de l'écran, même pour une petite bulle), et le trajet du doigt depuis l'image
      // précédente compte : un geste vif qui la traverse l'éclate aussi.
      if (g > 0.35) {
        const [cx, cy] = this.world.project(b.pos);
        if (cx < 0 || cx > 1 || cy < 0 || cy > 1) continue;
        const [ex] = this.world.project(b.pos.clone().add(new THREE.Vector3(b.r, 0, 0)));
        const hit = Math.max(Math.abs(ex - cx) * W * 1.2, H * 0.04);
        const px = cx * W;
        const py = cy * H;
        for (const [x, y] of tips) {
          const from = this.nearestPrev(x, y, H * 0.15) ?? [x, y];
          if (segmentDistance(px, py, from[0], from[1], x, y) < hit) {
            this.pop(b, now);
            break;
          }
        }
      }
    }
    this.prevTips = tips.map(([x, y]): [number, number] => [x, y]);
    this.sparks.material.uniforms.uRes.value.copy(this.world.shared.uRes.value);
    this.updateSparks(dt);
    this.updateRings(now);
  }

  /** Bout de doigt de l'image précédente le plus proche (le même doigt), s'il n'est pas trop loin. */
  private nearestPrev(x: number, y: number, max: number): [number, number] | null {
    let best: [number, number] | null = null;
    let d = max;
    for (const p of this.prevTips) {
      const e = Math.hypot(p[0] - x, p[1] - y);
      if (e < d) {
        d = e;
        best = p;
      }
    }
    return best;
  }

  /** La bulle en 3D, à sa place dans le reflet. */
  private place(b: Bubble, grow = 1): void {
    b.mesh.position.copy(b.pos);
    b.mesh.scale.setScalar(b.r * 3 * Math.max(0.001, grow));
    b.mesh.material.uniforms.uSolid.value = Math.max(0.01, -b.pos.z);
  }

  /** Pop : éclair, gouttelettes, anneau, son. */
  private pop(b: Bubble, now: number): void {
    b.poppedAt = now;
    const center = b.pos.clone();
    const rM = b.r;
    const n = Math.round(24 + rM * 250);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), Math.sin(a), (Math.random() - 0.5) * 0.5);
      const at = center.clone().addScaledVector(dir, rM * (0.85 + Math.random() * 0.2));
      this.spark(at, dir.multiplyScalar(0.35 + Math.random() * 0.75), 0.008 + Math.random() * 0.014, 0.55 + Math.random() * 0.5);
    }
    const ring = this.rings.reduce((o, r) => (r.at < o.at ? r : o));
    ring.at = now;
    ring.r = rM;
    ring.mesh.position.copy(center);
    ring.mesh.visible = true;
    this.popSound(b.r);
  }

  private spark(at: THREE.Vector3, vel: THREE.Vector3, size: number, dur: number): void {
    const i = this.nextSpark;
    this.nextSpark = (i + 1) % SPARKS;
    this.sPos.set([at.x, at.y, at.z], i * 3);
    this.sVel.set([vel.x, vel.y, vel.z], i * 3);
    this.sSize[i] = size;
    this.sAge[i] = 0;
    this.sDur[i] = dur;
    this.sLife[i] = 1;
  }

  private updateSparks(dt: number): void {
    for (let i = 0; i < SPARKS; i++) {
      if (this.sDur[i] <= 0) continue;
      this.sAge[i] += dt;
      const k = this.sAge[i] / this.sDur[i];
      if (k >= 1) {
        this.sDur[i] = 0;
        this.sLife[i] = 0;
        continue;
      }
      // Ralenties par l'air, puis retombent.
      const drag = Math.exp(-dt * 3);
      this.sVel[i * 3] *= drag;
      this.sVel[i * 3 + 2] *= drag;
      this.sVel[i * 3 + 1] = this.sVel[i * 3 + 1] * drag - 1.4 * dt;
      for (let a = 0; a < 3; a++) this.sPos[i * 3 + a] += this.sVel[i * 3 + a] * dt;
      this.sLife[i] = (1 - k) * (0.7 + 0.3 * Math.sin(this.sAge[i] * 40 + i));
    }
    const g = this.sparks.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aLife.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  private updateRings(now: number): void {
    for (const r of this.rings) {
      const k = (now - r.at) / 380;
      if (k < 0 || k >= 1) {
        if (r.mesh.visible) r.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - k) ** 3;
      r.mesh.scale.setScalar(r.r * 2 * (1.1 + 1.8 * e));
      r.mesh.material.uniforms.uAlpha.value = 1.6 * (1 - k) ** 2;
    }
  }

  /** « Pop » : un petit claquement (bruit filtré) et une note qui tombe, plus grave pour les grosses. */
  private popSound(r: number): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const t0 = ctx.currentTime + 0.003;
      const len = Math.floor(ctx.sampleRate * 0.05);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      const noise = ctx.createBufferSource();
      noise.buffer = buf;
      const band = ctx.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 2200;
      band.Q.value = 1.2;
      const ng = ctx.createGain();
      ng.gain.value = 0.35;
      noise.connect(band).connect(ng).connect(ctx.destination);
      noise.start(t0);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      const f = 900 * (0.06 / Math.max(0.02, r));
      o.frequency.setValueAtTime(f, t0);
      o.frequency.exponentialRampToValueAtTime(f * 0.35, t0 + 0.09);
      g.gain.setValueAtTime(0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.12);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.13);
    } catch {
      // Pas de son.
    }
  }
}

const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

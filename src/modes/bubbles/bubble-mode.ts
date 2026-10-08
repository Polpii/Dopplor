// Mode bulles : de belles bulles bleu néon, bien rondes, flottent devant le miroir comme de vraies
// bulles (dérive lente et courbe, dans tous les sens) ; on les éclate du bout du doigt. Pop : la
// bulle gonfle d'un coup dans un éclair, puis éclate en gouttelettes qui retombent en
// scintillant, un anneau néon s'élargit, et ça fait « pop ». Une nouvelle bulle naît ailleurs.
//
// Les bulles vivent à l'écran (leur place ne dépend pas de la pose : elles ne bougent pas quand
// la personne bouge) ; seule leur profondeur, un peu devant ou derrière le reflet de la personne,
// sert à les cacher derrière son corps. On les touche là où le doigt les recouvre dans le reflet
// dessiné.
import * as THREE from "three";
import type { MirrorWorld, SharedUniforms } from "../fairy/world";

/** Une main dans le reflet dessiné : bouts des doigts (px CSS). */
export interface Fingertips {
  tips: [number, number][];
}

const COUNT = 11;
const COLOR = new THREE.Color("#2f8dff");
/** Rayon à l'écran (part de la largeur de l'écran). */
const R_MIN = 0.035;
const R_MAX = 0.075;
/** Dérive (part de la largeur de l'écran par seconde). */
const DRIFT = 0.035;
/** Profondeur autour du reflet de la personne (m) : devant (+) ou derrière (−). */
const DEPTH = 0.35;
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
float visibleAt(vec2 uv, float zBehind) {
  vec2 o = texture2D(uOcc, uv).rg;
  if (o.g < 0.002) return 1.0;
  float behind = 1.0 - smoothstep(-0.03, 0.03, o.r * 255.0 * uScale - zBehind);
  return 1.0 - o.g * behind;
}
float visible() {
  if (uHasOcc < 0.5) return 1.0;
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec2 c = uCell;
  float z = uSolid;
  return (visibleAt(uv, z) * 2.0 + visibleAt(uv + vec2(c.x, 0.0), z) + visibleAt(uv - vec2(c.x, 0.0), z)
    + visibleAt(uv + vec2(0.0, c.y), z) + visibleAt(uv - vec2(0.0, c.y), z)) / 6.0;
}`;

/** Bulle bleu néon, bien ronde : bord lumineux, remplissage plus dense vers le bord, reflet. */
function bubbleMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSolid: { value: 1 }, uColor: { value: COLOR }, uPop: { value: 0 }, uAppear: { value: 0 } },
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
  /** Place et vitesse à l'écran (px CSS, px/s), rayon (px), profondeur par rapport au reflet (m). */
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  depth: number;
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
  private rings: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; at: number; r: number }[] = [];

  constructor(
    private world: MirrorWorld,
    private hands: () => Fingertips[],
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < COUNT; i++) {
      const mesh = new THREE.Mesh(quad, bubbleMaterial(world.shared));
      this.group.add(mesh);
      this.bubbles.push({ mesh, x: 0, y: 0, vx: 0, vy: 0, r: 60, depth: 0, phase: Math.random() * 100, bornAt: 0, poppedAt: 0 });
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
  }

  exit(): void {
    this.active = false;
    this.group.visible = false;
  }

  /** Point de l'écran (px CSS) → 3D à la profondeur `z` (Three), sur le regard de l'œil. */
  private unproject(x: number, y: number, z: number): THREE.Vector3 {
    const [sw, sh, gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    const glass = new THREE.Vector3((x / window.innerWidth) * sw, -(y / window.innerHeight) * sh, -gap);
    return eye.clone().lerp(glass, (z - eye.z) / (glass.z - eye.z));
  }

  /** Mètres par px d'écran à la profondeur `z`. */
  private metersPerPx(z: number): number {
    const [sw, , gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    return (sw / window.innerWidth) * ((eye.z - z) / (eye.z + gap));
  }

  /** Une bulle naît (grossit doucement) à un endroit libre, loin des doigts et des autres. */
  private respawn(b: Bubble, now: number, tips: [number, number][], delay: number): void {
    const W = window.innerWidth;
    const H = window.innerHeight;
    b.r = (R_MIN + Math.random() * (R_MAX - R_MIN)) * W;
    let best = { x: W / 2, y: H / 2, score: -Infinity };
    for (let k = 0; k < 12; k++) {
      const x = b.r + Math.random() * (W - 2 * b.r);
      const y = H * 0.08 + b.r + Math.random() * (H * 0.84 - 2 * b.r);
      let score = Infinity;
      for (const o of this.bubbles) if (o !== b && !o.poppedAt) score = Math.min(score, Math.hypot(o.x - x, o.y - y) - o.r - b.r);
      for (const [tx, ty] of tips) score = Math.min(score, Math.hypot(tx - x, ty - y) - b.r - 80);
      if (score > best.score) best = { x, y, score };
    }
    b.x = best.x;
    b.y = best.y;
    const a = Math.random() * Math.PI * 2;
    b.vx = Math.cos(a) * DRIFT * W * 0.5;
    b.vy = Math.sin(a) * DRIFT * W * 0.5;
    b.depth = (Math.random() * 2 - 1) * DEPTH;
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
      this.bubbles.forEach((b, i) => this.respawn(b, now, tips, i * 120));
    }
    // Le reflet de la personne : à la distance de son œil, derrière la vitre.
    const plane = -this.world.camera.position.z;
    for (const b of this.bubbles) {
      const u = b.mesh.material.uniforms;
      if (b.poppedAt) {
        const k = (now - b.poppedAt) / POP_MS;
        u.uPop.value = Math.min(1, k);
        if (k >= 1) {
          u.uAppear.value = 0;
          this.respawn(b, now, tips, 600 + Math.random() * 1400);
        }
        this.place(b, plane);
        continue;
      }
      if (now < b.bornAt) {
        u.uAppear.value = 0;
        continue;
      }
      // Dérive de vraie bulle : un courant d'air doux et changeant, des courbes lentes.
      const ax = Math.sin(t * 0.37 + b.phase) + Math.sin(t * 0.83 + b.phase * 1.7) * 0.6;
      const ay = Math.cos(t * 0.41 + b.phase * 1.3) + Math.sin(t * 0.67 + b.phase * 0.7) * 0.6;
      b.vx += ax * DRIFT * W * 0.6 * dt;
      b.vy += ay * DRIFT * W * 0.6 * dt;
      // Elles s'écartent doucement des voisines.
      for (const o of this.bubbles) {
        if (o === b || o.poppedAt || now < o.bornAt) continue;
        const dx = b.x - o.x;
        const dy = b.y - o.y;
        const d = Math.hypot(dx, dy);
        const min = b.r + o.r + 10;
        if (d > 0 && d < min) {
          b.vx += (dx / d) * (min - d) * 3 * dt;
          b.vy += (dy / d) * (min - d) * 3 * dt;
        }
      }
      // Air : vitesse limitée, amortie.
      const damp = Math.exp(-dt * 0.6);
      b.vx *= damp;
      b.vy *= damp;
      const v = Math.hypot(b.vx, b.vy);
      const vmax = DRIFT * W;
      if (v > vmax) {
        b.vx *= vmax / v;
        b.vy *= vmax / v;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      // Rebonds mous sur les bords.
      const top = H * 0.06;
      if (b.x < b.r) b.vx = Math.abs(b.vx) * 0.6;
      if (b.x > W - b.r) b.vx = -Math.abs(b.vx) * 0.6;
      if (b.y < top + b.r) b.vy = Math.abs(b.vy) * 0.6;
      if (b.y > H - b.r) b.vy = -Math.abs(b.vy) * 0.6;
      b.x = Math.min(W - b.r, Math.max(b.r, b.x));
      b.y = Math.min(H - b.r, Math.max(top + b.r, b.y));
      // Naissance : elle grossit doucement (avec un léger rebond).
      const g = Math.min(1, (now - b.bornAt) / GROW_MS);
      u.uAppear.value = Math.min(1, g * 2);
      u.uPop.value = 0;
      this.place(b, plane, easeOutBack(g));
      // Un doigt dessus (dans le reflet) : pop.
      if (g > 0.5) {
        for (const [x, y] of tips) {
          if (Math.hypot(x - b.x, y - b.y) < b.r * 0.95) {
            this.pop(b, now, plane);
            break;
          }
        }
      }
    }
    this.sparks.material.uniforms.uRes.value.copy(this.world.shared.uRes.value);
    this.updateSparks(dt);
    this.updateRings(now);
  }

  /** La bulle en 3D : à sa place à l'écran, à sa profondeur, à sa taille à l'écran. */
  private place(b: Bubble, plane: number, grow = 1): void {
    const z = plane + b.depth;
    b.mesh.position.copy(this.unproject(b.x, b.y, z));
    b.mesh.scale.setScalar(b.r * this.metersPerPx(z) * 3 * Math.max(0.001, grow));
    b.mesh.material.uniforms.uSolid.value = Math.max(0.01, -z);
  }

  /** Pop : éclair, gouttelettes, anneau, son. */
  private pop(b: Bubble, now: number, plane: number): void {
    b.poppedAt = now;
    const z = plane + b.depth;
    const center = this.unproject(b.x, b.y, z);
    const rM = b.r * this.metersPerPx(z);
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
    this.popSound(b.r / window.innerWidth);
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
      const f = 900 * (0.05 / Math.max(0.02, r));
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

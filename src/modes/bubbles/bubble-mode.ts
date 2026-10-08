// Mode bulles : de belles bulles néon, pleines et irisées, montent doucement autour de la personne
// dans son reflet ; on les éclate du bout du doigt. Pop : la bulle gonfle d'un coup dans un éclair,
// puis éclate en gouttelettes de sa couleur qui retombent en scintillant, un anneau néon
// s'élargit, et ça fait « pop ».
//
// Les bulles vivent dans l'espace du reflet (à la distance du reflet de la personne, un peu devant
// ou derrière : celles de derrière sont cachées par son corps). On les touche là où le doigt les
// recouvre dans le reflet dessiné (la profondeur des mains est parfois très fausse).
import * as THREE from "three";
import type { MirrorWorld, SharedUniforms } from "../fairy/world";

/** Une main dans le reflet dessiné : bouts des doigts (px CSS). */
export interface Fingertips {
  tips: [number, number][];
}

const COUNT = 12;
const PALETTE = ["#38e8ff", "#ff4fd8", "#a66bff", "#b8ff3c", "#ff9d3c", "#4fffb0"].map((c) => new THREE.Color(c));
/** Rayon des bulles (m), montée (m/s), balancement. */
const R_MIN = 0.045;
const R_MAX = 0.1;
const RISE = 0.07;
/** Profondeur autour du reflet de la personne (m) : devant (+) ou derrière (−). */
const DEPTH = 0.35;
const POP_MS = 140;
const SPARKS = 700;
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

/** Bulle néon pleine : bord lumineux, voile irisé qui tourne, reflet, forme qui ondule. */
function bubbleMaterial(shared: SharedUniforms, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSolid: { value: 1 }, uColor: { value: color }, uTime: { value: 0 }, uSeed: { value: Math.random() * 10 }, uPop: { value: 0 }, uAppear: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${OCCLUSION}
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uSeed;
      uniform float uPop;
      uniform float uAppear;
      varying vec2 vUv;
      vec3 hue(float h) {
        return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      }
      void main() {
        // Quad de 3 rayons : la bulle a un rayon 1/1,5 du demi-côté.
        vec2 p = (vUv * 2.0 - 1.0) * 1.5;
        float a = atan(p.y, p.x);
        // Ondulation (gelée) : le bord respire en 3 et 5 lobes.
        float wob = 1.0 + 0.035 * sin(a * 3.0 + uTime * 2.1 + uSeed) + 0.02 * sin(a * 5.0 - uTime * 2.9 + uSeed * 2.0);
        float r = length(p) / (wob * (1.0 + 0.25 * uPop));
        float inside = 1.0 - smoothstep(0.97, 1.0, r);
        float rim = exp(-pow((r - 0.97) / 0.06, 2.0));
        float halo = exp(-pow(max(0.0, r - 1.0) / 0.22, 2.0)) * 0.45;
        // Voile irisé (film de savon) qui tourne, sur le fond de sa couleur.
        float film = sin(r * 7.0 - uTime * 1.3 + a * 2.0 + uSeed) * 0.5 + 0.5;
        vec3 iris = mix(uColor, hue(fract(film * 0.35 + uSeed * 0.1 + uTime * 0.04)), 0.35);
        float body = inside * (0.22 + 0.3 * smoothstep(0.35, 1.0, r));
        // Reflet brillant en haut à gauche, et un petit en bas à droite.
        float shine = inside * (exp(-dot(p - vec2(-0.38, 0.42), p - vec2(-0.38, 0.42)) * 22.0) * 0.9 + exp(-dot(p - vec2(0.45, -0.45), p - vec2(0.45, -0.45)) * 60.0) * 0.4);
        float flash = uPop * 1.5;
        vec3 col = iris * (body + rim * 1.6 + halo) + vec3(1.0) * (shine + flash * (inside * 0.6 + rim));
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

/** Gouttelettes du pop : points ronds colorés qui retombent et scintillent. */
function sparkMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSolid: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform vec2 uRes;
      attribute float aSize;
      attribute float aLife;
      attribute vec3 aColor;
      varying float vLife;
      varying vec3 vColor;
      void main() {
        vLife = aLife;
        vColor = aColor;
        vec4 view = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * view;
        gl_PointSize = aSize * aLife * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
      }`,
    fragmentShader: /* glsl */ `
      varying float vLife;
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 3.5) * vLife;
        gl_FragColor = vec4(mix(vColor, vec3(1.0), 0.35 * vLife) * a, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

function ringMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color() } },
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
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  r: number;
  color: THREE.Color;
  phase: number;
  bornAt: number;
  /** Éclatée à (performance.now()), sinon 0. */
  poppedAt: number;
}

export class BubbleMode {
  readonly id = "bubbles";
  private active = false;
  private group = new THREE.Group();
  private bubbles: Bubble[] = [];
  private plane = -2;
  private last = 0;
  private audio: AudioContext | null = null;
  // Gouttelettes.
  private sparks: THREE.Points;
  private sPos = new Float32Array(SPARKS * 3);
  private sVel = new Float32Array(SPARKS * 3);
  private sCol = new Float32Array(SPARKS * 3);
  private sLife = new Float32Array(SPARKS);
  private sSize = new Float32Array(SPARKS);
  private sAge = new Float32Array(SPARKS);
  private sDur = new Float32Array(SPARKS);
  private nextSpark = 0;
  // Anneaux.
  private rings: { mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>; at: number; r: number }[] = [];

  constructor(
    private world: MirrorWorld,
    private hands: () => Fingertips[],
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < COUNT; i++) {
      const color = PALETTE[i % PALETTE.length].clone();
      const mesh = new THREE.Mesh(quad, bubbleMaterial(world.shared, color));
      this.group.add(mesh);
      this.bubbles.push({ mesh, pos: new THREE.Vector3(), vel: new THREE.Vector3(), r: 0.06, color, phase: Math.random() * 10, bornAt: 0, poppedAt: 0 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.sPos, 3));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.sCol, 3));
    geo.setAttribute("aLife", new THREE.BufferAttribute(this.sLife, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.sSize, 1));
    this.sparks = new THREE.Points(geo, sparkMaterial(world.shared));
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

  private needSpawn = false;

  /** Point de l'écran (px CSS) → 3D à la profondeur `z` (Three), sur le regard de l'œil. */
  private unproject(x: number, y: number, z: number): THREE.Vector3 {
    const [sw, sh, gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    const glass = new THREE.Vector3((x / window.innerWidth) * sw, -(y / window.innerHeight) * sh, -gap);
    return eye.clone().lerp(glass, (z - eye.z) / (glass.z - eye.z));
  }

  /** Une bulle (re)naît en bas de l'écran (ou n'importe où au début), à une profondeur au hasard. */
  private respawn(b: Bubble, now: number, anywhere: boolean): void {
    const z = this.plane + (Math.random() * 2 - 1) * DEPTH;
    const x = (0.08 + Math.random() * 0.84) * window.innerWidth;
    const y = anywhere ? (0.15 + Math.random() * 0.8) * window.innerHeight : window.innerHeight * 1.05;
    b.pos.copy(this.unproject(x, y, z));
    b.r = R_MIN + Math.random() * (R_MAX - R_MIN);
    b.vel.set((Math.random() - 0.5) * 0.03, RISE * (0.6 + Math.random() * 0.8), 0);
    b.color.copy(PALETTE[Math.floor(Math.random() * PALETTE.length)]);
    b.bornAt = now + (anywhere ? Math.random() * 600 : 0);
    b.poppedAt = 0;
  }

  frame(now: number): void {
    if (!this.active || !this.world.ready) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.last) / 1000));
    this.last = now;
    const t = now / 1000;
    this.plane += (-this.world.camera.position.z - this.plane) * (this.needSpawn ? 1 : 0.02);
    if (this.needSpawn) {
      this.needSpawn = false;
      for (const b of this.bubbles) this.respawn(b, now, true);
    }
    const W = window.innerWidth;
    const H = window.innerHeight;
    const tips = this.hands().flatMap((h) => h.tips);
    const top = this.unproject(0, -0.1 * H, this.plane).y;
    for (const b of this.bubbles) {
      const u = b.mesh.material.uniforms;
      u.uTime.value = t;
      if (b.poppedAt) {
        const k = (now - b.poppedAt) / POP_MS;
        u.uPop.value = Math.min(1, k);
        if (k >= 1) this.respawn(b, now + 400 + Math.random() * 1200, false);
        this.place(b);
        continue;
      }
      if (now < b.bornAt) {
        u.uAppear.value = 0;
        continue;
      }
      // Monte en se balançant ; se pousse un peu des voisines.
      b.vel.x += Math.sin(t * 0.9 + b.phase) * 0.012 * dt;
      for (const o of this.bubbles) {
        if (o === b || o.poppedAt) continue;
        const d = b.pos.clone().sub(o.pos);
        const min = b.r + o.r;
        const l = d.length();
        if (l > 0 && l < min) b.vel.addScaledVector(d.divideScalar(l), (min - l) * 2 * dt);
      }
      b.vel.multiplyScalar(Math.exp(-dt * 0.3));
      b.vel.y += (RISE - b.vel.y) * dt * 0.5;
      b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y > top + b.r) this.respawn(b, now, false);
      u.uAppear.value = Math.min(1, (now - b.bornAt) / 500);
      u.uPop.value = 0;
      this.place(b);
      // Un doigt dessus (dans le reflet) : pop.
      const [cx, cy] = this.world.project(b.pos);
      const [ex] = this.world.project(b.pos.clone().add(new THREE.Vector3(b.r, 0, 0)));
      const rPx = Math.abs(ex - cx) * W;
      for (const [x, y] of tips) {
        if (Math.hypot(x - cx * W, y - cy * H) < rPx * 0.95) {
          this.pop(b, now);
          break;
        }
      }
    }
    this.updateSparks(dt);
    this.updateRings(now);
  }

  private place(b: Bubble): void {
    b.mesh.position.copy(b.pos);
    b.mesh.scale.setScalar(b.r * 3);
    b.mesh.material.uniforms.uSolid.value = Math.max(0.01, -b.pos.z);
  }

  /** Pop : éclair, gouttelettes de sa couleur, anneau, son. */
  private pop(b: Bubble, now: number): void {
    b.poppedAt = now;
    const n = Math.round(22 + b.r * 260);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a), Math.sin(a), (Math.random() - 0.5) * 0.6);
      const at = b.pos.clone().addScaledVector(dir, b.r * (0.8 + Math.random() * 0.25));
      const speed = 0.35 + Math.random() * 0.75;
      const c = b.color.clone().lerp(new THREE.Color(1, 1, 1), Math.random() * 0.4);
      this.spark(at, dir.multiplyScalar(speed), c, 0.008 + Math.random() * 0.014, 0.55 + Math.random() * 0.5);
    }
    const ring = this.rings.reduce((o, r) => (r.at < o.at ? r : o));
    ring.at = now;
    ring.r = b.r;
    ring.mesh.position.copy(b.pos);
    ring.mesh.material.uniforms.uColor.value.copy(b.color);
    ring.mesh.visible = true;
    this.popSound(b.r);
  }

  private spark(at: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, size: number, dur: number): void {
    const i = this.nextSpark;
    this.nextSpark = (i + 1) % SPARKS;
    this.sPos.set([at.x, at.y, at.z], i * 3);
    this.sVel.set([vel.x, vel.y, vel.z], i * 3);
    this.sCol.set([color.r, color.g, color.b], i * 3);
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
    g.attributes.aColor.needsUpdate = true;
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
      const f = 900 * (0.06 / r);
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

// Mode portail : une arche de lumière s'ouvre dans la pièce du reflet, un peu derrière la personne,
// sur un monde féerique à la Zelda, en fin de journée : une prairie fleurie au bord d'une falaise,
// une grande vallée avec sa rivière, son lac, ses forêts, un sanctuaire bleu lumineux, un château
// sur sa colline, des îles flottantes d'où tombent des cascades, des montagnes dans la brume
// dorée, des nuages, le soleil bas et ses rayons, des lucioles.
//
// L'arche est posée sur la vitre : elle ne bouge pas et garde sa taille, comme une fenêtre percée
// dans le miroir. Ce qu'on voit à travers dépend de l'œil (MirrorWorld, perspective décentrée) :
// se pencher à gauche fait regarder vers la droite du monde, s'approcher élargit la vue, le
// premier plan glisse plus que le lointain. Rien ne la cache (pas de masque du corps). Le paysage
// n'est dessiné qu'à l'intérieur de l'arche (stencil), en pleine définition.
//
// Échelle : vu à ~2-3 m par une arche d'un mètre, l'angle est étroit (un téléobjectif) ; tout est
// donc grand et loin (vallée 60 m plus bas, montagnes à 1,5 km).
import * as THREE from "three";
import type { MirrorWorld } from "../fairy/world";

/** Arche : part de l'écran qu'elle occupe, centre (fraction de la hauteur). */
const PORTAL_W = 0.82;
const PORTAL_H = 0.8;
const OPEN_MS = 1400;
const FAR = 6000;
/** Vallée en contrebas du bord de la prairie (m), niveau de l'eau. */
const VALLEY = -60;
const WATER = VALLEY - 3.5;
const SUN = new THREE.Vector3(0.55, 0.11, -0.83).normalize();
const HAZE = new THREE.Color("#f3d6bd");

// --- Bruit (simplex 2D) ------------------------------------------------------------------------------

const PERM = (() => {
  const p = new Uint8Array(512);
  const base = Array.from({ length: 256 }, (_, i) => i);
  let seed = 1337;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [base[i], base[j]] = [base[j], base[i]];
  }
  for (let i = 0; i < 512; i++) p[i] = base[i & 255];
  return p;
})();
const GRAD = [[1, 1], [-1, 1], [1, -1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
function noise(x: number, y: number): number {
  const F2 = 0.5 * (Math.sqrt(3) - 1);
  const G2 = (3 - Math.sqrt(3)) / 6;
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  const c = (gx: number, gy: number, xx: number, yy: number) => {
    let tt = 0.5 - xx * xx - yy * yy;
    if (tt < 0) return 0;
    tt *= tt;
    const g = GRAD[PERM[gx + PERM[gy]] & 7];
    return tt * tt * (g[0] * xx + g[1] * yy);
  };
  return 70 * (c(ii, jj, x0, y0) + c(ii + i1, jj + j1, x1, y1) + c(ii + 1, jj + 1, x2, y2));
}
const fbm = (x: number, y: number, oct = 4) => {
  let a = 0.5;
  let f = 1;
  let v = 0;
  for (let o = 0; o < oct; o++) {
    v += a * noise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return v;
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Le paysage : x à droite, d en s'éloignant (m), hauteur 0 = bord de la prairie ---------------------

const CASTLE = { x: 170, d: 760 };
const SHRINE = { x: -120, d: 300 };
const LAKE = { x: -40, d: 520, r: 110 };
/** Rivière : serpente dans la vallée jusqu'au lac. */
const riverX = (d: number) => 60 * Math.sin(d * 0.006) + 25 * Math.sin(d * 0.017 + 1.3) - 20;

function height(x: number, d: number): number {
  let h = VALLEY + fbm(x * 0.004, d * 0.004) * 26 + fbm(x * 0.02, d * 0.02, 3) * 5;
  // Rivière et lac creusés sous le niveau de l'eau.
  const river = Math.abs(x - riverX(d));
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 2, h, smoothstep(10, 26, river)));
  const lake = Math.hypot((x - LAKE.x) * 0.8, d - LAKE.d);
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 3, h, smoothstep(LAKE.r * 0.8, LAKE.r * 1.25, lake)));
  // Collines du château et du sanctuaire.
  h += smoothstep(150, 30, Math.hypot(x - CASTLE.x, d - CASTLE.d)) * 70;
  h += smoothstep(60, 12, Math.hypot(x - SHRINE.x, d - SHRINE.d)) * 18;
  // Montagnes au loin, en chaînes.
  const ridge = 1 - Math.abs(noise(x * 0.0018, d * 0.0018));
  h += smoothstep(1000, 1700, d) * (160 + 260 * ridge * ridge + fbm(x * 0.006, d * 0.006) * 60);
  // Côtés de la vallée qui remontent un peu (elle tient dans le cadre).
  h += smoothstep(500, 1100, Math.abs(x)) * 120;
  // La prairie au premier plan, puis la falaise.
  const meadow = fbm(x * 0.15, d * 0.15, 2) * 0.35;
  h = THREE.MathUtils.lerp(h, meadow, smoothstep(26, 12, d));
  return h;
}

function groundColor(h: number, slope: number, x: number, d: number, out: THREE.Color): THREE.Color {
  const grassA = new THREE.Color("#8cc24a");
  const grassB = new THREE.Color("#5c9a38");
  const gold = new THREE.Color("#c9c45a");
  const rock = new THREE.Color("#a08d78");
  const sand = new THREE.Color("#e2cf96");
  const snow = new THREE.Color("#fbf3ee");
  out.copy(grassA).lerp(grassB, smoothstep(-0.3, 0.5, fbm(x * 0.01 + 7, d * 0.01, 2)));
  out.lerp(gold, smoothstep(0.2, 0.7, fbm(x * 0.006 - 3, d * 0.006, 2)) * 0.5);
  if (h < WATER + 2) out.lerp(sand, smoothstep(WATER + 2, WATER + 0.3, h));
  out.lerp(rock, Math.max(smoothstep(0.5, 0.85, slope), smoothstep(VALLEY + 80, VALLEY + 160, h)));
  out.lerp(snow, smoothstep(VALLEY + 230, VALLEY + 300, h));
  return out;
}

export class PortalMode {
  readonly id = "portal";
  private active = false;
  private built = false;
  private openedAt = 0;
  private needPlace = false;
  private root = new THREE.Group();
  private land = new THREE.Group();
  private mask!: THREE.Mesh;
  private rim!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };
  private size = new THREE.Vector2(1, 1.5);
  private previousFog: THREE.Fog | THREE.FogExp2 | null = null;
  private fog = new THREE.Fog(HAZE, 250, 3200);
  private seed = 7;

  constructor(private world: MirrorWorld) {
    this.root.visible = false;
    world.scene.add(this.root);
  }

  get on(): boolean {
    return this.active;
  }

  get visible(): boolean {
    return this.active;
  }

  enter(now = performance.now()): void {
    this.active = true;
    this.openedAt = now;
    this.needPlace = true;
    this.world.far = FAR;
    this.world.setResolution(1); // 4K : le paysage est la vedette
  }

  exit(): void {
    this.active = false;
    this.root.visible = false;
    this.world.far = 30;
    this.world.setResolution(0.5);
    this.world.scene.fog = this.previousFog;
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** L'arche sur la vitre (fixe à l'écran, quelle que soit la place de l'œil) ; la prairie juste
   *  sous son bord, derrière. */
  private place(): void {
    const [sw, sh, gap] = this.world.screenMeters;
    this.size.set(sw * PORTAL_W, sh * PORTAL_H);
    this.root.position.set(sw / 2, -sh * 0.47, -gap);
    if (!this.built) this.build();
    this.land.position.y = -this.size.y / 2 - 0.35;
    this.root.visible = true;
  }

  frame(now: number): void {
    if (!this.active || !this.world.ready) return;
    if (this.needPlace) {
      this.needPlace = false;
      this.place();
    }
    this.time.value = now / 1000;
    const open = Math.min(1, (now - this.openedAt) / OPEN_MS);
    const e = 1 - (1 - open) ** 3;
    // L'arche s'ouvre (ellipse qui grandit), avec un éclair au bord.
    const s = new THREE.Vector3(this.size.x * Math.max(0.001, e), this.size.y * Math.max(0.001, e), 1);
    this.mask.scale.copy(s);
    this.rim.scale.set(s.x * 1.18, s.y * 1.12, 1);
    this.rim.material.uniforms.uOpen.value = open;
    this.world.scene.fog = this.fog;
    // On y entre : le monde avance un peu pendant l'ouverture.
    this.land.position.z = -1.5 * (1 - e);
  }

  // --- Construction --------------------------------------------------------------------------------

  private stencil(m: THREE.Material, order: number): number {
    m.stencilWrite = true;
    m.stencilRef = 1;
    m.stencilFunc = THREE.EqualStencilFunc;
    m.stencilFail = THREE.KeepStencilOp;
    m.stencilZFail = THREE.KeepStencilOp;
    m.stencilZPass = THREE.KeepStencilOp;
    return order;
  }

  private add(o: THREE.Object3D, order: number): void {
    o.traverse((c) => {
      if (c instanceof THREE.Mesh || c instanceof THREE.Points) c.renderOrder = this.stencil(c.material as THREE.Material, order);
    });
    this.land.add(o);
  }

  private build(): void {
    this.built = true;
    this.previousFog = this.world.scene.fog;
    this.buildPortal();
    this.root.add(this.land);
    const hemi = new THREE.HemisphereLight(0xb8d8ff, 0x46623a, 1.15);
    const sun = new THREE.DirectionalLight(0xffd2a0, 2.6);
    sun.position.copy(SUN).multiplyScalar(1000);
    this.land.add(hemi, sun);
    this.buildSky();
    this.buildClouds();
    this.buildTerrain();
    this.buildWater();
    this.buildForest();
    this.buildCastle();
    this.buildShrine();
    this.buildIslands();
    this.buildMeadow();
    this.buildMotes();
  }

  /** Arche (masque stencil) et son bord d'énergie. */
  private buildPortal(): void {
    const ellipse = new THREE.ShapeGeometry(new THREE.Shape(new THREE.EllipseCurve(0, 0, 0.5, 0.5, 0, Math.PI * 2, false, 0).getPoints(200)));
    const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
    maskMat.stencilWrite = true;
    maskMat.stencilRef = 1;
    maskMat.stencilFunc = THREE.AlwaysStencilFunc;
    maskMat.stencilZPass = THREE.ReplaceStencilOp;
    this.mask = new THREE.Mesh(ellipse, maskMat);
    this.mask.renderOrder = -100;
    this.root.add(this.mask);

    this.rim = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uOpen: { value: 0 } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform float uOpen;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            float r = length(p * vec2(1.18, 1.12));
            float a = atan(p.y, p.x);
            float swirl = 0.5 + 0.5 * sin(a * 6.0 - uTime * 2.2 + sin(a * 3.0 + uTime) * 1.5);
            float sparks = pow(0.5 + 0.5 * sin(a * 40.0 + uTime * 6.0), 30.0);
            float ring = exp(-pow((r - 1.0) / (0.014 + 0.012 * swirl), 2.0));
            float glow = exp(-pow((r - 1.0) / 0.09, 2.0)) * 0.4;
            float outer = exp(-pow(max(0.0, r - 1.0) / 0.05, 2.0)) * sparks * 0.8;
            float flash = (1.0 - smoothstep(0.0, 0.35, uOpen)) * exp(-pow((r - 1.0) / 0.2, 2.0)) * 2.0 * step(0.02, uOpen);
            vec3 cyan = vec3(0.3, 0.88, 1.0);
            vec3 gold = vec3(1.0, 0.86, 0.55);
            vec3 col = mix(cyan, gold, swirl * 0.45) * (ring * (1.3 + swirl) + glow) + gold * outer + vec3(1.0) * flash;
            float alpha = clamp(ring + glow + outer + flash, 0.0, 1.0) * smoothstep(0.0, 0.08, uOpen);
            gl_FragColor = vec4(col * alpha, alpha);
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.rim.renderOrder = 60;
    this.root.add(this.rim);
  }

  /** Ciel de fin de journée : bleu profond, horizon pêche et rose, soleil bas, ses rayons. */
  private buildSky(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: SUN }, uTime: this.time },
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun;
          uniform float uTime;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 zenith = vec3(0.16, 0.36, 0.78);
            vec3 mid = vec3(0.45, 0.68, 0.98);
            vec3 horizon = vec3(1.0, 0.82, 0.68);
            vec3 rose = vec3(0.98, 0.62, 0.68);
            vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
            col = mix(col, zenith, smoothstep(0.2, 0.75, h));
            float sd = max(0.0, dot(d, uSun));
            // Rose près de l'horizon, du côté du soleil.
            col = mix(col, rose, (1.0 - smoothstep(0.0, 0.12, abs(h))) * pow(sd, 3.0) * 0.5);
            // Soleil, son halo, ses rayons.
            vec3 t = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
            vec3 b = cross(t, uSun);
            float ang = atan(dot(d, b), dot(d, t));
            float rays = pow(0.5 + 0.5 * sin(ang * 22.0 + sin(ang * 7.0 + uTime * 0.05) * 2.0), 8.0);
            col += vec3(1.0, 0.85, 0.6) * (pow(sd, 1600.0) * 6.0 + pow(sd, 60.0) * 0.6 + pow(sd, 6.0) * 0.25 + rays * pow(sd, 14.0) * 0.35);
            // Sous l'horizon : la brume dorée.
            col = mix(col, vec3(0.95, 0.84, 0.74), smoothstep(0.0, -0.1, h));
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    this.add(sky, -50);
  }

  /** Nuages : des amas doux, dorés par en dessous. */
  private buildClouds(): void {
    for (let i = 0; i < 16; i++) {
      const cloud = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.ShaderMaterial({
          uniforms: { uTime: this.time, uSeed: { value: i * 7.3 } },
          vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */ `
            uniform float uTime;
            uniform float uSeed;
            varying vec2 vUv;
            float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
            float vnoise(vec2 p) {
              vec2 i = floor(p), f = fract(p);
              f = f * f * (3.0 - 2.0 * f);
              return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
            }
            void main() {
              vec2 p = vUv * 2.0 - 1.0;
              float n = 0.0, a = 0.5;
              vec2 q = vUv * vec2(4.0, 2.0) + uSeed + vec2(uTime * 0.006, 0.0);
              for (int k = 0; k < 6; k++) { n += a * vnoise(q); q *= 2.05; a *= 0.5; }
              float shape = smoothstep(1.0, 0.25, length(p * vec2(1.0, 2.2))) * smoothstep(0.38, 0.72, n);
              // Dessous doré (le soleil bas), dessus blanc.
              vec3 col = mix(vec3(1.0, 0.78, 0.62), vec3(1.0, 0.98, 0.96), smoothstep(-0.3, 0.6, p.y) * smoothstep(0.4, 0.8, n));
              gl_FragColor = vec4(col, shape * 0.95);
            }`,
          transparent: true,
          depthWrite: false,
          fog: false,
        }),
      );
      const a = -0.9 + (i / 15) * 1.8 + (this.rnd() - 0.5) * 0.15;
      const dist = 1600 + this.rnd() * 2200;
      cloud.position.set(Math.sin(a) * dist, 260 + this.rnd() * 520, -Math.cos(a) * dist);
      cloud.scale.set(700 + this.rnd() * 900, 220 + this.rnd() * 200, 1);
      cloud.lookAt(0, cloud.position.y, 0);
      this.add(cloud, -40);
    }
  }

  /** Terrain à facettes, plus fin près de soi (prairie) que dans le lointain. */
  private buildTerrain(): void {
    const NX = 360;
    const NZ = 300;
    const pos: number[] = [];
    const vtx = (i: number, j: number): [number, number] => {
      const v = j / NZ;
      const d = 0.2 + v * v * 3200;
      const half = 12 + d * 0.95;
      return [(i / NX - 0.5) * 2 * half, d];
    };
    const col: number[] = [];
    const c = new THREE.Color();
    const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const tri = (a: [number, number], b: [number, number], cc: [number, number]) => {
      [a, b, cc].forEach(([x, d], k) => p[k].set(x, height(x, d), -d));
      const n = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize();
      if (n.y < 0) n.negate();
      const cx = (p[0].x + p[1].x + p[2].x) / 3;
      const cy = (p[0].y + p[1].y + p[2].y) / 3;
      const cd = -(p[0].z + p[1].z + p[2].z) / 3;
      groundColor(cy, 1 - n.y, cx, cd, c);
      for (const q of p) {
        pos.push(q.x, q.y, q.z);
        col.push(c.r, c.g, c.b);
      }
    };
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = vtx(i, j), b = vtx(i + 1, j), cc = vtx(i, j + 1), dd = vtx(i + 1, j + 1);
        tri(a, cc, b);
        tri(b, cc, dd);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    this.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0, side: THREE.DoubleSide })), 0);
  }

  /** L'eau (rivière, lac) : le ciel s'y reflète, le soleil y scintille, elle se fond dans la brume. */
  private buildWater(): void {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uSun: { value: SUN }, uHaze: { value: HAZE } },
        vertexShader: /* glsl */ `varying vec3 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uSun;
          uniform vec3 uHaze;
          varying vec3 vWorld;
          void main() {
            vec3 v = normalize(vWorld - cameraPosition);
            float w = sin(vWorld.x * 0.15 + uTime * 0.9) * sin(vWorld.z * 0.12 - uTime * 0.7) + 0.5 * sin(vWorld.x * 0.4 - vWorld.z * 0.3 + uTime * 1.7);
            vec3 n = normalize(vec3(w * 0.06, 1.0, w * 0.04));
            vec3 r = reflect(v, n);
            float fres = pow(1.0 - max(0.0, -v.y), 3.0);
            vec3 deep = vec3(0.12, 0.38, 0.55);
            vec3 sky = mix(vec3(1.0, 0.85, 0.72), vec3(0.45, 0.68, 0.98), smoothstep(0.0, 0.3, r.y));
            vec3 col = mix(deep, sky, 0.35 + 0.55 * fres);
            col += vec3(1.0, 0.88, 0.62) * pow(max(0.0, dot(r, uSun)), 120.0) * 2.5;
            float dist = length(vWorld - cameraPosition);
            col = mix(col, uHaze, smoothstep(250.0, 3200.0, dist));
            gl_FragColor = vec4(col, 1.0);
          }`,
        fog: false,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER;
    this.add(water, -1);
  }

  /** Forêts : sapins et arbres ronds en bosquets, sur l'herbe de la vallée. */
  private buildForest(): void {
    const coneGeo = new THREE.ConeGeometry(3.2, 11, 7);
    coneGeo.translate(0, 8, 0);
    const roundGeo = new THREE.IcosahedronGeometry(4.5, 0);
    roundGeo.translate(0, 7.5, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, 4, 6);
    trunkGeo.translate(0, 2, 0);
    const spots: { m: THREE.Matrix4; round: boolean }[] = [];
    for (let k = 0; k < 30000 && spots.length < 1600; k++) {
      const d = 34 + this.rnd() ** 0.8 * 1050;
      const x = (this.rnd() - 0.5) * 2 * (40 + d * 0.8);
      const h = height(x, d);
      if (h < WATER + 1.5 || h > VALLEY + 60) continue;
      if (Math.hypot(x - CASTLE.x, d - CASTLE.d) < 60 || Math.hypot(x - SHRINE.x, d - SHRINE.d) < 25) continue;
      const slope = Math.abs(height(x + 3, d) - h) + Math.abs(height(x, d + 3) - h);
      if (slope > 3.5 || fbm(x * 0.008 + 3, d * 0.008, 2) < 0) continue;
      const sc = 0.7 + this.rnd() * 0.8;
      spots.push({
        m: new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.4, -d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rnd() * 6.28), new THREE.Vector3(sc, sc * (0.8 + this.rnd() * 0.5), sc)),
        round: this.rnd() < 0.35,
      });
    }
    const cones = spots.filter((s) => !s.round);
    const rounds = spots.filter((s) => s.round);
    const leafMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 1 });
    const coneMesh = new THREE.InstancedMesh(coneGeo, leafMat, cones.length);
    const roundMesh = new THREE.InstancedMesh(roundGeo, leafMat.clone(), rounds.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: "#6b4a2f", flatShading: true, roughness: 1 }), spots.length);
    cones.forEach((s, i) => {
      coneMesh.setMatrixAt(i, s.m);
      coneMesh.setColorAt(i, new THREE.Color().setHSL(0.3 + this.rnd() * 0.05, 0.5, 0.24 + this.rnd() * 0.08));
    });
    rounds.forEach((s, i) => {
      roundMesh.setMatrixAt(i, s.m);
      // Quelques arbres en fleurs (rose) ou dorés : la touche féerique.
      const r = this.rnd();
      const color = r < 0.18 ? new THREE.Color().setHSL(0.93, 0.6, 0.72) : r < 0.32 ? new THREE.Color().setHSL(0.12, 0.7, 0.55) : new THREE.Color().setHSL(0.25 + this.rnd() * 0.05, 0.5, 0.36);
      roundMesh.setColorAt(i, color);
    });
    spots.forEach((s, i) => trunks.setMatrixAt(i, s.m));
    this.add(coneMesh, 1);
    this.add(roundMesh, 1);
    this.add(trunks, 1);
  }

  /** Le château sur sa colline : donjon, tours aux toits bleus, flèche, fenêtres allumées. */
  private buildCastle(): void {
    const castle = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: "#ece4d4", flatShading: true, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: "#3a62c4", flatShading: true, roughness: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: "#ffd27a" });
    const tower = (x: number, z: number, r: number, h: number) => {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 12), stone);
      t.position.set(x, h / 2, z);
      const c = new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, r * 2.8, 12), roof);
      c.position.set(x, h + r * 1.4, z);
      castle.add(t, c);
      for (let k = 0; k < 3; k++) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(r * 0.25, r * 0.5, 0.3), glow);
        w.position.set(x + Math.sin(k * 2.1) * r * 1.01, h * (0.45 + 0.15 * k), z + Math.cos(k * 2.1) * r * 1.01);
        w.lookAt(x, w.position.y, z);
        castle.add(w);
      }
    };
    tower(0, 0, 10, 55);
    tower(0, 0, 3.5, 95);
    for (const [x, z] of [[-26, -18], [26, -18], [-26, 18], [26, 18], [0, 30]]) tower(x, z, 5.5, 40);
    for (const [x, z, w, d] of [[0, -18, 52, 3], [0, 18, 52, 3], [-26, 0, 3, 36], [26, 0, 3, 36]] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 20, d), stone);
      wall.position.set(x, 10, z);
      castle.add(wall);
    }
    castle.position.set(CASTLE.x, height(CASTLE.x, CASTLE.d) - 2, -CASTLE.d);
    castle.rotation.y = -0.3;
    this.add(castle, 1);
  }

  /** Un sanctuaire : socle de pierre, lignes bleues qui brillent, et un rayon de lumière vers le ciel. */
  private buildShrine(): void {
    const shrine = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: "#5b5f6e", flatShading: true, roughness: 0.8 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 3, 8), stone);
    base.position.y = 1.5;
    const core = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 9, 8), stone);
    core.position.y = 7.5;
    const lines = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.18, 6, 24), new THREE.MeshBasicMaterial({ color: "#5ff0ff" }));
    lines.rotation.x = Math.PI / 2;
    lines.position.y = 9;
    shrine.add(base, core, lines);
    // Rayon de lumière (additif, il traverse la brume).
    const beam = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          void main() {
            float x = abs(vUv.x * 2.0 - 1.0);
            float a = exp(-x * x * 18.0) * smoothstep(1.0, 0.0, vUv.y) * (0.75 + 0.25 * sin(uTime * 2.0 + vUv.y * 10.0));
            gl_FragColor = vec4(vec3(0.4, 0.92, 1.0) * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    beam.scale.set(6, 260, 1);
    beam.position.y = 9 + 130;
    shrine.add(beam);
    shrine.position.set(SHRINE.x, height(SHRINE.x, SHRINE.d) - 0.5, -SHRINE.d);
    this.add(shrine, 3);
  }

  /** Îles flottantes, herbe et arbres dessus, cascades qui tombent dans la brume. */
  private buildIslands(): void {
    const rock = new THREE.MeshStandardMaterial({ color: "#9a8571", flatShading: true, roughness: 1 });
    const grass = new THREE.MeshStandardMaterial({ color: "#7fbe48", flatShading: true, roughness: 1 });
    const leaves = new THREE.MeshStandardMaterial({ color: "#3f8a3a", flatShading: true, roughness: 1 });
    const fall = () =>
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          void main() {
            float x = abs(vUv.x * 2.0 - 1.0);
            float streak = hash(vec2(floor(vUv.x * 18.0), 0.0));
            float flow = fract(vUv.y * 3.0 + uTime * (0.35 + streak * 0.2));
            float a = (1.0 - smoothstep(0.6, 1.0, x)) * (0.55 + 0.45 * smoothstep(0.0, 0.6, flow)) * smoothstep(0.0, 0.45, vUv.y);
            vec3 col = mix(vec3(0.75, 0.9, 1.0), vec3(1.0), flow);
            gl_FragColor = vec4(col * a, a * 0.85);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const islands: [number, number, number, number][] = [
      [-280, 160, 560, 26],
      [320, 230, 900, 34],
      [-60, 330, 1350, 40],
    ];
    for (const [x, y, d, r] of islands) {
      const g = new THREE.Group();
      const under = new THREE.ConeGeometry(r, r * 1.6, 9, 3);
      under.rotateX(Math.PI);
      const up = under.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < up.count; i++) {
        const k = 0.85 + 0.3 * Math.abs(noise(up.getX(i) * 0.2 + x, up.getZ(i) * 0.2));
        up.setX(i, up.getX(i) * k);
        up.setZ(i, up.getZ(i) * k);
      }
      under.translate(0, -r * 0.8, 0);
      g.add(new THREE.Mesh(under, rock));
      const top = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.02, r, 2.5, 9), grass);
      top.position.y = 1;
      g.add(top);
      for (let k = 0; k < 6; k++) {
        const t = new THREE.Mesh(new THREE.ConeGeometry(r * 0.12, r * 0.45, 6), leaves);
        const a = this.rnd() * 6.28;
        const rr = this.rnd() * r * 0.7;
        t.position.set(Math.cos(a) * rr, 2 + r * 0.22, Math.sin(a) * rr);
        g.add(t);
      }
      const water = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.25, 260), fall());
      water.position.set(r * 0.55, -130, r * 0.5);
      g.add(water);
      g.position.set(x, y, -d);
      this.add(g, 2);
    }
  }

  /** Premier plan : herbe haute qui ondule au vent, des fleurs. */
  private buildMeadow(): void {
    const blade = new THREE.BufferGeometry();
    blade.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.022, 0, 0, 0.022, 0, 0, 0.006, 0.4, 0, -0.006, 0.4, 0, 0, 0.5, 0]), 3));
    blade.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4]);
    const N = 12000;
    const grass = new THREE.InstancedMesh(
      blade,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time },
        vertexShader: /* glsl */ `
          uniform float uTime;
          varying float vH;
          varying float vTint;
          void main() {
            vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float h = position.y / 0.5;
            vH = h;
            vTint = fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453);
            float gust = sin(base.x * 0.35 + uTime * 1.6) * 0.5 + sin(base.z * 0.5 + uTime * 1.1 + base.x * 0.2) * 0.5;
            vec4 p = instanceMatrix * vec4(position, 1.0);
            p.x += (0.1 + 0.09 * gust) * h * h;
            p.z += 0.04 * gust * h * h;
            gl_Position = projectionMatrix * viewMatrix * p;
          }`,
        fragmentShader: /* glsl */ `
          varying float vH;
          varying float vTint;
          void main() {
            vec3 dark = vec3(0.14, 0.32, 0.1);
            vec3 light = mix(vec3(0.6, 0.82, 0.3), vec3(0.95, 0.85, 0.45), vTint * 0.6);
            // Pointes dorées par le soleil couchant.
            gl_FragColor = vec4(mix(dark, light, vH) + vec3(0.25, 0.15, 0.0) * pow(vH, 4.0), 1.0);
          }`,
        side: THREE.DoubleSide,
      }),
      N,
    );
    for (let i = 0; i < N; i++) {
      const d = 0.8 + this.rnd() ** 1.5 * 18;
      const x = (this.rnd() - 0.5) * 2 * (3 + d * 1.1);
      const sc = 0.6 + this.rnd() * 0.9;
      grass.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, height(x, d), -d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rnd() * 6.28), new THREE.Vector3(sc, sc * (0.7 + this.rnd() * 0.8), sc)));
    }
    this.add(grass, 2);
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.04, 0), new THREE.MeshStandardMaterial({ roughness: 0.5, emissive: new THREE.Color("#332") }), 500);
    const petals = ["#ffffff", "#ffd84f", "#ff8fb8", "#9fd0ff", "#c9a0ff"].map((h) => new THREE.Color(h));
    for (let i = 0; i < 500; i++) {
      const d = 1 + this.rnd() * 16;
      const x = (this.rnd() - 0.5) * 2 * (3 + d * 1.0);
      flowers.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, height(x, d) + 0.25 + this.rnd() * 0.25, -d));
      flowers.setColorAt(i, petals[Math.floor(this.rnd() * petals.length)]);
    }
    this.add(flowers, 2);
  }

  /** Lucioles dorées et bleues qui flottent dans la lumière, près de l'arche. */
  private buildMotes(): void {
    const N = 320;
    const mp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) mp.set([(this.rnd() - 0.5) * 10, this.rnd() * 4, -0.6 - this.rnd() * 14], i * 3);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mp, 3));
    const motes = new THREE.Points(
      mg,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uRes: this.world.shared.uRes },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform vec2 uRes;
          varying float vA;
          varying float vBlue;
          void main() {
            vec3 p = position;
            float s = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
            p.y += mod(uTime * (0.04 + 0.08 * s) + s * 4.0, 4.0);
            p.x += sin(uTime * 0.5 + s * 6.28) * 0.35;
            p.z += cos(uTime * 0.37 + s * 4.0) * 0.25;
            vA = 0.4 + 0.6 * pow(0.5 + 0.5 * sin(uTime * (1.0 + 2.5 * s) + s * 10.0), 2.0);
            vBlue = step(0.72, s);
            vec4 view = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * view;
            gl_PointSize = (0.03 + 0.02 * s) * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          varying float vBlue;
          void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            float a = exp(-dot(p, p) * 3.0) * vA;
            vec3 c = mix(vec3(1.0, 0.86, 0.5), vec3(0.45, 0.9, 1.0), vBlue);
            gl_FragColor = vec4(c * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      }),
    );
    motes.frustumCulled = false;
    this.add(motes, 10);
  }
}

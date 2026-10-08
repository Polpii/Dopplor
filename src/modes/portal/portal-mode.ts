// Mode portail : une arche de lumière s'ouvre dans la pièce du reflet, un peu derrière la personne,
// sur un autre monde (des collines à la Zelda : herbe qui ondule au premier plan, vallée, lac,
// arbres, château sur une colline, montagnes dans la brume, nuages, soleil).
//
// La vue est celle de l'œil de la personne à travers l'écran (MirrorWorld) : comme par une vraie
// fenêtre, se pencher à droite fait voir davantage ce qu'il y a à gauche, s'approcher élargit
// la vue ; le premier plan bouge plus que le lointain (profondeur). Le portail est derrière la
// personne : son reflet se tient devant, son corps le cache (silhouette du serveur).
//
// Le paysage n'est dessiné qu'à l'intérieur de l'arche (stencil).
import * as THREE from "three";
import type { MirrorWorld } from "../fairy/world";

/** Portail : derrière le reflet de la personne (m), part du champ de l'écran qu'il occupe. */
const BEHIND = 0.9;
const PORTAL_W = 0.82;
const PORTAL_H = 0.8;
const OPEN_MS = 1400;
/** Le premier plan (herbe), puis la vallée en contrebas (m sous le bord). */
const VALLEY_DROP = 26;
const FAR = 4000;

// --- Bruit (simplex 2D compact) ---------------------------------------------------------------------

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

/** Le lac et la colline du château (coordonnées du paysage : x à droite, d en s'éloignant). */
const LAKE = { x: -45, d: 120, r: 48 };
const CASTLE = { x: 60, d: 235 };
const WATER = -VALLEY_DROP + 1.2;

/** Hauteur du paysage (m, 0 = bord du premier plan), x à droite, d = distance en s'éloignant. */
function height(x: number, d: number): number {
  const dist = Math.hypot(x, d);
  let h = -VALLEY_DROP + fbm(x * 0.008, d * 0.008) * 16 + fbm(x * 0.035, d * 0.035, 3) * 3;
  // Lac : une cuvette.
  const dl = Math.hypot(x - LAKE.x, d - LAKE.d);
  h -= smoothstep(LAKE.r * 1.3, LAKE.r * 0.4, dl) * 8;
  // Colline du château.
  const dc = Math.hypot(x - CASTLE.x, d - CASTLE.d);
  h += smoothstep(70, 10, dc) * 22;
  // Montagnes tout autour, au loin.
  const ridge = 1 - Math.abs(noise(x * 0.004, d * 0.004));
  h += smoothstep(280, 560, dist) * (60 + 140 * ridge * ridge + fbm(x * 0.01, d * 0.01) * 40);
  // Falaise sous le premier plan : le sol remonte jusqu'au bord.
  h = THREE.MathUtils.lerp(h, -2 + fbm(x * 0.05, d * 0.05, 2) * 1.5, smoothstep(26, 6, d));
  return h;
}

/** Couleur du sol : sable au bord de l'eau, deux verts, roche dans les pentes et en altitude, neige. */
function groundColor(x: number, d: number, h: number, slope: number, out: THREE.Color): THREE.Color {
  const grassA = new THREE.Color("#79b443");
  const grassB = new THREE.Color("#4f8f35");
  const rock = new THREE.Color("#9c8e7c");
  const sand = new THREE.Color("#d8c58f");
  const snow = new THREE.Color("#f3f6fa");
  out.copy(grassA).lerp(grassB, smoothstep(-0.3, 0.5, fbm(x * 0.02 + 7, d * 0.02, 2)));
  if (h < WATER + 1.2) out.lerp(sand, smoothstep(WATER + 1.2, WATER + 0.2, h));
  out.lerp(rock, Math.max(smoothstep(0.55, 0.9, slope), smoothstep(40, 90, h)));
  out.lerp(snow, smoothstep(120, 160, h));
  return out;
}

export class PortalMode {
  readonly id = "portal";
  private active = false;
  private built = false;
  private openedAt = 0;
  /** Tout le monde du portail (placé derrière l'arche), et l'arche elle-même. */
  private root = new THREE.Group();
  private land = new THREE.Group();
  private mask!: THREE.Mesh;
  private body!: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private rim!: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private grass!: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private time = { value: 0 };
  private size = new THREE.Vector2(1, 1.5);
  private previousFog: THREE.Fog | THREE.FogExp2 | null = null;

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

  private needPlace = false;

  /** Point de l'écran (fractions) → 3D à la profondeur `z` (Three), sur le regard de l'œil. */
  private unproject(fx: number, fy: number, z: number): THREE.Vector3 {
    const [sw, sh, gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    const glass = new THREE.Vector3(fx * sw, -fy * sh, -gap);
    return eye.clone().lerp(glass, (z - eye.z) / (glass.z - eye.z));
  }

  /** L'arche dans la pièce du reflet, derrière la personne, à la taille de ce que montre l'écran. */
  private place(): void {
    const z = -this.world.camera.position.z - BEHIND;
    const tl = this.unproject(0, 0, z);
    const br = this.unproject(1, 1, z);
    const center = this.unproject(0.5, 0.47, z);
    this.size.set((br.x - tl.x) * PORTAL_W, (tl.y - br.y) * PORTAL_H);
    this.root.position.copy(center);
    if (!this.built) this.build();
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
    this.body.scale.copy(s);
    this.rim.scale.set(s.x * 1.18, s.y * 1.12, 1);
    this.rim.material.uniforms.uOpen.value = open;
    this.rim.material.uniforms.uSolid.value = -this.root.position.z;
    this.world.scene.fog = this.fog;
    // Le monde derrière : à peine décalé par l'ouverture (on y entre).
    this.land.position.z = -0.6 * (1 - e);
  }

  // --- Construction du monde --------------------------------------------------------------------

  private fog = new THREE.Fog(new THREE.Color("#cfe6ff"), 80, 1100);

  private build(): void {
    this.built = true;
    this.previousFog = this.world.scene.fog;
    const shared = this.world.shared;
    const stencil = (m: THREE.Material, order: number) => {
      m.stencilWrite = true;
      m.stencilRef = 1;
      m.stencilFunc = THREE.EqualStencilFunc;
      m.stencilFail = THREE.KeepStencilOp;
      m.stencilZFail = THREE.KeepStencilOp;
      m.stencilZPass = THREE.KeepStencilOp;
      return order;
    };

    // Arche (masque) : n'écrit que dans le stencil, là où le paysage pourra se dessiner.
    const ellipse = new THREE.ShapeGeometry(new THREE.Shape(new THREE.EllipseCurve(0, 0, 0.5, 0.5, 0, Math.PI * 2, false, 0).getPoints(160)));
    const maskMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false });
    maskMat.stencilWrite = true;
    maskMat.stencilRef = 1;
    maskMat.stencilFunc = THREE.AlwaysStencilFunc;
    maskMat.stencilZPass = THREE.ReplaceStencilOp;
    this.mask = new THREE.Mesh(ellipse, maskMat);
    this.mask.renderOrder = -100;
    this.root.add(this.mask);

    // Le monde, derrière l'arche (z négatif : en s'éloignant).
    this.root.add(this.land);
    const lights = [new THREE.HemisphereLight(0xcfe9ff, 0x5a7d3a, 1.25), new THREE.DirectionalLight(0xfff0d0, 2.2)];
    lights[1].position.set(80, 120, -60);
    this.land.add(...lights);

    // Ciel : dégradé, soleil et son halo.
    const sunDir = new THREE.Vector3(0.45, 0.32, -0.83).normalize();
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2500, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: { uSun: { value: sunDir } },
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uSun;
          varying vec3 vDir;
          void main() {
            float h = clamp(vDir.y, -0.2, 1.0);
            vec3 horizon = vec3(0.86, 0.93, 1.0);
            vec3 zenith = vec3(0.24, 0.55, 0.95);
            vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
            float sd = max(0.0, dot(normalize(vDir), uSun));
            col += vec3(1.0, 0.92, 0.75) * (pow(sd, 900.0) * 3.0 + pow(sd, 18.0) * 0.35);
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    sky.renderOrder = stencil(sky.material, -50);
    this.land.add(sky);

    // Nuages : de doux amas qui dérivent.
    for (let i = 0; i < 10; i++) {
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
              vec2 q = vUv * 3.0 + uSeed + vec2(uTime * 0.01, 0.0);
              for (int k = 0; k < 5; k++) { n += a * vnoise(q); q *= 2.0; a *= 0.5; }
              float shape = smoothstep(1.0, 0.2, length(p * vec2(1.0, 1.9))) * smoothstep(0.35, 0.75, n);
              vec3 col = mix(vec3(0.82, 0.88, 0.97), vec3(1.0), smoothstep(0.4, 0.8, n));
              gl_FragColor = vec4(col, shape * 0.9);
            }`,
          transparent: true,
          depthWrite: false,
        }),
      );
      const a = (i / 10) * Math.PI * 1.2 - Math.PI * 0.6;
      const dist = 700 + (i % 3) * 250;
      cloud.position.set(Math.sin(a) * dist, 160 + (i % 4) * 45, -Math.cos(a) * dist);
      cloud.scale.set(380 + (i % 3) * 120, 160, 1);
      cloud.lookAt(0, cloud.position.y, 0);
      cloud.renderOrder = stencil(cloud.material, -40);
      this.land.add(cloud);
    }

    // Terrain : vallée, lac, colline, montagnes ; facettes (style dessiné).
    const terrainGeo = new THREE.PlaneGeometry(2400, 1400, 300, 180);
    terrainGeo.rotateX(-Math.PI / 2);
    terrainGeo.translate(0, 0, -700);
    const pos = terrainGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, height(pos.getX(i), -pos.getZ(i)));
    const flat = terrainGeo.toNonIndexed();
    flat.computeVertexNormals();
    const fp = flat.attributes.position as THREE.BufferAttribute;
    const fn = flat.attributes.normal as THREE.BufferAttribute;
    const colors = new Float32Array(fp.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < fp.count; i += 3) {
      // Une couleur par facette (centre du triangle).
      const x = (fp.getX(i) + fp.getX(i + 1) + fp.getX(i + 2)) / 3;
      const y = (fp.getY(i) + fp.getY(i + 1) + fp.getY(i + 2)) / 3;
      const z = (fp.getZ(i) + fp.getZ(i + 1) + fp.getZ(i + 2)) / 3;
      groundColor(x, -z, y, 1 - Math.abs(fn.getY(i)), c);
      for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (i + k) * 3);
    }
    flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const terrain = new THREE.Mesh(flat, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }));
    terrain.renderOrder = stencil(terrain.material, 0);
    this.land.add(terrain);

    // Lac : reflet du ciel, petites vagues qui scintillent.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(LAKE.r * 2.6, LAKE.r * 2.6),
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uSun: { value: sunDir } },
        vertexShader: /* glsl */ `varying vec3 vWorld; varying vec2 vUv; void main() { vUv = uv; vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: /* glsl */ `
          uniform float uTime;
          uniform vec3 uSun;
          varying vec3 vWorld;
          varying vec2 vUv;
          void main() {
            float r = length(vUv * 2.0 - 1.0);
            float edge = smoothstep(1.0, 0.85, r);
            float w = sin(vWorld.x * 0.6 + uTime * 1.3) * sin(vWorld.z * 0.5 - uTime * 1.1);
            vec3 deep = vec3(0.13, 0.42, 0.62);
            vec3 sky = vec3(0.62, 0.82, 1.0);
            vec3 col = mix(deep, sky, 0.45 + 0.1 * w);
            col += vec3(1.0, 0.95, 0.8) * pow(max(0.0, w), 12.0) * 0.6;
            gl_FragColor = vec4(col, edge);
          }`,
        transparent: true,
        depthWrite: false,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(LAKE.x, WATER, -LAKE.d);
    water.renderOrder = stencil(water.material, 5);
    this.land.add(water);

    // Arbres : des cônes de feuillage et leur tronc, sur l'herbe.
    const leafGeo = new THREE.ConeGeometry(2.4, 7, 7);
    leafGeo.translate(0, 6, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.45, 3, 6);
    trunkGeo.translate(0, 1.5, 0);
    const spots: THREE.Matrix4[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 4000 && spots.length < 420; k++) {
      const x = (rnd() - 0.5) * 700;
      const d = 35 + rnd() * 420;
      const h = height(x, d);
      if (h < WATER + 1.5 || h > 30 || Math.hypot(x - CASTLE.x, d - CASTLE.d) < 30) continue;
      const slope = Math.abs(height(x + 2, d) - h) + Math.abs(height(x, d + 2) - h);
      if (slope > 2.2 || fbm(x * 0.012 + 3, d * 0.012, 2) < -0.05) continue; // en bosquets
      const sc = 0.7 + rnd() * 0.7;
      spots.push(new THREE.Matrix4().compose(new THREE.Vector3(x, h - 0.3, -d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28), new THREE.Vector3(sc, sc * (0.8 + rnd() * 0.5), sc)));
    }
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: "#3f7f35", flatShading: true, roughness: 1 }), spots.length);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: "#6b4a2f", flatShading: true, roughness: 1 }), spots.length);
    spots.forEach((m, i) => {
      leaves.setMatrixAt(i, m);
      trunks.setMatrixAt(i, m);
      leaves.setColorAt(i, new THREE.Color().setHSL(0.27 + rnd() * 0.06, 0.45, 0.28 + rnd() * 0.1));
    });
    leaves.renderOrder = stencil(leaves.material, 1);
    trunks.renderOrder = stencil(trunks.material, 1);
    this.land.add(leaves, trunks);

    // Château sur sa colline : donjon, tours aux toits bleus, flèche.
    const castle = new THREE.Group();
    const stone = new THREE.MeshStandardMaterial({ color: "#e2dccd", flatShading: true, roughness: 0.9 });
    const roof = new THREE.MeshStandardMaterial({ color: "#3c5fb0", flatShading: true, roughness: 0.7 });
    const tower = (x: number, z: number, r: number, h: number) => {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 10), stone);
      t.position.set(x, h / 2, z);
      const c2 = new THREE.Mesh(new THREE.ConeGeometry(r * 1.35, r * 2.6, 10), roof);
      c2.position.set(x, h + r * 1.3, z);
      castle.add(t, c2);
    };
    tower(0, 0, 6, 30);
    tower(0, 0, 2.2, 52);
    for (const [x, z] of [[-14, -10], [14, -10], [-14, 10], [14, 10]]) tower(x, z, 3.2, 22);
    for (const [x, z, w, d] of [[0, -10, 28, 2], [0, 10, 28, 2], [-14, 0, 2, 20], [14, 0, 2, 20]] as const) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 12, d), stone);
      wall.position.set(x, 6, z);
      castle.add(wall);
    }
    castle.position.set(CASTLE.x, height(CASTLE.x, CASTLE.d) - 1, -CASTLE.d);
    castle.traverse((o) => {
      if (o instanceof THREE.Mesh) o.renderOrder = stencil(o.material as THREE.Material, 1);
    });
    this.land.add(castle);

    // Premier plan : herbe haute qui ondule au vent, et des fleurs.
    const blade = new THREE.BufferGeometry();
    blade.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.025, 0, 0, 0.025, 0, 0, 0.006, 0.5, 0, -0.006, 0.5, 0, 0, 0.62, 0]), 3));
    blade.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4]);
    const BLADES = 7000;
    this.grass = new THREE.InstancedMesh(
      blade,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time },
        vertexShader: /* glsl */ `
          uniform float uTime;
          varying float vH;
          varying float vTint;
          void main() {
            vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
            float h = position.y / 0.62;
            vH = h;
            vTint = fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453);
            // Vent : des rafales qui passent sur la prairie.
            float gust = sin(base.x * 0.35 + uTime * 1.6) * 0.5 + sin(base.z * 0.5 + uTime * 1.1 + base.x * 0.2) * 0.5;
            vec4 p = instanceMatrix * vec4(position, 1.0);
            p.x += (0.12 + 0.1 * gust) * h * h;
            p.z += 0.05 * gust * h * h;
            gl_Position = projectionMatrix * viewMatrix * p;
          }`,
        fragmentShader: /* glsl */ `
          varying float vH;
          varying float vTint;
          void main() {
            vec3 dark = vec3(0.16, 0.36, 0.12);
            vec3 light = mix(vec3(0.56, 0.78, 0.3), vec3(0.72, 0.82, 0.38), vTint);
            gl_FragColor = vec4(mix(dark, light, vH), 1.0);
          }`,
        side: THREE.DoubleSide,
      }),
      BLADES,
    );
    for (let i = 0; i < BLADES; i++) {
      const x = (rnd() - 0.5) * 16;
      const d = 0.2 + rnd() ** 1.4 * 9;
      const sc = 0.6 + rnd() * 0.9;
      this.grass.setMatrixAt(i, new THREE.Matrix4().compose(new THREE.Vector3(x, height(x, d), -d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28), new THREE.Vector3(sc, sc * (0.7 + rnd() * 0.8), sc)));
    }
    this.grass.renderOrder = stencil(this.grass.material, 2);
    this.land.add(this.grass);
    const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.035, 0), new THREE.MeshStandardMaterial({ roughness: 0.6, emissive: new THREE.Color("#222") }), 260);
    const petals = ["#ffffff", "#ffd84f", "#ff8fb8", "#9fd0ff"].map((h) => new THREE.Color(h));
    for (let i = 0; i < 260; i++) {
      const x = (rnd() - 0.5) * 14;
      const d = 0.4 + rnd() * 8;
      flowers.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, height(x, d) + 0.3 + rnd() * 0.25, -d));
      flowers.setColorAt(i, petals[Math.floor(rnd() * petals.length)]);
    }
    flowers.renderOrder = stencil(flowers.material, 2);
    this.land.add(flowers);

    // Poussières dorées qui flottent dans la lumière, près de l'arche.
    const N = 160;
    const mp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) mp.set([(rnd() - 0.5) * 8, rnd() * 3, -0.5 - rnd() * 7], i * 3);
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(mp, 3));
    const motes = new THREE.Points(
      mg,
      new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uRes: shared.uRes },
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform vec2 uRes;
          varying float vA;
          void main() {
            vec3 p = position;
            float s = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
            p.y += mod(uTime * (0.05 + 0.08 * s) + s * 3.0, 3.0);
            p.x += sin(uTime * 0.5 + s * 6.28) * 0.3;
            vA = 0.5 + 0.5 * sin(uTime * (1.0 + 2.0 * s) + s * 10.0);
            vec4 view = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * view;
            gl_PointSize = 0.025 * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            float a = exp(-dot(p, p) * 3.0) * vA;
            gl_FragColor = vec4(vec3(1.0, 0.88, 0.55) * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    motes.frustumCulled = false;
    motes.renderOrder = stencil(motes.material, 10);
    this.land.add(motes);

    // Le corps de la personne devant l'arche : là où il est, l'arche est cachée (noir = le reflet).
    this.body = new THREE.Mesh(
      ellipse,
      new THREE.ShaderMaterial({
        uniforms: { ...shared },
        vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uOcc;
          uniform vec2 uRes;
          uniform float uHasOcc;
          void main() {
            if (uHasOcc < 0.5) discard;
            vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
            float cover = smoothstep(0.35, 0.65, texture2D(uOcc, uv).g);
            gl_FragColor = vec4(0.0, 0.0, 0.0, cover);
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
      }),
    );
    this.body.renderOrder = stencil(this.body.material, 50);
    this.root.add(this.body);

    // Bord de l'arche : un anneau d'énergie bleu-cyan qui tourne (caché aussi derrière le corps).
    this.rim = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { ...shared, uTime: this.time, uOpen: { value: 0 }, uSolid: { value: 2 } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D uOcc;
          uniform vec2 uRes;
          uniform float uHasOcc;
          uniform float uScale;
          uniform float uSolid;
          uniform float uTime;
          uniform float uOpen;
          varying vec2 vUv;
          void main() {
            vec2 p = vUv * 2.0 - 1.0;
            // Ellipse du portail : rayon 1/1,18 en x, 1/1,12 en y de ce quad.
            float r = length(p * vec2(1.18, 1.12));
            float a = atan(p.y, p.x);
            float swirl = 0.5 + 0.5 * sin(a * 6.0 - uTime * 2.2 + sin(a * 3.0 + uTime) * 1.5);
            float ring = exp(-pow((r - 1.0) / (0.018 + 0.012 * swirl), 2.0));
            float glow = exp(-pow((r - 1.0) / 0.09, 2.0)) * 0.35;
            float flash = (1.0 - smoothstep(0.0, 0.35, uOpen)) * exp(-pow((r - 1.0) / 0.2, 2.0)) * 2.0 * step(0.02, uOpen);
            vec3 col = mix(vec3(0.25, 0.85, 1.0), vec3(0.95, 0.98, 1.0), swirl * 0.6) * (ring * (1.2 + swirl) + glow) + vec3(1.0) * flash;
            float alpha = clamp(ring + glow + flash, 0.0, 1.0) * smoothstep(0.0, 0.08, uOpen);
            float v = 1.0;
            if (uHasOcc > 0.5) {
              vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
              vec2 o = texture2D(uOcc, uv).rg;
              v = 1.0 - smoothstep(0.35, 0.65, o.g) * (1.0 - smoothstep(-0.01, 0.01, o.r * 255.0 * uScale - uSolid));
            }
            gl_FragColor = vec4(col * alpha * v, alpha * v);
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

}

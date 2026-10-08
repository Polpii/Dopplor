// Mode portail : une arche de lumière, grande, au milieu de l'écran, ouvre sur une vallée en fin
// de journée : une prairie au bord d'une falaise, la vallée et sa rivière, un lac, des forêts, un
// château sur sa colline, des montagnes enneigées dans la brume, des nuages, le soleil bas.
//
// L'arche est posée sur la vitre : elle ne bouge pas et garde sa taille, comme une fenêtre percée
// dans le miroir. Ce qu'on voit à travers dépend de l'œil (MirrorWorld, perspective décentrée) :
// se pencher à gauche fait regarder vers la droite du monde, s'approcher élargit la vue, le
// premier plan glisse plus que le lointain. Personne devant : vue neutre (un œil au centre). Une
// personne arrive : on attend qu'elle soit stable, puis la vue passe en douceur à son regard.
//
// Rendu « réaliste » sans texture : relief lisse, ombres du soleil bas portées sur le relief
// (calculées une fois), occlusion ambiante, ciel atmosphérique et nuages, perspective aérienne
// (le lointain bleuit et se voile), eau qui reflète le ciel, tons filmiques (ACES). Le paysage
// n'est dessiné qu'à l'intérieur de l'arche (stencil), en pleine définition.
//
// Échelle : vu à ~2 m par une arche d'un demi-mètre, l'angle est étroit (un téléobjectif) ; tout est
// donc grand et loin (vallée 60 m plus bas, montagnes à 2 km).
import * as THREE from "three";
import { Fairy } from "../fairy/fairy";
import type { MirrorWorld } from "../fairy/world";

/** Arche : part de l'écran qu'elle occupe (largeur, hauteur), centre (fraction de la hauteur). */
const PORTAL_W = 0.96;
const PORTAL_H = 0.95;
const PORTAL_Y = 0.5;
const OPEN_MS = 1400;
const FAR = 6000;
/** Hauteur de l'horizon dans l'arche (fraction depuis le haut), œil au-dessus de la prairie (m). */
const HORIZON = 0.4;
const LEDGE_BELOW_EYE = 1.6;
/** Une personne est « stable » quand son œil reste dans ce rayon (m) pendant ce temps (ms). */
const STABLE_RADIUS = 0.06;
const STABLE_MS = 900;
const LOST_MS = 1500;
/** Vallée en contrebas du bord de la prairie (m), niveau de l'eau. */
const VALLEY = -60;
const WATER = VALLEY - 3.5;
/** Soleil bas, un peu à droite de la vue (repère du paysage : x à droite, y en haut, -z au loin). */
const SUN = new THREE.Vector3(0.62, 0.26, -0.74).normalize();
/** Petites fées : couleurs ; les premières volent sur la prairie, les autres au-dessus du vide. */
const FAIRY_TINTS = ["#73ccff", "#ffd36b", "#ff8fc8", "#8dff9e", "#c39bff", "#7fe8ff", "#ffb36b", "#ff9fe0"];
const NEAR_FAIRIES = 5;

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
/** Bruit « en crêtes » : arêtes vives des montagnes. */
const ridged = (x: number, y: number, oct: number) => {
  let a = 0.5;
  let f = 1;
  let v = 0;
  let w = 1;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(noise(x * f, y * f));
    n *= n * w;
    w = Math.min(1, n * 1.8);
    v += a * n;
    f *= 2.07;
    a *= 0.5;
  }
  return v;
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- Le paysage : x à droite, d en s'éloignant (m), hauteur 0 = la prairie ---------------------------

const CASTLE = { x: 70, d: 820 };
const LAKE = { x: -55, d: 470, r: 120 };
/** Rivière : serpente dans la vallée, passe par le lac. */
const riverX = (d: number) => 35 * Math.sin(d * 0.005) + 15 * Math.sin(d * 0.013 + 1.3) - 78;
/** Grand pic enneigé au fond ; cascade (sur la rivière) qui tombe d'un plateau derrière le lac ;
 *  village au bord de la rivière. */
const PEAK = { x: 220, d: 2700, r: 300 };
const FALLS = { x: riverX(985), d: 985, h: 150 };
const VILLAGE = { x: 10, d: 335, r: 55 };
/** Lune : direction (un peu à gauche, basse sur l'horizon). */
const MOON = new THREE.Vector3(-0.17, 0.2, -0.97).normalize();
/** Dragon-serpent : nombre d'anneaux, écart entre anneaux (s de trajet), rayon (m). */
const DRAGON_RINGS = 120;
const DRAGON_LAG = 0.12;
const DRAGON_R = 9;
/** Bord de la falaise (distance à l'arche, m), irrégulier. */
const edgeD = (x: number) => 2.6 + 0.6 * noise(x * 0.35, 4.2) + 0.3 * noise(x * 1.3, 9.1);

function height(x: number, d: number): number {
  const cx = riverX(d);
  let h = VALLEY + fbm(x * 0.0025, d * 0.0025, 5) * 22 + fbm(x * 0.011, d * 0.011, 3) * 5;
  // Flancs de la vallée.
  h += smoothstep(120, 650, Math.abs(x - cx)) * smoothstep(80, 400, d) * (50 + 90 * (fbm(x * 0.004 + 5, d * 0.004, 4) + 0.5));
  // Colline du château.
  h += smoothstep(170, 40, Math.hypot(x - CASTLE.x, d - CASTLE.d)) * 65;
  // Rivière et lac creusés sous le niveau de l'eau.
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 2, h, smoothstep(8, 22, Math.abs(x - cx))));
  const lake = Math.hypot((x - LAKE.x) * 0.75, d - LAKE.d);
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 3, h, smoothstep(LAKE.r * 0.75, LAKE.r * 1.2, lake)));
  // Montagnes au loin.
  const m = smoothstep(1100, 1900, d);
  if (m > 0) h += m * (90 + 430 * ridged(x * 0.0011 + 3.1, d * 0.0011, 6));
  const pk = Math.hypot(x - PEAK.x, (d - PEAK.d) * 0.8);
  if (pk < PEAK.r * 3) h += Math.exp(-((pk / PEAK.r) ** 2)) * (560 + 90 * ridged(x * 0.004, d * 0.004, 4));
  // Plateau et sa falaise ; la rivière l'entaille là où tombe la cascade.
  const fd = FALLS.d + 45 * noise(x * 0.012, 7.7) * smoothstep(25, 70, Math.abs(x - FALLS.x));
  const plateau = smoothstep(fd - 25, fd + 8, d) * smoothstep(-360, -280, x) * (1 - smoothstep(0, 80, x));
  if (plateau > 0) {
    const top = VALLEY + FALLS.h + fbm(x * 0.01, d * 0.01, 3) * 12 - (1 - smoothstep(9, 20, Math.abs(x - FALLS.x))) * 7;
    h = Math.max(h, THREE.MathUtils.lerp(h, top, plateau));
  }
  // Vasque au pied de la cascade.
  const pool = Math.hypot(x - FALLS.x, d - (FALLS.d - 50));
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 3, h, smoothstep(28, 45, pool)));
  // La prairie au premier plan, puis la falaise.
  const e = edgeD(x);
  return THREE.MathUtils.lerp(h, fbm(x * 0.4, d * 0.4, 2) * 0.12, smoothstep(e + 1.4, e, d));
}

/** Densité de forêt (0–1) à un endroit. */
function forestAt(x: number, d: number, h: number, slope: number): number {
  return (
    smoothstep(-0.05, 0.2, fbm(x * 0.007 + 3, d * 0.007, 3)) *
    smoothstep(WATER + 1.5, WATER + 4, h) *
    (1 - smoothstep(VALLEY + 130, VALLEY + 180, h)) *
    (1 - smoothstep(0.3, 0.5, slope)) *
    smoothstep(60, 140, d) *
    smoothstep(60, 95, Math.hypot(x - CASTLE.x, d - CASTLE.d)) *
    smoothstep(VILLAGE.r, VILLAGE.r + 30, Math.hypot(x - VILLAGE.x, d - VILLAGE.d))
  );
}

// --- Éclairage et atmosphère, communs à tout le paysage (GLSL, repère du paysage, linéaire) --------

const COMMON = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uCam;
uniform float uTime;
const vec3 SUNC = vec3(1.0, 0.78, 0.52) * 3.4;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm3(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 3; k++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return v / 0.875; }
float fbm5(vec2 p) { float v = 0.0, a = 0.5; for (int k = 0; k < 5; k++) { v += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; } return v / 0.97; }
// Ciel sans nuages dans la direction d : bleu profond au zénith, horizon pâle, bande chaude et
// halo vers le soleil.
vec3 skyBase(vec3 d) {
  float h = max(d.y, 0.0);
  float sd = max(dot(d, uSun), 0.0);
  vec3 col = mix(vec3(0.52, 0.60, 0.74), vec3(0.07, 0.20, 0.52), pow(smoothstep(0.0, 0.7, h), 0.6));
  col = mix(col, vec3(1.15, 0.70, 0.40), exp(-h * 10.0) * (0.18 + 0.75 * pow(sd, 3.0)));
  return col + vec3(1.0, 0.70, 0.40) * (pow(sd, 10.0) * 0.5 + pow(sd, 90.0) * 1.2);
}
vec3 hazeColor(vec3 d) { return skyBase(vec3(d.x, max(d.y, 0.0) * 0.5 + 0.04, d.z)) * vec3(0.78, 0.82, 0.9); }
// Perspective aérienne : plus c'est loin (et bas), plus l'air s'interpose, couleur du ciel.
vec3 aerial(vec3 col, vec3 p) {
  vec3 v = p - uCam;
  float dist = length(v);
  float above = max(0.0, (p.y + uCam.y) * 0.5 - (${VALLEY.toFixed(1)}));
  float f = 1.0 - exp(-dist * 0.00016 * exp(-above / 400.0));
  return mix(col, hazeColor(v / dist), f);
}
vec3 ambient(vec3 n) { return mix(vec3(0.10, 0.10, 0.08), vec3(0.30, 0.40, 0.58), n.y * 0.5 + 0.5); }
// Tons filmiques (ACES), puis sRGB.
vec3 finish(vec3 c) { c = clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0); return pow(c, vec3(1.0 / 2.2)); }
`;

const VERT_LOCAL = /* glsl */ `
uniform mat4 uLandInv;
varying vec3 vLocal;
varying vec3 vN;
mat4 modelOf() {
  #ifdef USE_INSTANCING
  return modelMatrix * instanceMatrix;
  #else
  return modelMatrix;
  #endif
}
`;

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
  private uniforms = {
    uSun: { value: SUN.clone() },
    uCam: { value: new THREE.Vector3() },
    uTime: this.time,
    uLandInv: { value: new THREE.Matrix4() },
  };
  private size = new THREE.Vector2(1, 1.5);
  private seed = 7;
  // Grille de hauteurs du terrain (pour les ombres et la pose des arbres).
  private heights: Float32Array | null = null;
  // Point de vue : 0 = neutre, 1 = l'œil de la personne.
  private follow = 0;
  private locked = false;
  private anchor = new THREE.Vector3(1e9, 0, 0);
  private anchorSince = 0;
  private seenAt = -1e9;
  private lastFrame = 0;
  private fairies: { fairy: Fairy; seed: number; near: boolean; prev: THREE.Vector3 | null }[] = [];
  private boats: THREE.Group[] = [];
  private dragon: { rings: THREE.InstancedMesh; mane: THREE.Points; head: THREE.Group } | null = null;
  private birds: { mesh: THREE.InstancedMesh; offsets: THREE.Vector3[] } | null = null;

  constructor(
    private world: MirrorWorld,
    private present: () => boolean = () => false,
  ) {
    this.root.visible = false;
    world.scene.add(this.root);
  }

  get on(): boolean {
    return this.active;
  }

  get visible(): boolean {
    return this.active;
  }

  /** Calcule le paysage à l'avance (sinon à la première ouverture). */
  prepare(): void {
    if (!this.built) this.build();
  }

  enter(now = performance.now()): void {
    this.active = true;
    this.openedAt = now;
    this.needPlace = true;
    this.follow = 0;
    this.locked = false;
    this.anchor.set(1e9, 0, 0);
    this.world.far = FAR;
    this.world.setResolution(1); // 4K : le paysage est la vedette
    this.world.viewEye = (eye) => this.neutralEye().lerp(eye, this.follow * this.follow * (3 - 2 * this.follow));
  }

  exit(): void {
    this.active = false;
    this.root.visible = false;
    this.world.far = 30;
    this.world.setResolution(0.5);
    this.world.viewEye = null;
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  /** L'œil supposé quand personne n'est devant : centré, en haut de l'écran, à 2 m. */
  private neutralEye(): THREE.Vector3 {
    const [sw, sh] = this.world.screenMeters;
    return new THREE.Vector3(sw / 2, -sh * 0.2, 2);
  }

  /** L'arche sur la vitre, au milieu de l'écran (fixe, quelle que soit la place de l'œil). */
  private place(): void {
    const [sw, sh, gap] = this.world.screenMeters;
    this.size.set(sw * PORTAL_W, sh * PORTAL_H);
    this.root.position.set(sw / 2, -sh * PORTAL_Y, -gap);
    if (!this.built) this.build();
    // Par une vraie fenêtre, l'horizon est à hauteur d'œil : l'œil étant en haut de l'écran, on ne
    // verrait presque que le sol. Le monde est donc incliné (pour l'œil neutre, une fois pour
    // toutes) : son horizon tombe aux 2/5 de l'arche, la prairie est 1,2 m sous l'œil.
    const e = this.neutralEye().sub(this.root.position);
    const pitch = Math.atan2(this.size.y * (0.5 - HORIZON) - e.y, e.z);
    this.land.rotation.x = pitch;
    // Les fées sont des lumières plates face à l'écran : on annule l'inclinaison du monde.
    for (const f of this.fairies) f.fairy.group.rotation.x = -pitch;
    this.land.position.y = e.y + (e.z * Math.sin(pitch) - LEDGE_BELOW_EYE) / Math.cos(pitch);
    this.root.visible = true;
  }

  /** Suivi du regard : attend qu'une personne soit stable devant l'arche, puis la suit. */
  private updateFollow(now: number, dt: number): void {
    const eye = this.world.trackedEye;
    if (this.present() && eye) {
      this.seenAt = now;
      if (eye.distanceTo(this.anchor) > STABLE_RADIUS) {
        this.anchor.copy(eye);
        this.anchorSince = now;
      }
      if (now - this.anchorSince > STABLE_MS) this.locked = true;
    }
    if (now - this.seenAt > LOST_MS) this.locked = false;
    this.follow += ((this.locked ? 1 : 0) - this.follow) * (1 - Math.exp(-dt / 0.6));
  }

  frame(now: number): void {
    if (!this.active || !this.world.ready) return;
    if (this.needPlace) {
      this.needPlace = false;
      this.place();
    }
    const dt = Math.min(0.1, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.updateFollow(now, dt);
    this.time.value = now / 1000;
    const open = Math.min(1, (now - this.openedAt) / OPEN_MS);
    const e = 1 - (1 - open) ** 3;
    // L'arche s'ouvre (ellipse qui grandit), avec un éclair au bord.
    const s = new THREE.Vector3(this.size.x * Math.max(0.001, e), this.size.y * Math.max(0.001, e), 1);
    this.mask.scale.copy(s);
    this.rim.scale.set(s.x * 1.18, s.y * 1.12, 1);
    this.rim.material.uniforms.uOpen.value = open;
    // On y entre : le monde avance un peu pendant l'ouverture.
    this.land.position.z = -1.5 * (1 - e);
    this.flyFairies(now / 1000, dt, e);
    this.animateLife(now / 1000);
    this.root.updateMatrixWorld(true);
    this.uniforms.uLandInv.value.copy(this.land.matrixWorld).invert();
    this.uniforms.uCam.value.copy(this.world.camera.position).applyMatrix4(this.uniforms.uLandInv.value);
  }

  // --- Hauteurs et ombres ----------------------------------------------------------------------------

  private static NX = 520;
  private static NZ = 380;
  private static gridD(j: number): number {
    const v = j / PortalMode.NZ;
    return 0.2 + v * v * 3200;
  }
  /** Demi-largeur du terrain à la distance d : assez large pour qui se penche beaucoup. */
  private static half(d: number): number {
    return 30 + d * 1.4;
  }
  private static gridX(i: number, d: number): number {
    return (i / PortalMode.NX - 0.5) * 2 * PortalMode.half(d);
  }

  /** Hauteur lue dans la grille (bilinéaire) ; très bas hors de la grille. */
  private heightAt(x: number, d: number): number {
    const { NX, NZ } = PortalMode;
    if (d < 0.2 || d >= 3200) return -1e9;
    const fj = NZ * Math.sqrt((d - 0.2) / 3200);
    const fi = (x / (2 * PortalMode.half(d)) + 0.5) * NX;
    if (fi < 0 || fi >= NX) return -1e9;
    const i = Math.floor(fi);
    const j = Math.min(NZ - 1, Math.floor(fj));
    const u = fi - i;
    const v = fj - j;
    const H = this.heights!;
    const at = (a: number, b: number) => H[b * (NX + 1) + a];
    return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v;
  }

  /** Lumière du soleil (0 ombre – 1 plein soleil) en un point, pénombre douce. */
  private sunlight(x: number, d: number, h: number): number {
    let s = 1;
    let t = 1.5;
    for (let k = 0; k < 40 && t < 3000; k++) {
      const py = h + 0.3 + SUN.y * t;
      const hh = this.heightAt(x + SUN.x * t, d - SUN.z * t);
      s = Math.min(s, (py - hh) / (t * 0.03));
      if (s <= 0) return 0;
      t *= 1.2;
    }
    return smoothstep(0, 1, s);
  }

  private slopeAt(x: number, d: number): number {
    const gx = (this.heightAt(x + 2, d) - this.heightAt(x - 2, d)) / 4;
    const gd = (this.heightAt(x, d + 2) - this.heightAt(x, d - 2)) / 4;
    return 1 - 1 / Math.sqrt(1 + gx * gx + gd * gd);
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
    const t0 = performance.now();
    this.buildPortal();
    this.root.add(this.land);
    this.buildSky();
    this.buildTerrain();
    this.buildWater();
    this.buildForest();
    this.buildCastle();
    this.buildMeadow();
    this.buildMotes();
    this.buildFairies();
    this.buildFalls();
    this.buildVillage();
    this.buildBoats();
    this.buildDragon();
    this.buildBirds();
    console.info(`portail : paysage en ${Math.round(performance.now() - t0)} ms`);
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
            float ring = exp(-pow((r - 1.0) / (0.014 + 0.012 * swirl), 2.0));
            float glow = exp(-pow((r - 1.0) / 0.09, 2.0)) * 0.4;
            float flash = (1.0 - smoothstep(0.0, 0.35, uOpen)) * exp(-pow((r - 1.0) / 0.2, 2.0)) * 2.0 * step(0.02, uOpen);
            vec3 cyan = vec3(0.3, 0.88, 1.0);
            vec3 gold = vec3(1.0, 0.86, 0.55);
            vec3 col = mix(cyan, gold, swirl * 0.45) * (ring * (1.3 + swirl) + glow) + vec3(1.0) * flash;
            float alpha = clamp(ring + glow + flash, 0.0, 1.0) * smoothstep(0.0, 0.08, uOpen);
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

  /** Ciel : dégradé atmosphérique, soleil, et une couche de nuages éclairés par le soleil bas. */
  private buildSky(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 64, 32),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            vec3 col = skyBase(d);
            float sd = dot(d, uSun);
            col += vec3(1.6, 1.2, 0.8) * smoothstep(0.99985, 0.99993, sd) * 8.0;
            // Croissant de lune géant, éclairé du côté du soleil, cratères.
            vec3 mdir = vec3(${MOON.x.toFixed(4)}, ${MOON.y.toFixed(4)}, ${MOON.z.toFixed(4)});
            vec3 mt = normalize(cross(mdir, vec3(0.0, 1.0, 0.0)));
            vec3 mb = cross(mt, mdir);
            vec2 mp = vec2(dot(d, mt), dot(d, mb)) / 0.055;
            float mr = length(mp);
            if (dot(d, mdir) > 0.0 && mr < 1.6) {
              float disk = 1.0 - smoothstep(0.985, 1.0, mr);
              vec3 mn = mt * mp.x + mb * mp.y - mdir * sqrt(max(0.0, 1.0 - mr * mr));
              float lit = smoothstep(-0.04, 0.2, dot(mn, uSun));
              float crater = 0.72 + 0.28 * fbm3(mp * 3.0 + 11.0) - 0.12 * smoothstep(0.55, 0.7, fbm3(mp * 1.4 + 3.0));
              col += vec3(1.25, 1.18, 1.05) * lit * crater * disk * 1.6 + vec3(0.03, 0.04, 0.06) * disk;
              col += vec3(1.0, 0.95, 0.85) * exp(-max(0.0, mr - 1.0) * 6.0) * 0.06 * (1.0 - disk);
            }
            if (d.y > 0.0) {
              // Nuages sur un plafond : plus serrés vers l'horizon, comme en vrai.
              vec2 q = d.xz / (d.y + 0.03) * 1.6 + vec2(uTime * 0.004, uTime * 0.001);
              float c = fbm5(q * 0.55);
              float dens = smoothstep(0.6, 0.86, c);
              float toward = fbm5(q * 0.55 + uSun.xz * 0.12);
              float lit = clamp(0.55 + (c - toward) * 4.0, 0.0, 1.0);
              vec3 cc = mix(vec3(0.42, 0.40, 0.46), vec3(1.35, 1.0, 0.72), lit);
              cc += vec3(1.2, 0.8, 0.45) * pow(max(sd, 0.0), 6.0) * (1.0 - dens) * 1.5; // bords dorés
              col = mix(col, cc, dens * smoothstep(0.0, 0.08, d.y) * 0.92);
            }
            col = mix(col, hazeColor(d), smoothstep(0.0, -0.03, d.y));
            gl_FragColor = vec4(finish(col), 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    );
    this.add(sky, -50);
  }

  /** Terrain : grille plus fine près de soi, relief lisse, ombres portées, occlusion, forêts. */
  private buildTerrain(): void {
    const { NX, NZ } = PortalMode;
    const W = NX + 1;
    const count = W * (NZ + 1);
    const H = new Float32Array(count);
    const pos = new Float32Array(count * 3);
    for (let j = 0; j <= NZ; j++) {
      const d = PortalMode.gridD(j);
      for (let i = 0; i <= NX; i++) {
        const x = PortalMode.gridX(i, d);
        const h = height(x, d);
        H[j * W + i] = h;
        pos.set([x, h, -d], (j * W + i) * 3);
      }
    }
    this.heights = H;
    const shade = new Float32Array(count);
    const ao = new Float32Array(count);
    const forest = new Float32Array(count);
    for (let j = 0; j <= NZ; j++) {
      const d = PortalMode.gridD(j);
      for (let i = 0; i <= NX; i++) {
        const k = j * W + i;
        const x = pos[k * 3];
        const h = H[k];
        shade[k] = this.sunlight(x, d, h);
        // Creux plus sombres : moyenne des voisins au-dessus du point.
        let sum = 0;
        let n = 0;
        for (const [di, dj] of [[-4, 0], [4, 0], [0, -4], [0, 4]]) {
          const a = i + di;
          const b = j + dj;
          if (a < 0 || a > NX || b < 0 || b > NZ) continue;
          sum += H[b * W + a];
          n++;
        }
        ao[k] = Math.min(1, Math.max(0.5, 1 - Math.max(0, sum / n - h) / 25));
        forest[k] = forestAt(x, d, h, this.slopeAt(x, d));
      }
    }
    const index: number[] = [];
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const a = j * W + i;
        index.push(a, a + 1, a + W, a + 1, a + W + 1, a + W);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aShade", new THREE.BufferAttribute(shade, 1));
    geo.setAttribute("aAO", new THREE.BufferAttribute(ao, 1));
    geo.setAttribute("aForest", new THREE.BufferAttribute(forest, 1));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        ${VERT_LOCAL}
        attribute float aShade;
        attribute float aAO;
        attribute float aForest;
        varying float vShade;
        varying float vAO;
        varying float vForest;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vLocal = (uLandInv * w).xyz;
          vN = normal;
          vShade = aShade;
          vAO = aAO;
          vForest = aForest;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        varying vec3 vLocal;
        varying vec3 vN;
        varying float vShade;
        varying float vAO;
        varying float vForest;
        void main() {
          vec3 n = normalize(vN);
          vec2 p = vLocal.xz;
          float h = vLocal.y;
          float slope = 1.0 - n.y;
          float n1 = fbm3(p * 0.02);
          float n2 = vnoise(p * 0.3);
          vec3 grass = mix(vec3(0.09, 0.15, 0.035), vec3(0.16, 0.20, 0.05), n1);
          grass = mix(grass, vec3(0.26, 0.22, 0.09), smoothstep(0.55, 0.8, fbm3(p * 0.006 + 7.0)) * 0.7);
          grass *= 0.85 + 0.3 * n2;
          vec3 col = mix(grass, vec3(0.03, 0.055, 0.02) * (0.8 + 0.4 * n2), vForest);
          vec3 rock = mix(vec3(0.17, 0.14, 0.11), vec3(0.34, 0.28, 0.21), fbm3(p * 0.05 + vec2(0.0, h * 0.1)));
          rock *= 0.7 + 0.45 * vnoise(vec2(h * 0.35, p.x * 0.004 + p.y * 0.004)) * (0.6 + 0.4 * vnoise(p * 0.08));
          float rockMask = max(smoothstep(0.28, 0.5, slope + (n1 - 0.5) * 0.2), smoothstep(${(VALLEY + 170).toFixed(1)}, ${(VALLEY + 260).toFixed(1)}, h + n1 * 40.0));
          col = mix(col, rock, rockMask);
          float snow = smoothstep(${(VALLEY + 300).toFixed(1)}, ${(VALLEY + 360).toFixed(1)}, h + n1 * 60.0) * (1.0 - smoothstep(0.45, 0.7, slope));
          col = mix(col, vec3(0.85, 0.87, 0.92), snow);
          col = mix(col, vec3(0.30, 0.27, 0.19), smoothstep(${(WATER + 1.2).toFixed(1)}, ${(WATER + 0.2).toFixed(1)}, h));
          vec3 c = col * (SUNC * max(dot(n, uSun), 0.0) * vShade + ambient(n) * vAO);
          gl_FragColor = vec4(finish(aerial(c, vLocal)), 1.0);
        }`,
    });
    this.add(new THREE.Mesh(geo, mat), 0);
  }

  /** L'eau : vagues fines, reflet du ciel (Fresnel), scintillement du soleil, brume. */
  private buildWater(): void {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 1.0, 0.0);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec3 vLocal;
          void main() {
            vec2 p = vLocal.xz;
            vec2 g = vec2(0.0);
            for (int k = 0; k < 6; k++) {
              float fk = float(k);
              float ang = fk * 2.39996 + 0.4;
              vec2 dir = vec2(cos(ang), sin(ang));
              float f = 0.08 * pow(1.7, fk);
              g += dir * cos(dot(dir, p) * f + uTime * (0.6 + 0.35 * fk)) * 0.035 / (1.0 + fk * 0.6);
            }
            g += (vec2(vnoise(p * 1.3 + uTime * 0.3), vnoise(p.yx * 1.3 - uTime * 0.3)) - 0.5) * 0.03;
            vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
            vec3 v = normalize(vLocal - uCam);
            vec3 r = reflect(v, n);
            r.y = abs(r.y);
            float fres = 0.02 + 0.98 * pow(1.0 - max(dot(-v, n), 0.0), 5.0);
            vec3 col = mix(vec3(0.01, 0.035, 0.04), skyBase(r), fres);
            col += SUNC * pow(max(dot(r, uSun), 0.0), 300.0) * 3.0;
            gl_FragColor = vec4(finish(aerial(col, vLocal)), 1.0);
          }`,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER;
    this.add(water, -1);
  }

  /** Matériau éclairé (soleil, ciel, brume) : couleur par instance (aTint) ou fixe. */
  private lit(opts: { color?: THREE.Color; emissive?: THREE.Color; shade?: number; aoHeight?: number }): THREE.ShaderMaterial {
    const defines: Record<string, string> = {};
    if (!opts.color) defines.INST_TINT = "1";
    if (opts.aoHeight) defines.AO_H = opts.aoHeight.toFixed(2);
    return new THREE.ShaderMaterial({
      defines,
      uniforms: {
        ...this.uniforms,
        uColor: { value: opts.color ?? new THREE.Color() },
        uEmissive: { value: opts.emissive ?? new THREE.Color(0, 0, 0) },
        uShade: { value: opts.shade ?? 1 },
      },
      vertexShader: /* glsl */ `
        ${VERT_LOCAL}
        #ifdef INST_TINT
        attribute vec3 aTint;
        attribute float aShade;
        #endif
        uniform vec3 uColor;
        uniform float uShade;
        varying vec3 vTint;
        varying float vShade;
        varying float vY;
        void main() {
          mat4 m = modelOf();
          vec4 w = m * vec4(position, 1.0);
          vLocal = (uLandInv * w).xyz;
          vN = normalize(mat3(uLandInv) * mat3(m) * normal);
          #ifdef INST_TINT
          vTint = aTint;
          vShade = aShade;
          #else
          vTint = uColor;
          vShade = uShade;
          #endif
          vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        uniform vec3 uEmissive;
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec3 vTint;
        varying float vShade;
        varying float vY;
        void main() {
          vec3 n = normalize(vN);
          float ao = 1.0;
          #ifdef AO_H
          ao = mix(0.35, 1.0, clamp(vY / AO_H, 0.0, 1.0));
          #endif
          vec3 albedo = vTint * (0.85 + 0.3 * vnoise(vLocal.xz * 0.7 + vLocal.y));
          vec3 c = albedo * (SUNC * max(dot(n, uSun), 0.0) * vShade * ao + ambient(n) * ao) + uEmissive;
          gl_FragColor = vec4(finish(aerial(c, vLocal)), 1.0);
        }`,
    });
  }

  /** Forêts : sapins (étages de cônes) et feuillus, en massifs denses, ombrés par le relief. */
  private buildForest(): void {
    const merge = (parts: THREE.BufferGeometry[]) => {
      const flat = parts.map((g) => g.toNonIndexed());
      const pos = flat.flatMap((g) => Array.from(g.attributes.position.array as Float32Array));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      return geo;
    };
    const conifer = merge(
      [[3.4, 8, 2], [2.7, 7, 6], [1.9, 6, 10], [1.0, 4, 13.5]].map(([r, h, y]) => new THREE.ConeGeometry(r, h, 8, 1).translate(0, y + h / 2, 0)),
    );
    const round = new THREE.IcosahedronGeometry(5, 1);
    const rp = round.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < rp.count; i++) {
      const k = 0.8 + 0.4 * Math.abs(noise(rp.getX(i) * 0.4, rp.getY(i) * 0.4 + rp.getZ(i) * 0.3));
      rp.setXYZ(i, rp.getX(i) * k, rp.getY(i) * k * 1.15 + 9, rp.getZ(i) * k);
    }
    const leafy = merge([round]);

    type Tree = { m: THREE.Matrix4; tint: THREE.Color; shade: number };
    const cones: Tree[] = [];
    const rounds: Tree[] = [];
    for (let k = 0; k < 400000 && cones.length + rounds.length < 26000; k++) {
      const d = 80 + this.rnd() * 1620;
      const x = (this.rnd() - 0.5) * 2 * (80 + d * 0.9);
      const h = this.heightAt(x, d);
      if (this.rnd() > forestAt(x, d, h, this.slopeAt(x, d)) * 0.9) continue;
      const sc = 0.7 + this.rnd() * 0.6;
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, h - 0.5, -d),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.rnd() * 6.28),
        new THREE.Vector3(sc, sc * (0.85 + this.rnd() * 0.4), sc),
      );
      const shade = this.sunlight(x, d, h + 10 * sc);
      if (this.rnd() < 0.72) {
        cones.push({ m, shade, tint: new THREE.Color(0.018 + this.rnd() * 0.012, 0.04 + this.rnd() * 0.02, 0.02 + this.rnd() * 0.01) });
      } else {
        const r = this.rnd();
        const tint = r < 0.12 ? new THREE.Color(0.2, 0.14, 0.03) : new THREE.Color(0.05 + this.rnd() * 0.04, 0.08 + this.rnd() * 0.04, 0.02 + this.rnd() * 0.01);
        rounds.push({ m, shade, tint });
      }
    }
    for (const [geo, trees, aoH] of [[conifer, cones, 17], [leafy, rounds, 14]] as const) {
      const mesh = new THREE.InstancedMesh(geo, this.lit({ aoHeight: aoH }), trees.length);
      const tint = new Float32Array(trees.length * 3);
      const shade = new Float32Array(trees.length);
      trees.forEach((t, i) => {
        mesh.setMatrixAt(i, t.m);
        tint.set([t.tint.r, t.tint.g, t.tint.b], i * 3);
        shade[i] = t.shade;
      });
      geo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
      geo.setAttribute("aShade", new THREE.InstancedBufferAttribute(shade, 1));
      mesh.frustumCulled = false;
      this.add(mesh, 1);
    }
  }

  /** Le château sur sa colline : donjon, tours aux toits d'ardoise, remparts, fenêtres allumées. */
  private buildCastle(): void {
    const h0 = height(CASTLE.x, CASTLE.d);
    const shade = this.sunlight(CASTLE.x, CASTLE.d, h0 + 25);
    const castle = new THREE.Group();
    const stone = this.lit({ color: new THREE.Color(0.4, 0.38, 0.34), shade });
    const roof = this.lit({ color: new THREE.Color(0.05, 0.07, 0.11), shade });
    const glow = this.lit({ color: new THREE.Color(0, 0, 0), emissive: new THREE.Color(1.6, 0.95, 0.4), shade });
    const tower = (x: number, z: number, r: number, h: number) => {
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.08, h, 16), stone);
      t.position.set(x, h / 2, z);
      const c = new THREE.Mesh(new THREE.ConeGeometry(r * 1.3, r * 2.8, 16), roof);
      c.position.set(x, h + r * 1.4, z);
      castle.add(t, c);
      for (let k = 0; k < 4; k++) {
        const w = new THREE.Mesh(new THREE.BoxGeometry(r * 0.22, r * 0.45, 0.3), glow);
        const a = k * 1.7 + 0.4;
        w.position.set(x + Math.sin(a) * r * 1.01, h * (0.45 + 0.12 * k), z + Math.cos(a) * r * 1.01);
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
    castle.position.set(CASTLE.x, h0 - 2, -CASTLE.d);
    castle.rotation.y = -0.3;
    this.add(castle, 1);
  }

  /** Premier plan : herbe haute qui ondule au vent, translucide face au soleil, quelques fleurs. */
  private buildMeadow(): void {
    const shade = this.sunlight(0, 1.5, 0.3);
    const blade = new THREE.BufferGeometry();
    blade.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-0.008, 0, 0, 0.008, 0, 0, 0.003, 0.24, 0, -0.003, 0.24, 0, 0, 0.3, 0]), 3));
    blade.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(15).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
    blade.setIndex([0, 1, 2, 0, 2, 3, 3, 2, 4]);
    const N = 34000;
    const grass = new THREE.InstancedMesh(
      blade,
      new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uShade: { value: shade } },
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          uniform float uTime;
          varying float vH;
          varying float vDry;
          varying float vSheen;
          void main() {
            mat4 m = modelOf();
            vec4 base = m * vec4(0.0, 0.0, 0.0, 1.0);
            float h = position.y / 0.3;
            vH = h;
            vDry = step(0.82, fract(sin(dot(base.xz, vec2(12.9898, 78.233))) * 43758.5453));
            // Vent : des vagues qui courent sur la prairie, portées par de grandes rafales lentes,
            // et un frémissement rapide de chaque brin.
            vec2 wd = normalize(vec2(1.0, -0.35));
            float along = dot(base.xz, wd);
            float wave = 0.5 + 0.5 * sin(along * 1.1 - uTime * 2.8 + sin(base.z * 0.7) * 0.6);
            float gust = smoothstep(0.25, 0.95, 0.5 + 0.5 * sin(along * 0.21 - uTime * 0.85 + sin(base.z * 0.3 + uTime * 0.2) * 1.2));
            float g = wave * (0.3 + 0.7 * gust);
            float flutter = sin(uTime * 13.0 + base.x * 17.0 + base.z * 11.0) * 0.012;
            float bend = (0.025 + 0.16 * g) * h * h;
            vSheen = g * gust * h;
            vec4 w = m * vec4(position, 1.0);
            w.xz += wd * (bend + flutter * h);
            w.y -= bend * 0.45 * h;
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 1.0, 0.0);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform float uShade;
          varying vec3 vLocal;
          varying float vH;
          varying float vDry;
          varying float vSheen;
          void main() {
            vec3 tip = mix(vec3(0.06, 0.11, 0.025), vec3(0.20, 0.16, 0.06), vDry);
            vec3 albedo = mix(vec3(0.015, 0.035, 0.008), tip, vH);
            vec3 v = normalize(vLocal - uCam);
            float trans = pow(max(dot(v, uSun), 0.0), 3.0) * vH;
            vec3 c = albedo * (SUNC * uShade * (0.2 + 0.5 * vH) + ambient(vec3(0.0, 1.0, 0.0)) * (0.35 + 0.65 * vH));
            c += SUNC * vec3(0.12, 0.18, 0.03) * trans * uShade * 0.4;
            // Brins couchés par la rafale : leur revers clair accroche la lumière.
            c += (SUNC * uShade * 0.5 + vec3(0.3, 0.35, 0.3)) * vec3(0.07, 0.08, 0.045) * vSheen;
            gl_FragColor = vec4(finish(c), 1.0);
          }`,
        side: THREE.DoubleSide,
      }),
      N,
    );
    for (let i = 0; i < N; i++) {
      const x = (this.rnd() - 0.5) * 14;
      const d = 0.15 + this.rnd() * (edgeD(x) - 0.25);
      const sc = 0.6 + this.rnd() * 0.7;
      grass.setMatrixAt(
        i,
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, height(x, d), -d),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((this.rnd() - 0.5) * 0.3, this.rnd() * 6.28, (this.rnd() - 0.5) * 0.3)),
          new THREE.Vector3(sc, sc * (0.6 + this.rnd() * 0.9), sc),
        ),
      );
    }
    grass.frustumCulled = false;
    this.add(grass, 2);
    const petals = [new THREE.Color(0.9, 0.9, 0.85), new THREE.Color(0.9, 0.7, 0.1), new THREE.Color(0.45, 0.25, 0.7), new THREE.Color(0.85, 0.35, 0.45)];
    const F = 1100;
    const flowerGeo = new THREE.IcosahedronGeometry(0.014, 0);
    const flowers = new THREE.InstancedMesh(flowerGeo, this.lit({}), F);
    const tint = new Float32Array(F * 3);
    for (let i = 0; i < F; i++) {
      const x = (this.rnd() - 0.5) * 14;
      const d = 0.2 + this.rnd() * (edgeD(x) - 0.4);
      flowers.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, height(x, d) + 0.08 + this.rnd() * 0.16, -d));
      const c = petals[Math.floor(this.rnd() * petals.length)];
      tint.set([c.r, c.g, c.b], i * 3);
    }
    flowerGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    flowerGeo.setAttribute("aShade", new THREE.InstancedBufferAttribute(new Float32Array(F).fill(shade), 1));
    flowers.frustumCulled = false;
    this.add(flowers, 2);
  }

  /** Les petites fées : celles du monde du mode fée, en couleurs, sans silhouette qui les cache
   *  mais derrière l'herbe et les collines (test de profondeur). */
  private buildFairies(): void {
    FAIRY_TINTS.forEach((hex, i) => {
      const fairy = new Fairy(this.world.shared, new THREE.Color(hex));
      fairy.occlusion.value = 0;
      for (const o of fairy.objects) {
        this.add(o, 20);
        o.traverse((c) => {
          if (c instanceof THREE.Mesh || c instanceof THREE.Points) (c.material as THREE.Material).depthTest = true;
        });
      }
      this.fairies.push({ fairy, seed: i * 2.17 + 0.6, near: i < NEAR_FAIRIES, prev: null });
    });
  }

  /** Trajet d'une fée (repère du paysage) : boucles douces et irrégulières (sommes de sinus). */
  private fairyPath(seed: number, near: boolean, t: number): THREE.Vector3 {
    const s = seed;
    if (near) {
      // Au-dessus de la prairie, entre l'arche et le bord de la falaise ; elle frôle l'herbe.
      const x = 2.4 * Math.sin(t * 0.13 + s) + 0.8 * Math.sin(t * 0.41 + s * 2.3);
      const d = 1.6 + 0.9 * Math.sin(t * 0.17 + s * 1.7) + 0.35 * Math.sin(t * 0.53 + s);
      const y = 0.45 + 0.3 * Math.sin(t * 0.29 + s * 3.1) + 0.12 * Math.sin(t * 0.9 + s);
      return new THREE.Vector3(x, y, -d);
    }
    // Au-dessus du vide : de grandes boucles au-delà de la falaise.
    const x = 10 * Math.sin(t * 0.05 + s) + 3 * Math.sin(t * 0.19 + s * 1.9);
    const d = 13 + 8 * Math.sin(t * 0.07 + s * 1.3) + 2 * Math.sin(t * 0.23 + s);
    const y = 0.5 + 2 * Math.sin(t * 0.11 + s) + 0.6 * Math.sin(t * 0.37 + s * 2.6);
    return new THREE.Vector3(x, y, -d);
  }

  private flyFairies(t: number, dt: number, open: number): void {
    for (const f of this.fairies) {
      const p = this.fairyPath(f.seed, f.near, t);
      const v = f.prev && dt > 0 ? p.clone().sub(f.prev).divideScalar(dt) : new THREE.Vector3();
      f.prev = p;
      f.fairy.fade.value = open;
      f.fairy.update(p, v, t, dt, f.near ? 0.4 : 0.9);
    }
  }

  /** Fumées douces (cheminées, brume de la cascade) : des particules qui montent, s'étalent et
   *  s'effacent, éclairées par le soleil. */
  private puffs(sources: THREE.Vector3[], perSource: number, opts: { size: number; grow: number; rise: number; drift: number; speed: number; color: THREE.Color; alpha: number }): THREE.Points {
    const n = sources.length * perSource;
    const pos = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    sources.forEach((src, i) => {
      for (let k = 0; k < perSource; k++) {
        pos.set([src.x, src.y, src.z], (i * perSource + k) * 3);
        seed[i * perSource + k] = k / perSource + this.rnd() * 0.05;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    const f = (v: number) => v.toFixed(3);
    const pts = new THREE.Points(
      geo,
      new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uRes: this.world.shared.uRes, uColor: { value: opts.color } },
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          uniform float uTime;
          uniform vec2 uRes;
          attribute float aSeed;
          varying float vA;
          void main() {
            float age = fract(uTime * ${f(opts.speed)} + aSeed);
            float h = fract(sin(aSeed * 91.7 + position.x) * 4375.85);
            vec3 p = position + vec3(age * ${f(opts.drift)} + sin(age * 6.0 + h * 6.28) * ${f(opts.size * 0.6)}, pow(age, 0.7) * ${f(opts.rise)}, (h - 0.5) * ${f(opts.size)} - age * ${f(opts.drift * 0.3)});
            vA = smoothstep(0.0, 0.12, age) * (1.0 - age) * ${f(opts.alpha)};
            vec4 w = modelMatrix * vec4(p, 1.0);
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 1.0, 0.0);
            vec4 view = viewMatrix * w;
            gl_Position = projectionMatrix * view;
            gl_PointSize = (${f(opts.size)} + age * ${f(opts.grow)}) * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
          }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          uniform vec3 uColor;
          varying vec3 vLocal;
          varying float vA;
          void main() {
            vec2 q = gl_PointCoord * 2.0 - 1.0;
            float a = exp(-dot(q, q) * 2.5) * vA;
            if (a < 0.003) discard;
            vec3 c = uColor * (SUNC * 0.35 + ambient(vec3(0.0, 1.0, 0.0)));
            gl_FragColor = vec4(finish(aerial(c, vLocal)), a);
          }`,
        transparent: true,
        depthWrite: false,
      }),
    );
    pts.frustumCulled = false;
    return pts;
  }

  /** La cascade : une nappe d'eau qui file le long de la falaise, de la brume à son pied. */
  private buildFalls(): void {
    const top = height(FALLS.x, FALLS.d + 6);
    const bottom = WATER;
    const run = 34;
    const len = Math.hypot(top - bottom, run);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(20, len, 1, 1),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          varying vec2 vUv;
          void main() {
            vUv = uv;
            vec4 w = modelMatrix * vec4(position, 1.0);
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 0.0, 1.0);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec3 vLocal;
          varying vec2 vUv;
          void main() {
            float x = abs(vUv.x * 2.0 - 1.0);
            float lane = hash12(vec2(floor(vUv.x * 26.0), 3.0));
            float flow = vnoise(vec2(vUv.x * 26.0, vUv.y * 9.0 + uTime * (2.2 + lane)));
            float streak = smoothstep(0.35, 0.9, flow);
            float edge = 1.0 - smoothstep(0.55, 1.0, x + 0.25 * vnoise(vec2(vUv.y * 12.0 - uTime * 3.0, 1.0)));
            vec3 water = mix(vec3(0.35, 0.45, 0.5), vec3(1.0, 0.98, 0.95), streak);
            vec3 c = water * (SUNC * 0.38 + ambient(vec3(0.0, 0.5, 0.8)) * 1.2);
            float a = edge * (0.55 + 0.45 * streak) * smoothstep(0.0, 0.03, vUv.y);
            gl_FragColor = vec4(finish(aerial(c, vLocal)), a);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    sheet.position.set(FALLS.x, (top + bottom) / 2, -(FALLS.d - 6 - run / 2 - 4));
    sheet.rotation.x = -Math.atan2(run, top - bottom);
    this.add(sheet, 3);
    const foot = new THREE.Vector3(FALLS.x, WATER, -(FALLS.d - run - 12));
    const mist = this.puffs([foot, foot.clone().add(new THREE.Vector3(-8, 0, 4)), foot.clone().add(new THREE.Vector3(8, 0, 3))], 40, {
      size: 10, grow: 30, rise: 60, drift: 12, speed: 0.06, color: new THREE.Color(0.85, 0.88, 0.92), alpha: 0.32,
    });
    this.add(mist, 4);
  }

  /** Le village au bord de la rivière : maisons blanches, toits sombres, fenêtres allumées, fumées. */
  private buildVillage(): void {
    const homes: { x: number; d: number; h: number; rot: number; sc: number }[] = [];
    for (let k = 0; k < 3000 && homes.length < 24; k++) {
      const a = this.rnd() * 6.28;
      const r = Math.sqrt(this.rnd()) * VILLAGE.r;
      const x = VILLAGE.x + Math.cos(a) * r * 1.4;
      const d = VILLAGE.d + Math.sin(a) * r;
      const h = this.heightAt(x, d);
      if (h < WATER + 1.5 || this.slopeAt(x, d) > 0.08) continue;
      if (homes.some((o) => Math.hypot(o.x - x, o.d - d) < 13)) continue;
      homes.push({ x, d, h, rot: this.rnd() * 0.6 - 0.3 + (this.rnd() < 0.5 ? 0 : Math.PI / 2), sc: 0.8 + this.rnd() * 0.5 });
    }
    const wallGeo = new THREE.BoxGeometry(6, 5, 9).translate(0, 2.5, 0);
    const roofGeo = new THREE.CylinderGeometry(0, 5.6, 4, 4, 1).rotateY(Math.PI / 4).scale(1, 1, 1.5).translate(0, 7, 0);
    const winGeo = new THREE.BoxGeometry(6.1, 0.9, 1).translate(0, 2.8, 0);
    const walls = new THREE.InstancedMesh(wallGeo, this.lit({}), homes.length);
    const roofs = new THREE.InstancedMesh(roofGeo, this.lit({}), homes.length);
    const wins = new THREE.InstancedMesh(winGeo, this.lit({ color: new THREE.Color(0, 0, 0), emissive: new THREE.Color(1.5, 0.85, 0.35) }), homes.length * 2);
    const tw = new Float32Array(homes.length * 3);
    const tr = new Float32Array(homes.length * 3);
    const sh = new Float32Array(homes.length);
    const chimneys: THREE.Vector3[] = [];
    homes.forEach((o, i) => {
      const m = new THREE.Matrix4().compose(new THREE.Vector3(o.x, o.h - 0.3, -o.d), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.rot), new THREE.Vector3(o.sc, o.sc, o.sc));
      walls.setMatrixAt(i, m);
      roofs.setMatrixAt(i, m);
      wins.setMatrixAt(i * 2, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, -2.2)));
      wins.setMatrixAt(i * 2 + 1, m.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0, 2.2)));
      const w = 0.5 + this.rnd() * 0.12;
      tw.set([w, w * 0.93, w * 0.82], i * 3);
      tr.set([0.18 + this.rnd() * 0.08, 0.06, 0.04], i * 3);
      sh[i] = this.sunlight(o.x, o.d, o.h + 4);
      if (i % 3 === 0) chimneys.push(new THREE.Vector3(o.x + 1.5, o.h + 8 * o.sc, -o.d));
    });
    wallGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tw, 3));
    wallGeo.setAttribute("aShade", new THREE.InstancedBufferAttribute(sh, 1));
    roofGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tr, 3));
    roofGeo.setAttribute("aShade", new THREE.InstancedBufferAttribute(sh, 1));
    for (const mesh of [walls, roofs, wins]) {
      mesh.frustumCulled = false;
      this.add(mesh, 1);
    }
    this.add(this.puffs(chimneys, 16, { size: 2.5, grow: 14, rise: 45, drift: 22, speed: 0.05, color: new THREE.Color(0.55, 0.53, 0.52), alpha: 0.45 }), 4);
  }

  /** Voiliers qui croisent lentement sur le lac. */
  private buildBoats(): void {
    const hull = this.lit({ color: new THREE.Color(0.16, 0.09, 0.05) });
    const sailMat = this.lit({ color: new THREE.Color(0.85, 0.82, 0.74) });
    sailMat.side = THREE.DoubleSide;
    const sailShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0, 9), new THREE.Vector2(4.2, 0.6)]);
    for (let i = 0; i < 3; i++) {
      const boat = new THREE.Group();
      boat.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.1, 7).translate(0, 0.3, 0), hull));
      boat.add(new THREE.Mesh(new THREE.ShapeGeometry(sailShape).rotateY(Math.PI / 2).translate(0, 1.2, 1.2), sailMat));
      this.boats.push(boat);
      this.add(boat, 1);
    }
  }

  /** Trajet du dragon-serpent (repère du paysage) : de grandes boucles lentes, entre la cascade et
   *  les montagnes, qui ondulent. */
  private dragonPath(t: number): THREE.Vector3 {
    const u = t * 0.055;
    return new THREE.Vector3(
      20 + 300 * Math.sin(u * 0.9) + 80 * Math.sin(u * 2.3 + 1),
      115 + 40 * Math.sin(u * 1.3) + 15 * Math.sin(u * 3.1),
      -(820 + 220 * Math.sin(u * 0.6 + 1) + 50 * Math.sin(u * 1.9)),
    );
  }

  /** Un long dragon-serpent doré à l'orientale : un corps d'anneaux qui suit la tête et ondule,
   *  une crinière électrique qui scintille, une tête à cornes et moustaches. */
  private buildDragon(): void {
    const ringGeo = new THREE.IcosahedronGeometry(1, 2);
    const rings = new THREE.InstancedMesh(ringGeo, this.lit({}), DRAGON_RINGS);
    const tint = new Float32Array(DRAGON_RINGS * 3);
    for (let i = 0; i < DRAGON_RINGS; i++) {
      // Écailles dorées, plus sombres et vertes vers la queue.
      const k = i / DRAGON_RINGS;
      tint.set([0.36 - 0.1 * k, 0.2 - 0.02 * k, 0.025 + 0.03 * k], i * 3);
    }
    ringGeo.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    ringGeo.setAttribute("aShade", new THREE.InstancedBufferAttribute(new Float32Array(DRAGON_RINGS).fill(1), 1));
    rings.frustumCulled = false;
    this.add(rings, 1);

    const N = DRAGON_RINGS * 3;
    const mg = new THREE.BufferGeometry();
    mg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    mg.setAttribute("aSeed", new THREE.BufferAttribute(new Float32Array(N).map(() => this.rnd()), 1));
    const mane = new THREE.Points(
      mg,
      new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uRes: this.world.shared.uRes },
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          uniform float uTime;
          uniform vec2 uRes;
          attribute float aSeed;
          varying float vA;
          void main() {
            vec4 w = modelMatrix * vec4(position, 1.0);
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 1.0, 0.0);
            vA = 0.45 + 0.55 * pow(0.5 + 0.5 * sin(uTime * (5.0 + 9.0 * aSeed) + aSeed * 40.0), 3.0);
            vec4 view = viewMatrix * w;
            gl_Position = projectionMatrix * view;
            gl_PointSize = (7.0 + 6.0 * aSeed) * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 q = gl_PointCoord * 2.0 - 1.0;
            float a = exp(-dot(q, q) * 3.0) * vA;
            gl_FragColor = vec4(mix(vec3(0.4, 0.95, 1.0), vec3(1.0), exp(-dot(q, q) * 12.0)) * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mane.frustumCulled = false;
    this.add(mane, 5);

    // Tête : museau, deux cornes recourbées, deux longues moustaches, des yeux qui brillent.
    const skin = this.lit({ color: new THREE.Color(0.36, 0.2, 0.025) });
    const horn = this.lit({ color: new THREE.Color(0.75, 0.7, 0.55) });
    const glow = this.lit({ color: new THREE.Color(0, 0, 0), emissive: new THREE.Color(0.8, 2.2, 2.6) });
    const head = new THREE.Group();
    head.add(new THREE.Mesh(new THREE.SphereGeometry(DRAGON_R * 1.25, 16, 12).scale(1, 0.85, 1.2), skin));
    head.add(new THREE.Mesh(new THREE.CylinderGeometry(DRAGON_R * 0.55, DRAGON_R * 0.95, DRAGON_R * 2.6, 12).rotateX(Math.PI / 2).translate(0, -DRAGON_R * 0.25, DRAGON_R * 2.2), skin));
    for (const side of [-1, 1]) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(DRAGON_R * 0.28, DRAGON_R * 3.2, 8), horn);
      h.position.set(side * DRAGON_R * 0.6, DRAGON_R * 1.6, -DRAGON_R * 1.2);
      h.rotation.set(-0.9, 0, side * 0.35);
      const whisker = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.6, DRAGON_R * 5, 6), glow);
      whisker.position.set(side * DRAGON_R * 1.6, -DRAGON_R * 0.6, DRAGON_R * 2);
      whisker.rotation.set(0.5, 0, side * 1.1);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(DRAGON_R * 0.18, 8, 6), glow);
      eye.position.set(side * DRAGON_R * 0.75, DRAGON_R * 0.35, DRAGON_R * 1.1);
      head.add(h, whisker, eye);
    }
    this.add(head, 1);
    this.dragon = { rings, mane, head };
  }

  /** Une volée de grands oiseaux qui traverse la vallée. */
  private buildBirds(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0.5, -1.1, 0.1, -0.3, 0, 0, -0.6, 1.1, 0.1, -0.3]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(12).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    const N = 26;
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          ${VERT_LOCAL}
          uniform float uTime;
          void main() {
            mat4 m = modelOf();
            vec3 p = position;
            float ph = m[3][0] * 0.37 + m[3][2] * 0.11;
            p.y += sin(uTime * 7.0 + ph) * 0.7 * abs(p.x);
            vec4 w = m * vec4(p, 1.0);
            vLocal = (uLandInv * w).xyz;
            vN = vec3(0.0, 1.0, 0.0);
            gl_Position = projectionMatrix * viewMatrix * w;
          }`,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec3 vLocal;
          void main() {
            vec3 c = vec3(0.03, 0.025, 0.02) * (SUNC * 0.3 + ambient(vec3(0.0, 1.0, 0.0)));
            gl_FragColor = vec4(finish(aerial(c, vLocal)), 1.0);
          }`,
        side: THREE.DoubleSide,
      }),
      N,
    );
    mesh.frustumCulled = false;
    const offsets = Array.from({ length: N }, () => new THREE.Vector3((this.rnd() - 0.5) * 50, (this.rnd() - 0.5) * 10, (this.rnd() - 0.5) * 40));
    this.birds = { mesh, offsets };
    this.add(mesh, 1);
  }

  /** Ce qui bouge dans le monde : voiliers, dragon-serpent, oiseaux. */
  private animateLife(t: number): void {
    const up = new THREE.Vector3(0, 1, 0);
    this.boats.forEach((boat, i) => {
      const a = t * 0.012 + i * 2.1;
      const x = LAKE.x + Math.cos(a) * (55 - i * 12);
      const d = LAKE.d + Math.sin(a) * (50 - i * 10);
      boat.position.set(x, WATER + Math.sin(t * 1.3 + i) * 0.15, -d);
      boat.rotation.set(Math.sin(t * 0.9 + i) * 0.04, Math.atan2(-Math.sin(a), -Math.cos(a)) + Math.PI / 2, Math.sin(t * 1.1 + i * 2) * 0.05);
    });
    if (this.dragon) {
      const { rings, mane, head } = this.dragon;
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const mp = mane.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < DRAGON_RINGS; i++) {
        const tt = t - i * DRAGON_LAG;
        const p = this.dragonPath(tt);
        // Ondulation qui court le long du corps.
        p.y += Math.sin(i * 0.2 - t * 2.0) * 7;
        p.x += Math.sin(i * 0.13 - t * 1.5) * 5;
        const k = i / DRAGON_RINGS;
        const r = DRAGON_R * (k < 0.08 ? 0.85 + k * 2 : 1 - 0.85 * ((k - 0.08) / 0.92) ** 1.4);
        m.compose(p, q, new THREE.Vector3(r, r, r));
        rings.setMatrixAt(i, m);
        // Crinière : flammèches au-dessus du dos, plus fournies vers la tête.
        for (let j = 0; j < 3; j++) {
          const lift = r * (1 + 0.45 * j) + Math.sin(t * 6 + i + j * 2) * 1.2;
          mp.setXYZ(i * 3 + j, p.x + Math.sin(i * 1.7 + j) * r * 0.4, p.y + lift, p.z + Math.cos(i * 1.3 + j) * r * 0.4);
        }
      }
      rings.instanceMatrix.needsUpdate = true;
      mp.needsUpdate = true;
      const hp = this.dragonPath(t + DRAGON_LAG * 1.5);
      hp.y += Math.sin(-t * 2.0 - 0.3) * 7;
      head.position.copy(hp);
      head.up.copy(up);
      head.lookAt(this.dragonPath(t + DRAGON_LAG * 4));
    }
    if (this.birds) {
      const { mesh, offsets } = this.birds;
      const cx = -450 + ((t * 14) % 900);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion().setFromAxisAngle(up, Math.PI / 2);
      offsets.forEach((o, i) => {
        const x = cx + o.x + Math.sin(t * 0.5 + i) * 3;
        const d = 190 + o.z + Math.sin(t * 0.07) * 30;
        const y = 14 + o.y + Math.sin(t * 0.3 + i * 0.7) * 2;
        m.compose(new THREE.Vector3(x, y, -d), q, new THREE.Vector3(1.4, 1.4, 1.4));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Poussière et pollen dorés qui flottent dans la lumière, près de l'arche. */
  private buildMotes(): void {
    const N = 160;
    const mp = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) mp.set([(this.rnd() - 0.5) * 9, 0.2 + this.rnd() * 2.2, -0.4 - this.rnd() * 5], i * 3);
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
          void main() {
            vec3 p = position;
            float s = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
            p.y += sin(uTime * (0.2 + 0.2 * s) + s * 6.28) * 0.3;
            p.x = mod(p.x + uTime * 0.35 + 4.5, 9.0) - 4.5 + sin(uTime * 0.3 + s * 6.28) * 0.4;
            p.z += cos(uTime * 0.27 + s * 4.0) * 0.25;
            vA = 0.3 + 0.7 * pow(0.5 + 0.5 * sin(uTime * (0.8 + 1.5 * s) + s * 10.0), 2.0);
            vec4 view = modelViewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * view;
            gl_PointSize = (0.01 + 0.012 * s) * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() {
            vec2 p = gl_PointCoord * 2.0 - 1.0;
            float a = exp(-dot(p, p) * 3.0) * vA * 0.7;
            gl_FragColor = vec4(vec3(1.0, 0.85, 0.55) * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    motes.frustumCulled = false;
    this.add(motes, 10);
  }
}

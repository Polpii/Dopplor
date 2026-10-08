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
import type { EyeSample } from "../../vision/source";

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
/** Mesure de l'œil trop vieille : plus personne. Anticipation du mouvement de la tête (s) : compense
 *  le délai caméra → calcul → image. */
const EYE_STALE_MS = 700;
/** Réglages du suivi, ajustables par l'adresse (?EYE_ALPHA=0.6…) pour les essais sur une session
 *  rejouée. */
const tune = (name: string, fallback: number) => {
  const v = Number(new URLSearchParams(location.search).get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
/** Filtre de l'œil (alpha-bêta) : part de l'écart corrigée à chaque mesure, sur la position et la
 *  vitesse. Délai écran (rendu + affichage, s) ajouté à l'âge de la mesure pour viser l'instant où
 *  l'image sera vue ; anticipation plafonnée. */
const EYE_ALPHA = tune("EYE_ALPHA", 0.6);
const EYE_BETA = tune("EYE_BETA", 0.18);
const DISPLAY_S = tune("DISPLAY_S", 0.025);
/** Anticipation : elle sature en douceur vers cette durée (s) quand les mesures tardent (pas
 *  d'arrêt net puis de saut). Corrections de l'estimation étalées sur ~ce temps (s) au lieu
 *  d'un saut d'image. Écart (m) au-delà duquel une mesure est suspecte (un raté de squelette) :
 *  elle compte peu, sauf si elle se confirme plusieurs fois de suite (vrai mouvement). */
const LEAD_CAP_S = tune("LEAD_CAP_S", 0.15);
const CORRECT_S = tune("CORRECT_S", 0.04);
const SUSPECT_M = tune("SUSPECT_M", 0.18);
const CONFIRM = tune("CONFIRM", 3);
/** Vallée en contrebas du bord de la prairie (m), niveau de l'eau. */
const VALLEY = -60;
const WATER = VALLEY - 3.5;
/** Soleil bas, sur la droite et un peu derrière nous (lumière rasante sur les faces tournées vers
 *  nous) (repère du paysage : x à droite, y en haut, -z au loin). */
const SUN = new THREE.Vector3(0.8, 0.3, 0.3).normalize();
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

const CASTLE = { x: 55, d: 760 };
const LAKE = { x: -55, d: 500, r: 130 };
/** Rivière : serpente dans la vallée, passe par le lac. */
const riverX = (d: number) => 35 * Math.sin(d * 0.005) + 15 * Math.sin(d * 0.013 + 1.3) - 55;
/** Grand pic enneigé au fond ; cascade (sur la rivière) qui tombe d'un plateau derrière le lac ;
 *  village au bord de la rivière. */
const PEAK = { x: 220, d: 2700, r: 300 };
const FALLS = { x: riverX(640), d: 640, h: 120 };
/** Seconde cascade, à droite (on la découvre en se penchant). */
const FALLS2_X = 165;
const FALLS_X = FALLS.x.toFixed(1);
/** Bord du plateau (distance, m) : irrégulier, sauf là où tombe la grande cascade. */
const plateauEdge = (x: number) => FALLS.d + 45 * noise(x * 0.012, 7.7) * smoothstep(25, 70, Math.abs(x - FALLS.x));
const VILLAGE = { x: 45, d: 330, r: 55 };
/** Lune : direction (un peu à gauche, basse sur l'horizon). */
const MOON = new THREE.Vector3(-0.17, 0.2, -0.97).normalize();
/** Dragon-serpent : nombre d'anneaux, écart entre anneaux (s de trajet), rayon (m). */
const DRAGON_RINGS = 140;
const DRAGON_SEG = 14;
const DRAGON_LAG = 0.1;
const DRAGON_R = 8;
/** Bord de la falaise (distance à l'arche, m), irrégulier. */
const edgeD = (x: number) => 2.6 + 0.6 * noise(x * 0.35, 4.2) + 0.3 * noise(x * 1.3, 9.1);

function height(x: number, d: number): number {
  const cx = riverX(d);
  let h = VALLEY + fbm(x * 0.0025, d * 0.0025, 5) * 22 + fbm(x * 0.011, d * 0.011, 3) * 5;
  // Flancs de la vallée.
  h += smoothstep(120, 650, Math.abs(x - cx)) * smoothstep(80, 400, d) * (50 + 90 * (fbm(x * 0.004 + 5, d * 0.004, 4) + 0.5));
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
  const fd = plateauEdge(x);
  const plateau = smoothstep(fd - 25, fd + 8, d) * smoothstep(-320, -240, x) * (1 - smoothstep(190, 260, x));
  if (plateau > 0) {
    const notch = (1 - smoothstep(18, 34, Math.abs(x - FALLS.x))) * 6 + (1 - smoothstep(8, 16, Math.abs(x - FALLS2_X))) * 4;
    const top = VALLEY + FALLS.h + fbm(x * 0.01, d * 0.01, 3) * 10 - notch;
    h = Math.max(h, THREE.MathUtils.lerp(h, top, plateau));
  }
  // Vasque au pied de la seconde cascade (la grande tombe dans le lac).
  const pool = Math.hypot(x - FALLS2_X, d - (plateauEdge(FALLS2_X) - 48));
  h = Math.min(h, THREE.MathUtils.lerp(WATER - 3, h, smoothstep(22, 36, pool)));
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
  private dragon: {
    body: THREE.BufferGeometry;
    mane: THREE.Points;
    head: THREE.Group;
    jaw: THREE.Object3D;
    legs: { group: THREE.Group; ring: number; side: number }[];
    tuft: THREE.Vector3[];
    crown: THREE.Vector3[];
  } | null = null;
  private flags: THREE.Object3D[] = [];
  // Point de vue rendu : lissé, anticipé.
  private view = new THREE.Vector3();
  private viewInit = false;
  // Filtre de l'œil : position et vitesse (repère Three), heure de capture de la dernière mesure.
  private eyeX = new THREE.Vector3();
  private eyeV = new THREE.Vector3();
  private eyeWall = 0;
  private eyeOk = false;
  private eyeCorr = new THREE.Vector3();
  private eyeOdd = 0;
  private birds: { mesh: THREE.InstancedMesh; offsets: THREE.Vector3[] } | null = null;

  constructor(
    private world: MirrorWorld,
    private present: () => boolean = () => false,
    private sample: () => EyeSample | null = () => null,
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
    this.viewInit = false;
    this.eyeOk = false;
    this.eyeCorr.set(0, 0, 0);
    this.world.viewEye = () => (this.viewInit ? this.view : this.neutralEye());
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

  /** Estimation de l'œil à l'instant où l'image sera vue (position + vitesse × âge de la mesure ;
   *  l'anticipation sature en douceur si les mesures tardent). */
  private predictEye(): THREE.Vector3 | null {
    if (!this.eyeOk) return null;
    const age = Math.max(0, (Date.now() - this.eyeWall) / 1000 + DISPLAY_S);
    if (age > EYE_STALE_MS / 1000) return this.eyeX.clone();
    return this.eyeX.clone().addScaledVector(this.eyeV, LEAD_CAP_S * (1 - Math.exp(-age / LEAD_CAP_S)));
  }

  /** Nouvelle mesure brute de l'œil ? On recale position et vitesse (filtre alpha-bêta, daté à la
   *  capture : les mesures irrégulières ou en retard sont prises à leur vrai instant). Le recalage
   *  ne fait pas sauter la vue : l'écart est rendu peu à peu (eyeCorr). */
  private feedEye(): void {
    const s = this.sample();
    if (!s || s.wall === this.eyeWall) return;
    const z = new THREE.Vector3(s.eye[0], -s.eye[1], -s.eye[2]);
    const dt = (s.wall - this.eyeWall) / 1000;
    const before = this.predictEye();
    if (!this.eyeOk || dt <= 0 || dt > 0.3 || z.distanceTo(this.eyeX) > 0.6) {
      this.eyeX.copy(z);
      this.eyeV.set(0, 0, 0);
      this.eyeOk = true;
      this.eyeOdd = 0;
    } else {
      const pred = this.eyeX.clone().addScaledVector(this.eyeV, dt);
      const r = z.sub(pred);
      this.eyeOdd = r.length() > SUSPECT_M ? this.eyeOdd + 1 : 0;
      const doubt = this.eyeOdd > 0 && this.eyeOdd < CONFIRM;
      this.eyeX.copy(pred).addScaledVector(r, doubt ? 0.15 : EYE_ALPHA);
      this.eyeV.addScaledVector(r, (doubt ? 0.02 : EYE_BETA) / dt);
      if (this.eyeV.length() > 2.5) this.eyeV.setLength(2.5);
    }
    this.eyeWall = s.wall;
    const after = this.predictEye();
    if (before && after && before.distanceTo(after) < 0.6) this.eyeCorr.add(before.sub(after));
    else this.eyeCorr.set(0, 0, 0);
  }

  /** L'œil pour cette image : l'estimation, plus ce qui reste à rendre des derniers recalages. */
  private eyeNow(dt: number): THREE.Vector3 | null {
    this.eyeCorr.multiplyScalar(Math.exp(-dt / CORRECT_S));
    const e = this.predictEye();
    return e ? e.add(this.eyeCorr) : null;
  }

  /**
   * Suivi du regard : attend qu'une personne soit stable devant l'arche, puis la suit ; revient au
   * centre quand il n'y a plus personne (plus de mesure de l'œil). La tête est suivie sans retard
   * (filtre daté à la capture, anticipé jusqu'à l'affichage) ; seuls les grands sauts (quelqu'un
   * qui apparaît d'un coup) sont adoucis.
   */
  private updateFollow(now: number, dt: number): void {
    this.feedEye();
    const fresh = this.eyeOk && Date.now() - this.eyeWall < EYE_STALE_MS;
    const eye = this.eyeNow(dt);
    if (fresh && eye && this.present()) {
      this.seenAt = now;
      if (eye.distanceTo(this.anchor) > STABLE_RADIUS) {
        this.anchor.copy(eye);
        this.anchorSince = now;
      }
      if (now - this.anchorSince > STABLE_MS) this.locked = true;
    }
    if (now - this.seenAt > LOST_MS) this.locked = false;
    this.follow += ((this.locked ? 1 : 0) - this.follow) * (1 - Math.exp(-dt / 0.8));
    const k = this.follow * this.follow * (3 - 2 * this.follow);
    const target = this.neutralEye();
    if (eye) target.lerp(eye, k);
    if (!this.viewInit) {
      this.view.copy(target);
      this.viewInit = true;
    }
    const gap = this.view.distanceTo(target);
    const tau = 0.3 * smoothstep(0.12, 0.45, gap);
    if (tau < 0.004) this.view.copy(target);
    else this.view.add(target.sub(this.view).multiplyScalar(1 - Math.exp(-dt / tau)));
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
    this.world.refreshCamera();
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
          // Parois raides : fissures verticales, strates, mousse dans les replats, roche mouillée
          // (plus sombre) de part et d'autre des cascades.
          float steep = smoothstep(0.5, 0.8, slope);
          float cracks = smoothstep(0.55, 0.85, vnoise(vec2(p.x * 0.09, h * 0.012)) * 0.7 + vnoise(vec2(p.x * 0.35, h * 0.04)) * 0.3);
          float strata = 0.5 + 0.5 * sin(h * 0.55 + vnoise(vec2(p.x * 0.02, h * 0.05)) * 6.0);
          rock *= mix(1.0, (0.78 + 0.3 * strata) * (1.0 - 0.45 * cracks), steep);
          rock = mix(rock, vec3(0.42, 0.36, 0.27), steep * smoothstep(0.6, 0.9, vnoise(vec2(p.x * 0.03, h * 0.02))) * 0.5);
          float moss = steep * smoothstep(0.55, 0.8, vnoise(vec2(p.x * 0.05, h * 0.09) + 4.0)) * (1.0 - smoothstep(${(VALLEY + 110).toFixed(1)}, ${(VALLEY + 130).toFixed(1)}, h));
          rock = mix(rock, vec3(0.1, 0.16, 0.05), moss * 0.7);
          float wet = steep * (exp(-pow((p.x - (${FALLS_X})) / 45.0, 2.0)) + exp(-pow((p.x - (${FALLS2_X.toFixed(1)})) / 22.0, 2.0)));
          rock *= 1.0 - 0.45 * clamp(wet, 0.0, 1.0);
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

  /** Le château, façon royaume de légende, au bord du plateau : remparts crénelés, tours rondes
   *  aux toits bleu-vert, donjon à étages, grande tour et sa flèche, drapeaux, fenêtres allumées. */
  private buildCastle(): void {
    const h0 = this.heightAt(CASTLE.x, CASTLE.d);
    const shade = Math.max(0.4, this.sunlight(CASTLE.x, CASTLE.d, h0 + 30));
    const castle = new THREE.Group();
    const stone = this.lit({ color: new THREE.Color(0.62, 0.57, 0.48), shade });
    const trim = this.lit({ color: new THREE.Color(0.38, 0.34, 0.29), shade });
    const roof = this.lit({ color: new THREE.Color(0.04, 0.18, 0.3), shade });
    const dark = this.lit({ color: new THREE.Color(0.04, 0.035, 0.03), shade });
    const glow = this.lit({ color: new THREE.Color(0, 0, 0), emissive: new THREE.Color(1.6, 0.95, 0.4), shade });
    const cloth = this.lit({ color: new THREE.Color(0.5, 0.05, 0.04), shade });
    cloth.side = THREE.DoubleSide;
    const put = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      castle.add(m);
      return m;
    };
    const flag = (x: number, y: number, z: number) => {
      put(new THREE.CylinderGeometry(0.18, 0.18, 7, 6), trim, x, y + 3.5, z);
      const pivot = new THREE.Group();
      pivot.position.set(x, y + 6, z);
      pivot.add(new THREE.Mesh(new THREE.PlaneGeometry(5, 2.6).translate(2.5, 0, 0), cloth));
      castle.add(pivot);
      this.flags.push(pivot);
    };
    const tower = (x: number, z: number, r: number, h: number, roofH = r * 3, withFlag = false) => {
      put(new THREE.CylinderGeometry(r, r * 1.06, h, 20), stone, x, h / 2, z);
      put(new THREE.CylinderGeometry(r * 1.2, r * 1.2, 1.8, 20), trim, x, h - 0.9, z);
      put(new THREE.ConeGeometry(r * 1.34, roofH, 20), roof, x, h + roofH / 2 - 0.2, z);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + 0.3;
        put(new THREE.BoxGeometry(r * 0.2, r * 0.45, 0.5), glow, x + Math.sin(a) * r * 1.01, h * (0.45 + 0.4 * ((k * 0.37) % 1)), z + Math.cos(a) * r * 1.01, a);
      }
      if (withFlag) flag(x, h + roofH - 0.5, z);
    };
    const wall = (ax: number, az: number, bx: number, bz: number, h: number) => {
      const len = Math.hypot(bx - ax, bz - az);
      const ry = Math.atan2(bx - ax, bz - az);
      put(new THREE.BoxGeometry(3, h, len), stone, (ax + bx) / 2, h / 2, (az + bz) / 2, ry);
      // Créneaux.
      for (let s = 1.5; s < len - 1; s += 2.6) {
        const f = s / len;
        put(new THREE.BoxGeometry(3.3, 1.8, 1.3), trim, ax + (bx - ax) * f, h + 0.9, az + (bz - az) * f, ry);
      }
    };
    // Enceinte : huit tours sur une ellipse, reliées par des remparts.
    const ring: [number, number][] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      ring.push([Math.sin(a) * 50, Math.cos(a) * 38]);
    }
    ring.forEach(([x, z], k) => {
      const [nx, nz] = ring[(k + 1) % 8];
      wall(x, z, nx, nz, 20);
      tower(x, z, 5 + (k % 3) * 0.6, 30 + ((k * 7) % 4) * 3, undefined, k % 2 === 0);
    });
    // Porte, face à nous, entre deux tours.
    tower(-8, 40, 4, 27);
    tower(8, 40, 4, 27);
    put(new THREE.BoxGeometry(9, 13, 2), dark, 0, 6.5, 40.5);
    // Donjon à deux étages, toit en pavillon, tourelles d'angle.
    put(new THREE.BoxGeometry(38, 34, 30), stone, 0, 17, -2);
    put(new THREE.BoxGeometry(39, 1.8, 31), trim, 0, 34, -2);
    put(new THREE.BoxGeometry(27, 16, 22), stone, 0, 42, -4);
    put(new THREE.ConeGeometry(20, 13, 4).rotateY(Math.PI / 4).scale(1, 1, 0.82), roof, 0, 56.5, -4);
    for (const [x, z] of [[-19, 13], [19, 13], [-19, -17], [19, -17]]) tower(x, z, 3, 44, 9);
    for (let row = 0; row < 3; row++) {
      for (let c = -3; c <= 3; c++) put(new THREE.BoxGeometry(1.6, 3, 0.5), glow, c * 4.6, 8 + row * 9, 13.1);
    }
    // Grande tour centrale et sa flèche.
    put(new THREE.CylinderGeometry(6.5, 7, 80, 24), stone, 0, 40, -8);
    put(new THREE.TorusGeometry(7.6, 0.8, 8, 28).rotateX(Math.PI / 2), trim, 0, 62, -8);
    put(new THREE.CylinderGeometry(4.6, 5, 14, 20), stone, 0, 87, -8);
    put(new THREE.CylinderGeometry(5.6, 5.6, 1.6, 20), trim, 0, 93.5, -8);
    put(new THREE.ConeGeometry(6.2, 26, 20), roof, 0, 107, -8);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      put(new THREE.BoxGeometry(1.2, 3.2, 0.5), glow, Math.sin(a) * 6.6, 50 + (k % 3) * 8, -8 + Math.cos(a) * 6.6, a);
    }
    flag(0, 119, -8);
    // Grande tour secondaire.
    tower(-27, -12, 5, 60, 16, true);
    castle.scale.setScalar(0.88);
    castle.position.set(CASTLE.x, h0 - 1, -CASTLE.d);
    castle.rotation.y = -0.15;
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

  /** Une cascade : une nappe d'eau qui file le long de la falaise du plateau, de la brume à son pied. */
  private buildFall(x: number, width: number, mistScale: number): void {
    const edge = plateauEdge(x);
    const top = height(x, edge + 6);
    const bottom = WATER;
    const run = 36;
    const len = Math.hypot(top - bottom, run);
    const sheet = new THREE.Mesh(
      new THREE.PlaneGeometry(width, len, 1, 1),
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
            float lanes = ${(width * 1.2).toFixed(1)};
            float lane = hash12(vec2(floor(vUv.x * lanes), 3.0));
            float flow = vnoise(vec2(vUv.x * lanes, vUv.y * 9.0 + uTime * (2.2 + lane)));
            float fine = vnoise(vec2(vUv.x * lanes * 3.0, vUv.y * 30.0 + uTime * 6.0));
            float streak = smoothstep(0.3, 0.9, flow * 0.75 + fine * 0.35);
            float edge = 1.0 - smoothstep(0.6, 1.0, x + 0.2 * vnoise(vec2(vUv.y * 12.0 - uTime * 3.0, 1.0)));
            vec3 water = mix(vec3(0.3, 0.42, 0.48), vec3(1.0, 0.99, 0.97), streak);
            // Écume au pied, blanche et épaisse.
            float foam = 1.0 - smoothstep(0.0, 0.18, vUv.y);
            water = mix(water, vec3(1.0), foam * 0.8);
            vec3 c = water * (SUNC * 0.4 + ambient(vec3(0.0, 0.5, 0.8)) * 1.25);
            float a = edge * (0.6 + 0.4 * streak) * smoothstep(0.0, 0.025, vUv.y);
            gl_FragColor = vec4(finish(aerial(c, vLocal)), a);
          }`,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    sheet.position.set(x, (top + bottom) / 2, -(edge - 6 - run / 2 - 4));
    sheet.rotation.x = -Math.atan2(run, top - bottom);
    this.add(sheet, 3);
    const foot = new THREE.Vector3(x, WATER, -(edge - run - 14));
    const sources = [-0.42, -0.25, -0.08, 0.08, 0.25, 0.42].map((f) => foot.clone().add(new THREE.Vector3(f * width, 0, (this.rnd() - 0.5) * 6)));
    this.add(
      this.puffs(sources, 30, {
        size: 4 * mistScale, grow: 16 * mistScale, rise: 45 * mistScale, drift: 8, speed: 0.07, color: new THREE.Color(0.86, 0.89, 0.93), alpha: 0.26,
      }),
      4,
    );
  }

  private buildFalls(): void {
    this.buildFall(FALLS.x, 55, 1.4);
    this.buildFall(FALLS2_X, 24, 0.8);
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

  /** Voiliers façon conte : coque de bois ronde, mât, grande voile gonflée crème et rouge à
   *  emblème, fanion. Ils croisent lentement sur le lac. */
  private buildBoats(): void {
    const wood = this.lit({ color: new THREE.Color(0.2, 0.1, 0.045) });
    const deck = this.lit({ color: new THREE.Color(0.42, 0.28, 0.13) });
    const cloth = this.lit({ color: new THREE.Color(0.5, 0.05, 0.04) });
    cloth.side = THREE.DoubleSide;
    const sailMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        ${VERT_LOCAL}
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vLocal = (uLandInv * w).xyz;
          vN = normalize(mat3(uLandInv) * mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        varying vec3 vLocal;
        varying vec3 vN;
        varying vec2 vUv;
        void main() {
          vec3 cream = vec3(0.8, 0.75, 0.63);
          vec3 red = vec3(0.55, 0.06, 0.05);
          float band = smoothstep(0.4, 0.42, vUv.y) - smoothstep(0.56, 0.58, vUv.y);
          vec3 col = mix(cream, red, band);
          float c = length((vUv - vec2(0.5, 0.76)) * vec2(1.0, 1.15));
          col = mix(col, red, (1.0 - smoothstep(0.12, 0.13, c)) * smoothstep(0.075, 0.085, c));
          col = mix(col, vec3(0.75, 0.55, 0.1), 1.0 - smoothstep(0.05, 0.06, c));
          col *= 0.9 + 0.1 * vnoise(vUv * vec2(40.0, 3.0));
          vec3 n = normalize(vN) * (gl_FrontFacing ? 1.0 : -1.0);
          vec3 c2 = col * (SUNC * max(dot(n, uSun), 0.0) + ambient(n)) + col * SUNC * 0.12 * max(dot(-n, uSun), 0.0);
          gl_FragColor = vec4(finish(aerial(c2, vLocal)), 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const sailGeo = new THREE.PlaneGeometry(6.6, 8, 10, 10);
    const sp = sailGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i) / 3.3;
      const y = (sp.getY(i) + 4) / 8;
      sp.setZ(i, 1.4 * (1 - x * x) * (0.55 + 0.45 * y));
    }
    sailGeo.computeVertexNormals();
    for (let i = 0; i < 3; i++) {
      const boat = new THREE.Group();
      boat.add(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2).scale(2.3, 1.5, 6.5).translate(0, 0.5, 0), wood));
      boat.add(new THREE.Mesh(new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2).scale(2.2, 1, 6.3).translate(0, 0.55, 0), deck));
      const post = new THREE.Mesh(new THREE.ConeGeometry(0.35, 2.6, 6), wood);
      post.position.set(0, 1.4, 6.2);
      post.rotation.x = 0.55;
      boat.add(post);
      boat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 11, 8).translate(0, 6, 0.6), wood));
      boat.add(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 7.2, 6).rotateZ(Math.PI / 2).translate(0, 10.4, 0.7), wood));
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.position.set(0, 6.3, 0.8);
      boat.add(sail);
      const pennant = new THREE.Group();
      pennant.position.set(0, 11.6, 0.6);
      pennant.add(new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.8).translate(-1.1, 0, 0).rotateY(Math.PI / 2), cloth));
      boat.add(pennant);
      this.flags.push(pennant);
      boat.scale.setScalar(1.2);
      this.boats.push(boat);
      this.add(boat, 1);
    }
  }

  /** Trajet du dragon-serpent (repère du paysage) : de grandes boucles lentes au-dessus du lac, du
   *  plateau et du château. */
  private dragonPath(t: number): THREE.Vector3 {
    const u = t * 0.05;
    return new THREE.Vector3(
      20 + 300 * Math.sin(u * 0.9) + 80 * Math.sin(u * 2.3 + 1),
      115 + 35 * Math.sin(u * 1.3) + 12 * Math.sin(u * 3.1),
      -(720 + 170 * Math.sin(u * 0.6 + 1) + 40 * Math.sin(u * 1.9)),
    );
  }

  /** Rayon du corps le long du dragon (0 = derrière la tête, 1 = bout de la queue). */
  private static dragonRadius(k: number): number {
    if (k < 0.06) return DRAGON_R * (0.62 + (k / 0.06) * 0.38);
    return DRAGON_R * (1 - 0.88 * ((k - 0.06) / 0.94) ** 1.3);
  }

  /** Un long dragon-serpent doré à l'orientale : corps lisse et continu (dos doré à écailles,
   *  ventre crème, crête lumineuse), quatre petites pattes griffues, tête à museau, mâchoire, bois
   *  ramifiés et longues moustaches lumineuses, crinière et bout de queue électriques. */
  private buildDragon(): void {
    const R = DRAGON_RINGS;
    const S = DRAGON_SEG;
    const body = new THREE.BufferGeometry();
    body.setAttribute("position", new THREE.BufferAttribute(new Float32Array(R * (S + 1) * 3), 3));
    body.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(R * (S + 1) * 3), 3));
    const side = new Float32Array(R * (S + 1));
    const along = new Float32Array(R * (S + 1));
    for (let i = 0; i < R; i++) {
      for (let k = 0; k <= S; k++) {
        side[i * (S + 1) + k] = Math.sin((k / S) * Math.PI * 2);
        along[i * (S + 1) + k] = i / (R - 1);
      }
    }
    body.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    body.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
    const index: number[] = [];
    for (let i = 0; i < R - 1; i++) {
      for (let k = 0; k < S; k++) {
        const a = i * (S + 1) + k;
        const b = a + S + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    body.setIndex(index);
    const skinMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        ${VERT_LOCAL}
        attribute float aSide;
        attribute float aAlong;
        varying float vSide;
        varying float vAlong;
        void main() {
          vSide = aSide;
          vAlong = aAlong;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vLocal = (uLandInv * w).xyz;
          vN = normal;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        varying vec3 vLocal;
        varying vec3 vN;
        varying float vSide;
        varying float vAlong;
        void main() {
          float back = smoothstep(-0.35, 0.25, vSide);
          vec3 belly = vec3(0.55, 0.45, 0.26) * (0.85 + 0.15 * step(0.5, fract(vAlong * 90.0)));
          vec3 gold = mix(vec3(0.42, 0.24, 0.03), vec3(0.24, 0.2, 0.05), vAlong * 0.7);
          float scale = fract(vAlong * 240.0 + vSide * 1.5);
          gold *= 0.72 + 0.28 * smoothstep(0.0, 0.55, scale);
          vec3 albedo = mix(belly, gold, back);
          vec3 n = normalize(vN);
          vec3 v = normalize(vLocal - uCam);
          float rim = pow(1.0 - abs(dot(n, v)), 3.0);
          vec3 c = albedo * (SUNC * max(dot(n, uSun), 0.0) + ambient(n));
          c += vec3(1.0, 0.7, 0.3) * rim * 0.35 + vec3(0.3, 0.9, 1.0) * smoothstep(0.93, 1.0, vSide) * 1.2;
          gl_FragColor = vec4(finish(aerial(c, vLocal)), 1.0);
        }`,
      side: THREE.DoubleSide,
    });
    const bodyMesh = new THREE.Mesh(body, skinMat);
    bodyMesh.frustumCulled = false;
    this.add(bodyMesh, 1);

    // Crinière (le long du dos), couronne derrière la tête, touffe au bout de la queue.
    const crown = Array.from({ length: 50 }, () => new THREE.Vector3((this.rnd() - 0.5) * 2, this.rnd() * 1.2 + 0.3, -this.rnd() * 1.8));
    const tuft = Array.from({ length: 70 }, () => new THREE.Vector3((this.rnd() - 0.5) * 2, (this.rnd() - 0.5) * 2, -this.rnd() * 3));
    const N = R * 3 + crown.length + tuft.length;
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
            gl_PointSize = (6.0 + 6.0 * aSeed) * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
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

    // Tête (vers +z).
    const r = DRAGON_R;
    const skin = this.lit({ color: new THREE.Color(0.4, 0.23, 0.03) });
    const pale = this.lit({ color: new THREE.Color(0.55, 0.45, 0.26) });
    const ivory = this.lit({ color: new THREE.Color(0.75, 0.7, 0.55) });
    const glow = this.lit({ color: new THREE.Color(0, 0, 0), emissive: new THREE.Color(0.8, 2.2, 2.6) });
    const head = new THREE.Group();
    head.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.05, 20, 14).scale(1, 0.8, 1.15), skin));
    head.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.42, r * 0.72, r * 2.4, 16).rotateX(Math.PI / 2).translate(0, -r * 0.1, r * 1.9), skin));
    head.add(new THREE.Mesh(new THREE.SphereGeometry(r * 0.46, 14, 10).translate(0, -r * 0.05, r * 3.1), skin));
    const jaw = new THREE.Group();
    jaw.position.set(0, -r * 0.45, r * 0.6);
    jaw.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.3, r * 0.55, r * 2.3, 14).rotateX(Math.PI / 2).translate(0, -r * 0.15, r * 1.15), pale));
    head.add(jaw);
    const whiskerCurve = (side: number) =>
      new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * r * 0.45, -r * 0.15, r * 2.7),
        new THREE.Vector3(side * r * 2.0, -r * 0.5, r * 1.8),
        new THREE.Vector3(side * r * 3.3, -r * 1.3, -r * 0.3),
        new THREE.Vector3(side * r * 3.9, -r * 2.4, -r * 2.6),
      ]);
    for (const side of [-1, 1]) {
      // Bois : un grand andouiller recourbé vers l'arrière, deux branches.
      const antler = new THREE.Group();
      antler.position.set(side * r * 0.55, r * 0.6, -r * 0.3);
      antler.rotation.set(-1.0, side * 0.25, side * 0.45);
      antler.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.07, r * 0.18, r * 3.4, 8).translate(0, r * 1.7, 0), ivory));
      for (const [y, a, l] of [[1.4, 0.9, 1.4], [2.4, -0.8, 1.1]]) {
        const branch = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.05, r * 0.1, r * l, 6).translate(0, (r * l) / 2, 0), ivory);
        branch.position.y = r * y;
        branch.rotation.x = a;
        antler.add(branch);
      }
      head.add(antler);
      head.add(new THREE.Mesh(new THREE.TubeGeometry(whiskerCurve(side), 24, r * 0.07, 6), glow));
      const eye = new THREE.Mesh(new THREE.SphereGeometry(r * 0.17, 10, 8), glow);
      eye.position.set(side * r * 0.62, r * 0.32, r * 1.05);
      head.add(eye);
      const brow = new THREE.Mesh(new THREE.ConeGeometry(r * 0.18, r * 0.9, 6), skin);
      brow.position.set(side * r * 0.6, r * 0.55, r * 0.9);
      brow.rotation.set(-1.2, 0, side * 0.3);
      head.add(brow);
    }
    this.add(head, 1);

    // Quatre petites pattes : une cuisse, trois griffes.
    const legs: { group: THREE.Group; ring: number; side: number }[] = [];
    for (const ring of [14, 62]) {
      for (const side of [-1, 1]) {
        const g = new THREE.Group();
        const leg = new THREE.Group();
        leg.add(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.22, r * 0.32, r * 1.5, 8).translate(0, -r * 0.75, 0), skin));
        for (let c = -1; c <= 1; c++) {
          const claw = new THREE.Mesh(new THREE.ConeGeometry(r * 0.07, r * 0.5, 5), ivory);
          claw.position.set(c * r * 0.15, -r * 1.6, r * 0.12);
          claw.rotation.x = Math.PI * 0.75;
          leg.add(claw);
        }
        leg.rotation.z = side * 0.5;
        g.add(leg);
        legs.push({ group: g, ring, side });
        this.add(g, 1);
      }
    }
    this.dragon = { body, mane, head, jaw, legs, tuft, crown };
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

  /** Ce qui bouge dans le monde : voiliers, drapeaux, dragon-serpent, oiseaux. */
  private animateLife(t: number): void {
    const up = new THREE.Vector3(0, 1, 0);
    this.boats.forEach((boat, i) => {
      const a = t * 0.012 + i * 2.1;
      const x = LAKE.x + Math.cos(a) * (60 - i * 14);
      const d = LAKE.d + Math.sin(a) * (55 - i * 12);
      boat.position.set(x, WATER + Math.sin(t * 1.3 + i) * 0.15, -d);
      boat.rotation.set(Math.sin(t * 0.9 + i) * 0.04, Math.atan2(-Math.sin(a), -Math.cos(a)), Math.sin(t * 1.1 + i * 2) * 0.05);
    });
    this.flags.forEach((f, i) => {
      f.rotation.y = Math.sin(t * 2.6 + i * 1.7) * 0.35 + Math.sin(t * 6.1 + i) * 0.08;
    });
    if (this.dragon) this.animateDragon(t, up);
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

  /** Le dragon : la colonne suit le trajet de la tête (avec du retard) et ondule ; le corps est
   *  reconstruit autour à chaque image (anneaux orientés), crinière et pattes posées dessus. */
  private animateDragon(t: number, up: THREE.Vector3): void {
    const D = this.dragon!;
    const R = DRAGON_RINGS;
    const S = DRAGON_SEG;
    const spine: THREE.Vector3[] = [];
    for (let i = 0; i < R; i++) {
      const p = this.dragonPath(t - i * DRAGON_LAG);
      p.y += Math.sin(i * 0.2 - t * 2.0) * 7;
      p.x += Math.sin(i * 0.13 - t * 1.5) * 5;
      spine.push(p);
    }
    const pos = D.body.attributes.position as THREE.BufferAttribute;
    const nor = D.body.attributes.normal as THREE.BufferAttribute;
    const mp = D.mane.geometry.attributes.position as THREE.BufferAttribute;
    const T = new THREE.Vector3();
    const Nv = new THREE.Vector3();
    const B = new THREE.Vector3();
    const frames: { N: THREE.Vector3; B: THREE.Vector3; T: THREE.Vector3; r: number }[] = [];
    for (let i = 0; i < R; i++) {
      T.subVectors(spine[Math.max(0, i - 1)], spine[Math.min(R - 1, i + 1)]).normalize();
      Nv.crossVectors(T, up).normalize();
      B.crossVectors(Nv, T);
      const r = PortalMode.dragonRadius(i / (R - 1));
      frames.push({ N: Nv.clone(), B: B.clone(), T: T.clone(), r });
      for (let k = 0; k <= S; k++) {
        const a = (k / S) * Math.PI * 2;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const j = i * (S + 1) + k;
        pos.setXYZ(j, spine[i].x + (Nv.x * ca + B.x * sa * 1.08) * r, spine[i].y + (Nv.y * ca + B.y * sa * 1.08) * r, spine[i].z + (Nv.z * ca + B.z * sa * 1.08) * r);
        nor.setXYZ(j, Nv.x * ca + B.x * sa, Nv.y * ca + B.y * sa, Nv.z * ca + B.z * sa);
      }
      for (let j = 0; j < 3; j++) {
        const lift = r * (1.05 + 0.4 * j) + Math.sin(t * 6 + i + j * 2) * 1.2;
        mp.setXYZ(i * 3 + j, spine[i].x + B.x * lift + Nv.x * Math.sin(i * 1.7 + j) * r * 0.3, spine[i].y + B.y * lift, spine[i].z + B.z * lift + Nv.z * Math.sin(i * 1.7 + j) * r * 0.3);
      }
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    D.body.computeBoundingSphere();
    // Couronne derrière la tête, touffe au bout de la queue (elle flotte).
    const f0 = frames[2];
    let n = R * 3;
    for (const o of D.crown) {
      const p = spine[2].clone().addScaledVector(f0.N, o.x * DRAGON_R).addScaledVector(f0.B, o.y * DRAGON_R * 1.3).addScaledVector(f0.T, o.z * DRAGON_R);
      mp.setXYZ(n++, p.x, p.y + Math.sin(t * 3 + o.x * 5) * 0.8, p.z);
    }
    const fe = frames[R - 1];
    for (const o of D.tuft) {
      const p = spine[R - 1].clone().addScaledVector(fe.N, o.x * DRAGON_R * 0.6).addScaledVector(fe.B, o.y * DRAGON_R * 0.6 + Math.sin(t * 2.5 + o.z * 2) * 2).addScaledVector(fe.T, o.z * DRAGON_R);
      mp.setXYZ(n++, p.x, p.y, p.z);
    }
    mp.needsUpdate = true;
    // Tête, mâchoire qui s'entrouvre.
    const hp = this.dragonPath(t + DRAGON_LAG * 1.6);
    hp.y += Math.sin(-t * 2.0 - 0.3) * 7;
    hp.x += Math.sin(-t * 1.5 - 0.2) * 5;
    D.head.position.copy(hp);
    D.head.up.copy(up);
    D.head.lookAt(this.dragonPath(t + DRAGON_LAG * 5));
    D.jaw.rotation.x = 0.12 + 0.1 * Math.sin(t * 0.7);
    // Pattes : sous le ventre, qui pédalent doucement.
    const basis = new THREE.Matrix4();
    for (const L of D.legs) {
      const f = frames[L.ring];
      basis.makeBasis(f.N, f.B, f.T);
      L.group.quaternion.setFromRotationMatrix(basis);
      L.group.position.copy(spine[L.ring]).addScaledVector(f.N, L.side * f.r * 0.7).addScaledVector(f.B, -f.r * 0.45);
      L.group.rotateX(Math.sin(t * 1.8 + L.ring * 0.3 + L.side) * 0.35);
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

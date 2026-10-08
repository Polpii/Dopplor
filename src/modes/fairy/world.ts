// Le monde derrière la vitre, en 3D (Three.js).
//
// Dans un miroir, le reflet est derrière la vitre, à la même distance que la personne devant.
// La 3D vit dans cet espace-là : on la regarde depuis l'œil de la personne, à travers l'écran
// (une perspective décentrée dont l'écran est la fenêtre). Elle se dessine donc exactement là où
// la personne la verrait si elle était vraiment derrière la vitre, à côté de son reflet.
//
// Occlusion : le serveur envoie la distance du reflet du corps pour chaque case de l'écran ; un
// morceau de 3D plus loin que le reflet à cet endroit est caché (la fée passe derrière la
// personne et disparaît).
//
// Repères : miroir (serveur) x vers la droite, y vers le bas, z vers le mur, origine au coin
// haut-gauche de l'écran ; Three : x vers la droite, y vers le haut, z vers la pièce. Ce qui est
// derrière la vitre a donc un z Three négatif.
import * as THREE from "three";
import type { Occlusion, Vec3 } from "../../vision/source";

/** Repère du miroir → Three. */
export const toThree = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], -p[1], -p[2]);
/** Reflet d'un point réel (devant la vitre), en coordonnées Three. */
export const reflected = (p: Vec3): THREE.Vector3 => new THREE.Vector3(p[0], -p[1], p[2]);

/** Après ce délai sans silhouette, on ne cache plus rien (personne, ou plus de mesures). */
const OCCLUSION_STALE_MS = 400;

const OCCLUSION_GLSL = /* glsl */ `
uniform sampler2D uOcc;
uniform vec2 uRes;
uniform float uScale;
uniform float uHasOcc;
uniform vec2 uCell;
uniform float uBias;
// r : distance du reflet du corps (× uScale), g : couverture par le corps (bord doux).
float visibleAt(vec2 uv, float zBehind) {
  vec2 o = texture2D(uOcc, uv).rg;
  if (o.g < 0.002) return 1.0;
  float behind = 1.0 - smoothstep(-0.05, 0.05, o.r * 255.0 * uScale - zBehind);
  return 1.0 - o.g * behind;
}
// 1 si ce fragment, à zBehind m derrière la vitre, est devant le reflet du corps (ou à côté).
// Moyenne de 5 lectures autour du point : un bord doux au lieu des marches de la grille.
// uBias : la fée compte comme un peu plus près qu'elle n'est (posée sur une main, sa lumière
// ne doit pas être cachée par cette main).
float visibleBehind(float zBehind) {
  if (uHasOcc < 0.5) return 1.0;
  zBehind -= uBias;
  vec2 uv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  vec2 c = uCell;
  return (visibleAt(uv, zBehind) * 2.0 + visibleAt(uv + vec2(c.x, 0.0), zBehind) + visibleAt(uv - vec2(c.x, 0.0), zBehind)
    + visibleAt(uv + vec2(0.0, c.y), zBehind) + visibleAt(uv - vec2(0.0, c.y), zBehind)) / 6.0;
}
`;

const VERTEX = /* glsl */ `
varying vec2 vUv;
varying float vBehind;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vBehind = -world.z;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export interface SharedUniforms {
  uOcc: { value: THREE.DataTexture };
  uRes: { value: THREE.Vector2 };
  uScale: { value: number };
  uHasOcc: { value: number };
  uCell: { value: THREE.Vector2 };
  uBias: { value: number };
  [name: string]: THREE.IUniform;
}

/** Lueur ronde (cœur, halo) : additive, cachée derrière le corps. */
export function glowMaterial(shared: SharedUniforms, color: THREE.Color, sharpness: number, intensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: color }, uSharp: { value: sharpness }, uIntensity: { value: intensity } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${OCCLUSION_GLSL}
      uniform vec3 uColor;
      uniform float uSharp;
      uniform float uIntensity;
      varying vec2 vUv;
      varying float vBehind;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        float a = exp(-r2 * uSharp) * (1.0 - smoothstep(0.8, 1.0, r2)) * uIntensity * visibleBehind(vBehind);
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Aile : une feuille translucide au bord lumineux, attachée par sa base (u = 0). */
export function wingMaterial(shared: SharedUniforms, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: color }, uOpacity: { value: 1 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${OCCLUSION_GLSL}
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying float vBehind;
      void main() {
        // Feuille arrondie : fine à l'attache (u = 0), large vers le milieu, pointe au bout.
        float u = vUv.x;
        float halfWidth = 0.5 * pow(sin(3.14159 * pow(clamp(u, 0.0, 1.0), 0.7)), 0.75);
        float d = abs(vUv.y - 0.5) / max(halfWidth, 1e-3);
        float inside = 1.0 - smoothstep(0.82, 1.0, d);
        float rim = smoothstep(0.55, 0.97, d) * inside;
        // Nervure centrale, très légère, et reflet irisé vers le bout.
        float vein = (1.0 - smoothstep(0.0, 0.12, d)) * (1.0 - u) * 0.25;
        vec3 color = mix(uColor, vec3(1.0, 0.86, 1.0), 0.45 * u);
        float a = (0.13 * inside + 0.55 * rim + vein) * uOpacity * visibleBehind(vBehind);
        gl_FragColor = vec4(color, a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** Étincelles : points ronds qui s'éteignent, cachés derrière le corps eux aussi. */
export function sparkMaterial(shared: SharedUniforms, color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uColor: { value: color } },
    vertexShader: /* glsl */ `
      uniform vec2 uRes;
      attribute float aSize;
      attribute float aLife;
      varying float vLife;
      varying float vBehind;
      void main() {
        vLife = aLife;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vBehind = -world.z;
        vec4 view = viewMatrix * world;
        gl_Position = projectionMatrix * view;
        // Taille réelle (m) → pixels, selon la distance à l'œil.
        gl_PointSize = aSize * aLife * uRes.y * projectionMatrix[1][1] * 0.5 / max(0.05, -view.z);
      }`,
    fragmentShader: /* glsl */ `
      ${OCCLUSION_GLSL}
      uniform vec3 uColor;
      varying float vLife;
      varying float vBehind;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float a = exp(-dot(p, p) * 4.0) * vLife * visibleBehind(vBehind);
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.5 * vLife), a);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Rendu Three.js sur un canevas transparent par-dessus le reste, vu depuis l'œil de la personne à
 * travers l'écran, avec la silhouette du reflet comme cache.
 */
export class MirrorWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera();
  readonly shared: SharedUniforms;
  private renderer: THREE.WebGLRenderer;
  private occTexture: THREE.DataTexture;
  private eye: THREE.Vector3 | null = null;
  private screen: Vec3 | null = null;

  /** `resolution` : part de la définition de l'écran (lueurs douces : la moitié suffit). */
  constructor(readonly canvas: HTMLCanvasElement, private resolution = 0.5) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 1);
    this.occTexture = new THREE.DataTexture(new Uint8Array([255, 0]), 1, 1, THREE.RGFormat, THREE.UnsignedByteType);
    this.occTexture.unpackAlignment = 1;
    this.occTexture.magFilter = THREE.LinearFilter;
    this.occTexture.minFilter = THREE.LinearFilter;
    this.occTexture.needsUpdate = true;
    this.shared = {
      uOcc: { value: this.occTexture },
      uRes: { value: new THREE.Vector2(1, 1) },
      uScale: { value: 0.02 },
      uHasOcc: { value: 0 },
      uCell: { value: new THREE.Vector2(1 / 108, 1 / 192) },
      uBias: { value: 0 },
    };
    this.camera.matrixAutoUpdate = false;
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, Math.round(window.innerWidth * this.resolution));
    const h = Math.max(1, Math.round(window.innerHeight * this.resolution));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.shared.uRes.value.set(w, h);
  }

  /** Œil, écran et silhouette à jour ; faux tant que le serveur n'a rien envoyé. */
  get ready(): boolean {
    return this.eye !== null && this.screen !== null;
  }

  /**
   * `fallbackScreen` : taille de l'écran (calibration) tant que le serveur n'a rien envoyé
   * (personne devant le miroir) ; l'œil est alors supposé à 2 m, face au haut de l'écran.
   */
  update(occ: Occlusion | null, now: number, fallbackScreen: Vec3 | null = null): void {
    const fresh = occ !== null && now - occ.at < OCCLUSION_STALE_MS;
    if (!occ && !this.eye && fallbackScreen) {
      this.screen = fallbackScreen;
      this.eye = toThree([fallbackScreen[0] / 2, fallbackScreen[1] * 0.2, -2]);
    }
    if (occ) {
      // L'œil bouge peu : un léger lissage évite que tout le monde 3D frémisse.
      const e = toThree(occ.eye);
      this.eye = this.eye ? this.eye.lerp(e, 0.25) : e;
      this.screen = occ.screen;
    }
    if (fresh) {
      if (this.occTexture.image.width !== occ.w || this.occTexture.image.height !== occ.h) {
        this.occTexture.dispose();
        this.occTexture = new THREE.DataTexture(new Uint8Array(occ.w * occ.h * 2), occ.w, occ.h, THREE.RGFormat, THREE.UnsignedByteType);
        this.occTexture.unpackAlignment = 1;
        this.occTexture.magFilter = THREE.LinearFilter;
        this.occTexture.minFilter = THREE.LinearFilter;
        this.shared.uOcc.value = this.occTexture;
      }
      const data = this.occTexture.image.data as Uint8Array;
      if (occ.channels === 2) data.set(occ.grid);
      else for (let i = 0; i < occ.w * occ.h; i++) data.set([occ.grid[i], occ.grid[i] < 255 ? 255 : 0], i * 2);
      this.occTexture.needsUpdate = true;
      this.shared.uScale.value = occ.scale;
      this.shared.uCell.value.set(1 / occ.w, 1 / occ.h);
    }
    this.shared.uHasOcc.value = fresh ? 1 : 0;
  }

  render(): void {
    if (!this.eye || !this.screen) return;
    // Perspective décentrée : l'œil regarde à travers le rectangle de l'écran (plan z = -écart).
    const [sw, sh, gap] = this.screen;
    const e = this.eye;
    const near = 0.05;
    const dz = Math.max(0.05, e.z + gap);
    const k = near / dz;
    this.camera.position.copy(e);
    this.camera.quaternion.identity();
    this.camera.updateMatrix();
    this.camera.updateMatrixWorld(true);
    this.camera.projectionMatrix.makePerspective((0 - e.x) * k, (sw - e.x) * k, (0 - e.y) * k, (-sh - e.y) * k, near, 30);
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
    this.renderer.render(this.scene, this.camera);
  }

  clear(): void {
    this.renderer.clear();
  }

  dispose(): void {
    this.renderer.dispose();
    this.occTexture.dispose();
  }
}

// Le menu dans le reflet : les bulles sont des objets 3D dans l'espace derrière la vitre, en
// couronne autour du haut du corps de la personne (au-dessus de la tête, à côté), à la
// profondeur de son buste, vues depuis son œil. Elles suivent la personne (comme si elles
// faisaient partie de son reflet) : même taille relative quand elle s'approche ou recule.
// Là où elles touchent la silhouette, elles passent derrière ; la main qui monte les toucher
// passe devant, comme avec un vrai objet.
//
// Le menu (menu.ts) garde ses gestes et son rythme ; ici, seulement où sont les bulles et de
// quoi elles ont l'air. La fée accompagne l'ouverture et la fermeture (fairy-mode.ts).
import * as THREE from "three";
import type { Occlusion } from "../vision/source";
import type { FairyMode } from "./fairy/fairy-mode";
import { reflected, type MirrorWorld, type SharedUniforms } from "./fairy/world";
import type { MenuItem, MenuStage, MenuView, Stroke } from "./menu";

/** Bulle (rayon de la géométrie, m) ; sa vraie taille suit la carrure (voir BODY_*). */
const BUBBLE_R = 0.045;
/**
 * À l'échelle du corps (en largeurs d'épaules, mesurées en 3D) : rayon d'une bulle, de la
 * couronne (centrée entre la poitrine et la tête), et à quelle distance derrière la poitrine.
 */
const BODY_BUBBLE = 0.17;
const BODY_ARC = 1.15;
const BODY_BEHIND = 0.1;
/** La couronne s'enroule autour de la personne : les bulles des côtés un peu plus en arrière. */
const BODY_WRAP = 0.3;
/** Suivi de la personne (part du chemin par image) : doux, les bulles ne tremblent pas. */
const FOLLOW = 0.12;
/** Écart entre deux bulles voisines sur l'arc. */
const ARC_STEP = (48 * Math.PI) / 180;
/** Éclosion : la première bulle, puis une toutes les … (ms) — dans le rythme du menu 2D. */
const FIRST_MS = 90;
const STEP_MS = 120;
/** Marge au bord de l'écran (fraction). */
const MARGIN = 0.06;
/** Les bulles sont cachées par le corps devant elles (la main qui les touche aussi). */
const BIAS = 0;

const COLORS = {
  idle: new THREE.Color("#7fdcff"),
  active: new THREE.Color("#fff1c9"),
  hover: new THREE.Color("#ffffff"),
  progress: new THREE.Color("#ffd36b"),
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
varying float vBehind;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vBehind = -world.z;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

/** Le cache par le corps, comme pour la fée (voir world.ts). */
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

/** Bulle : verre lumineux (bord brillant, reflet en haut à gauche), icône, jauge de choix. */
function bubbleMaterial(shared: SharedUniforms, icon: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uSolid: { value: 1 },
      uIcon: { value: icon },
      uColor: { value: COLORS.idle.clone() },
      uGlow: { value: 0.6 },
      uAppear: { value: 0 },
      uProgress: { value: 0 },
      uGold: { value: COLORS.progress },
    },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${OCCLUSION}
      uniform sampler2D uIcon;
      uniform vec3 uColor;
      uniform vec3 uGold;
      uniform float uGlow;
      uniform float uAppear;
      uniform float uProgress;
      varying vec2 vUv;
      void main() {
        // Quad de 2,6 rayons : la bulle a un rayon 1/1,3 du demi-côté.
        vec2 p = (vUv * 2.0 - 1.0) * 1.3;
        float r = length(p);
        float rim = exp(-pow((r - 1.0) / 0.06, 2.0));
        float halo = exp(-pow(max(0.0, r - 1.0) / 0.18, 2.0)) * 0.35;
        float inside = 1.0 - smoothstep(0.96, 1.0, r);
        // Verre : un peu plus clair vers le bord, reflet en haut à gauche.
        float glass = inside * (0.05 + 0.12 * smoothstep(0.4, 1.0, r));
        float shine = inside * exp(-dot(p - vec2(-0.38, -0.42), p - vec2(-0.38, -0.42)) * 18.0) * 0.5;
        vec4 ic = texture2D(uIcon, vUv * 1.3 - 0.15);
        float icon = ic.a * inside;
        // Jauge du choix : un arc doré autour, depuis le haut, dans le sens des aiguilles.
        float a = atan(p.x, -p.y);
        float frac = (a < 0.0 ? a + 6.28318 : a) / 6.28318;
        float gauge = uProgress > 0.0 && frac <= uProgress ? exp(-pow((r - 1.18) / 0.05, 2.0)) : 0.0;
        vec3 col = uColor * (rim * 1.4 + halo + glass) * uGlow + vec3(1.0) * shine * uGlow + uColor * icon * (0.6 + uGlow) + uGold * gauge * 1.6;
        float alpha = clamp(max(max(rim * uGlow, halo * uGlow), max(icon, gauge)) + glass + shine, 0.0, 1.0);
        float v = visible() * uAppear;
        gl_FragColor = vec4(col * v, alpha * v);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Nom du mode, au-dessus de la bulle. */
function labelMaterial(shared: SharedUniforms, text: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared, uSolid: { value: 1 }, uText: { value: text }, uOpacity: { value: 0 } },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      ${OCCLUSION}
      uniform sampler2D uText;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uText, vUv);
        float v = visible() * uOpacity;
        gl_FragColor = vec4(t.rgb * t.a * v, t.a * v);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Icône en traits (carré [-1, 1]²) dessinée sur une texture, avec sa lueur. */
function iconTexture(strokes: Stroke[]): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const map = (v: number) => size / 2 + v * size * 0.24;
  g.strokeStyle = "white";
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const [width, blur] of [[16, 18], [7, 0]] as const) {
    g.lineWidth = width;
    g.shadowColor = "white";
    g.shadowBlur = blur;
    g.globalAlpha = blur ? 0.35 : 1;
    for (const s of strokes) {
      g.beginPath();
      if (!Array.isArray(s)) g.arc(map(s.c[0]), map(s.c[1]), s.r * size * 0.24, 0, Math.PI * 2);
      else for (let i = 0; i < s.length; i += 2) (i ? g.lineTo : g.moveTo).call(g, map(s[i]), map(s[i + 1]));
      g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function textTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.font = "500 52px ui-sans-serif, system-ui, 'Segoe UI', sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "rgba(150, 225, 255, 0.9)";
  g.shadowBlur = 14;
  g.fillStyle = "white";
  g.fillText(text, 256, 50);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return { tex, aspect: c.width / c.height };
}

interface Bubble {
  item: MenuItem;
  /** Déjà éclose (gerbe d'étincelles faite). */
  popped: boolean;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  label: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** Place sur l'arc, et quand elle éclot (ms depuis l'ouverture). */
  home: THREE.Vector3;
  birth: number;
  glow: number;
}

export class Menu3D implements MenuStage {
  private group = new THREE.Group();
  private bubbles: Bubble[];
  private palm = new THREE.Vector3();
  private beside = new THREE.Vector3();
  private shownUntil = 0;
  private opened = false;
  /** Taille des bulles (× la géométrie) et largeur d'épaules (m), suivies doucement. */
  private size = 1;
  private shoulders = 0.4;
  /** Centre de la couronne (suit la personne), recadrage pour rester dans l'écran, main qui a ouvert. */
  private anchor = new THREE.Vector3();
  private shift = new THREE.Vector3();
  private side: "left" | "right" | null = null;
  /** Onde de choc (fermeture dans le poing, bulle qui éclate). */
  private wave: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private waveAt = -Infinity;

  constructor(
    private world: MirrorWorld,
    items: MenuItem[],
    private fairy: FairyMode,
    private occlusion: () => Occlusion | null,
  ) {
    const geo = new THREE.PlaneGeometry(BUBBLE_R * 2.6, BUBBLE_R * 2.6);
    this.bubbles = items.map((item) => {
      const mesh = new THREE.Mesh(geo, bubbleMaterial(world.shared, iconTexture(item.icon)));
      const { tex, aspect } = textTexture(item.label);
      const h = BUBBLE_R * 1.05;
      const label = new THREE.Mesh(new THREE.PlaneGeometry(h * aspect, h), labelMaterial(world.shared, tex));
      this.group.add(mesh, label);
      return { item, mesh, label, home: new THREE.Vector3(), birth: 0, glow: 0.6, popped: false };
    });
    this.wave = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        uniforms: { uAlpha: { value: 0 }, uColor: { value: new THREE.Color("#bfefff") } },
        vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uAlpha;
          uniform vec3 uColor;
          varying vec2 vUv;
          void main() {
            float r = length(vUv * 2.0 - 1.0);
            float a = (exp(-pow((r - 0.85) / 0.06, 2.0)) + 0.5 * exp(-r * r * 8.0)) * uAlpha;
            gl_FragColor = vec4(uColor * a, a);
          }`,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.wave.visible = false;
    this.group.visible = false;
    world.scene.add(this.group, this.wave);
  }

  /** Onde de choc : un anneau de lumière qui s'élargit et s'éteint (~0,35 s). */
  private shock(at: THREE.Vector3, now: number): void {
    this.wave.position.copy(at);
    this.waveAt = now;
    this.wave.visible = true;
  }

  /** À dessiner (ouvert, ou en train de se replier / de s'effacer). */
  get visible(): boolean {
    return this.opened || performance.now() < this.shownUntil;
  }

  /** Ouvre la couronne autour de la personne ; faux si pas de 3D (pas calé, personne). */
  open(side: "left" | "right" | null, now: number): boolean {
    const occ = this.occlusion();
    if (!occ || now - occ.at > 500 || !this.world.ready) return false;
    this.side = side;
    this.shift.set(0, 0, 0);
    this.layout(occ, 1);
    // Recadrage : la couronne reste dans l'écran (décalage gardé tant que le menu est ouvert).
    for (let pass = 0; pass < 3; pass++) {
      let dx = 0;
      let dy = 0;
      for (const b of this.bubbles) {
        const [x, y] = this.world.project(b.home);
        dx = x < MARGIN ? Math.max(dx, MARGIN - x) : x > 1 - MARGIN ? Math.min(dx, 1 - MARGIN - x) : dx;
        dy = y < MARGIN ? Math.max(dy, MARGIN - y) : y > 1 - MARGIN ? Math.min(dy, 1 - MARGIN - y) : dy;
      }
      if (!dx && !dy) break;
      // Décalage à l'écran → mètres à cette profondeur.
      const c = this.anchor;
      const [x0, y0] = this.world.project(c);
      const [x1] = this.world.project(c.clone().add(new THREE.Vector3(0.1, 0, 0)));
      const [, y1] = this.world.project(c.clone().add(new THREE.Vector3(0, 0.1, 0)));
      this.shift.x += (dx / (x1 - x0)) * 0.1;
      this.shift.y += (dy / (y1 - y0)) * 0.1;
      this.layout(occ, 1);
    }
    this.bubbles.forEach((b, i) => {
      b.birth = FIRST_MS + STEP_MS * i;
      b.popped = false;
    });
    this.fairy.menuOpen(this.palm, this.bubbles.map((b) => b.home.clone()), this.bubbles.map((b) => b.birth), this.beside, now);
    this.opened = true;
    this.group.visible = true;
    return true;
  }

  /**
   * Place la couronne autour de la personne (`blend` : 1 tout de suite, sinon suivi doux) : au-
   * dessus de la tête et à côté, à la profondeur du buste, à l'échelle de ses épaules. La paume
   * de la main qui a ouvert (d'où le menu jaillit, où il se replie) et la place de la fée.
   */
  private layout(occ: Occlusion, blend: number): void {
    const body = occ.body;
    const chest = reflected(body.chest);
    const head = reflected(body.head);
    const sw = THREE.MathUtils.clamp(reflected(body.ls).distanceTo(reflected(body.rs)), 0.25, 0.6);
    this.shoulders = blend >= 1 ? sw : this.shoulders + (sw - this.shoulders) * blend;
    this.size = (BODY_BUBBLE * this.shoulders) / BUBBLE_R;
    const target = new THREE.Vector3(chest.x, (chest.y + head.y) / 2, chest.z - BODY_BEHIND * this.shoulders);
    if (blend >= 1) this.anchor.copy(target);
    else this.anchor.lerp(target, blend);
    const c = this.anchor.clone().add(this.shift);
    const r = BODY_ARC * this.shoulders;
    const n = this.bubbles.length;
    const spread = (ARC_STEP * (n - 1)) / 2;
    this.bubbles.forEach((b, i) => {
      const a = -spread + ARC_STEP * i;
      b.home.set(c.x + Math.sin(a) * r, c.y + Math.cos(a) * r, c.z - BODY_WRAP * this.shoulders * (1 - Math.cos(a)));
    });
    const palm = this.side ? reflected(this.side === "left" ? body.lp : body.rp) : chest.clone().add(new THREE.Vector3(0, -0.05, 0.25));
    if (blend >= 1) this.palm.copy(palm);
    else this.palm.lerp(palm, 0.35);
    // La fée attend à côté de la dernière bulle, un peu plus haut.
    this.beside.copy(this.bubbles[n - 1].home).add(new THREE.Vector3(0.22 * this.shoulders, 0.1 * this.shoulders, 0.05));
  }

  /** Où sont les bulles à l'écran (px CSS) et leur rayon, pour le pointage. */
  positions(): { x: number; y: number; r: number }[] {
    const [sw, sh] = [window.innerWidth, window.innerHeight];
    return this.bubbles.map((b) => {
      const [x, y] = this.world.project(b.home);
      const [x1] = this.world.project(b.home.clone().add(new THREE.Vector3(BUBBLE_R * this.size, 0, 0)));
      return { x: x * sw, y: y * sh, r: Math.abs(x1 - x) * sw };
    });
  }

  close(kind: "select" | "fold" | "away", index: number | null, now: number): void {
    this.opened = false;
    this.shownUntil = now + 600;
    this.closedKind = kind;
    this.closedAt = now;
    this.chosen = index;
    if (kind === "select" && index !== null) this.fairy.menuSelect(this.bubbles[index].home, BUBBLE_R * this.size, now);
    else this.fairy.menuClose(this.palm, now);
    // Onde de choc quand la fée arrive (poing, ou bulle choisie qui éclate).
    this.pendingShock = { at: kind === "select" && index !== null ? this.bubbles[index].home.clone() : this.palm.clone(), when: now + (kind === "select" ? 340 : 150) };
  }

  private pendingShock: { at: THREE.Vector3; when: number } | null = null;

  private closedKind: "select" | "fold" | "away" = "fold";
  private closedAt = 0;
  private chosen: number | null = null;

  /** Une image : apparence des bulles selon l'état du menu. */
  frame(view: MenuView, now: number): void {
    if (!this.visible) {
      if (this.group.visible) this.group.visible = false;
      return;
    }
    const since = now - view.openedAt;
    const fold = this.opened ? easeIn(view.fold) : 1;
    const closing = this.opened ? 0 : Math.min(1, (now - this.closedAt) / 300);
    // Les bulles suivent la personne (comme une partie de son reflet).
    const occ = this.occlusion();
    if (this.opened && occ && now - occ.at < 500) this.layout(occ, FOLLOW);
    if (this.opened) this.fairy.menuHold(this.beside, this.palm, view.fold, this.shoulders);
    // Onde de choc.
    if (this.pendingShock && now >= this.pendingShock.when) {
      this.shock(this.pendingShock.at, now);
      this.pendingShock = null;
    }
    const w = (now - this.waveAt) / 350;
    if (w >= 0 && w < 1) {
      const r = this.shoulders * (0.15 + 1.1 * (1 - (1 - w) ** 3));
      this.wave.scale.setScalar(r * 2);
      this.wave.material.uniforms.uAlpha.value = 1.4 * (1 - w) ** 2;
    } else if (this.wave.visible) this.wave.visible = false;
    // Repli : les bulles s'enroulent dans le tourbillon de la fée autour de la main.
    const swirl = this.fairy.whirl;
    this.bubbles.forEach((b, i) => {
      const m = b.mesh.material.uniforms;
      // Éclosion (avec un léger dépassement) quand la fée passe, et une gerbe d'étincelles.
      const grow = easeOutBack(Math.min(1, Math.max(0, (since - b.birth) / 220)));
      if (this.opened && !b.popped && since >= b.birth) {
        b.popped = true;
        this.fairy.menuPop(b.home);
      }
      let k = grow * (1 - fold);
      const rel = b.home.clone().sub(this.palm);
      if (this.opened && view.fold > 0) rel.applyAxisAngle(new THREE.Vector3(0, 0, 1), swirl * 0.6 * view.fold);
      let pos = this.palm.clone().addScaledVector(rel, Math.max(0, k));
      if (!this.opened) {
        const chosen = this.closedKind === "select" ? this.bubbles[this.chosen ?? 0].home : null;
        if (chosen && i === this.chosen) {
          // Bulle choisie : elle gonfle et éclate quand la fée a fini son tour.
          const pop = Math.min(1, Math.max(0, (now - this.closedAt - 300) / 120));
          k = 1 + 0.25 * Math.min(1, (now - this.closedAt) / 300) + 0.6 * pop;
          pos = b.home.clone();
          m.uAppear.value = 1 - pop;
        } else if (chosen) {
          // Les autres sont aspirées par la bulle choisie.
          const u = Math.min(1, (now - this.closedAt) / 220);
          k = 1 - u;
          pos = b.home.clone().lerp(chosen, u * u);
          m.uAppear.value = 1 - u;
        } else {
          // Repli dans le poing (déjà fait par le tourbillon) ou effacement en spirale.
          const u = this.closedKind === "fold" ? 1 : closing;
          k = 1 - u;
          pos = this.palm.clone().addScaledVector(rel.applyAxisAngle(new THREE.Vector3(0, 0, 1), u * 3), 1 - u);
          m.uAppear.value = 1 - u;
        }
      } else m.uAppear.value = Math.min(1, Math.max(0, k * 1.5));
      const hovered = this.opened && view.hovered === i;
      const on = view.active[i];
      const target = hovered ? 1.4 : on ? 1.3 : 0.6;
      b.glow += (target - b.glow) * 0.25;
      m.uGlow.value = b.glow;
      (m.uColor.value as THREE.Color).copy(hovered ? COLORS.hover : on ? COLORS.active : COLORS.idle);
      m.uProgress.value = hovered ? view.progress : 0;
      const scale = Math.max(0.001, (0.4 + 0.6 * Math.max(0, Math.min(1.6, k))) * (hovered ? 1.12 : 1)) * this.size;
      b.mesh.position.copy(pos);
      b.mesh.scale.setScalar(scale);
      m.uSolid.value = Math.max(0.01, -pos.z - BIAS);
      // Nom au-dessus, une fois la bulle en place.
      const l = b.label.material.uniforms;
      b.label.position.copy(pos).add(new THREE.Vector3(0, BUBBLE_R * 2.0 * scale, 0));
      b.label.scale.setScalar(this.size);
      l.uSolid.value = m.uSolid.value;
      l.uOpacity.value = this.opened ? Math.min(1, Math.max(0, k * 2 - 1)) * (hovered || on ? 1 : 0.6) * (1 - fold) : 0;
    });
  }
}

const easeIn = (t: number) => t * t;
const easeOutBack = (t: number) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

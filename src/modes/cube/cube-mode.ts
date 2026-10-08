// Mode cube : des cubes holographiques flottent dans le reflet, en apesanteur. On les touche, on
// les pousse, on leur met des pichenettes, on les attrape (pincement ou main qui se referme), on
// les lance et on les rattrape. Au contact, le cube s'illumine là où les doigts le touchent et
// tinte ; tenu, il s'allume tout entier et sa lumière déborde sur la main (d'après la démo HoloLens
// 2 « Touching Holograms » d'Oscar Salandin).
//
// Comme pour le menu, tout se joue d'après le reflet dessiné : les mains sont prises à l'écran
// (leur profondeur mesurée est parfois très fausse) et ramenées, sur le regard de l'œil, au plan
// où vivent les cubes (un peu devant le reflet du corps, là où sont les mains). Physique :
// cannon-es (chocs, rotations) ; les doigts sont des sphères qui poussent les cubes.
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { glowMaterial, type MirrorWorld, type SharedUniforms } from "../fairy/world";

/** Une main dans le reflet dessiné (px CSS) et ce qu'elle fait. */
export interface HandInput {
  side: "left" | "right";
  /** Bouts des doigts (pouce → auriculaire), centre de la paume, poignet, base du majeur. */
  tips: [number, number][];
  palm: [number, number];
  wrist: [number, number];
  middle: [number, number];
  pinch: boolean;
  closed: boolean;
}

/** Arête des cubes (m) et leur couleur (dégradé des arêtes). */
const SIZES = [0.15, 0.12, 0.1];
const COLOR_A = new THREE.Color("#38e8ff");
const COLOR_B = new THREE.Color("#a66bff");
/** Plan des cubes : un peu devant le reflet du corps (m), là où sont les mains. */
const FRONT = 0.15;
/** Les cubes restent dans une tranche de profondeur autour de ce plan (m). */
const DEPTH_BAND = 0.25;
/** Doigts : rayon des sphères (m), vitesse max (m/s : le suivi saute parfois). */
const TIP_R = 0.018;
const PALM_R = 0.04;
const MAX_FINGER_SPEED = 3.5;
/** Contact (m) : en deçà, le cube s'illumine sous le doigt. */
const TOUCH = 0.035;
/** Saisie : le point de pincement (ou la paume) à moins de ça du cube (× demi-arête). */
const GRAB_REACH = 1.5;

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

/** Cube holographique : verre teinté, arêtes lumineuses, taches de lumière sous les doigts. */
function cubeMaterial(shared: SharedUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...shared,
      uHasOcc: { value: 0 },
      uSolid: { value: 1 },
      uColorA: { value: COLOR_A },
      uColorB: { value: COLOR_B },
      uLight: { value: 0 },
      uAppear: { value: 0 },
      uSize: { value: 0.12 },
      uContacts: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 0, 0)) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${OCCLUSION}
      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform float uLight;
      uniform float uAppear;
      uniform float uSize;
      uniform vec4 uContacts[4];
      varying vec3 vLocal;
      void main() {
        vec3 a = abs(vLocal) * 2.0;
        // Sur une face, la 2e plus grande coordonnée vaut ~1 près d'une arête.
        float e = max(min(a.x, a.y), max(min(a.y, a.z), min(a.x, a.z)));
        float edge = smoothstep(0.84, 0.985, e);
        float corner = smoothstep(0.9, 1.0, min(a.x, min(a.y, a.z)));
        vec3 col = mix(uColorA, uColorB, clamp(vLocal.y + 0.5 + 0.3 * vLocal.x, 0.0, 1.0));
        // Taches de lumière sous les doigts (positions locales en mètres).
        float spot = 0.0;
        for (int i = 0; i < 4; i++) {
          vec3 d = vLocal * uSize - uContacts[i].xyz;
          spot += uContacts[i].w * exp(-dot(d, d) / (0.025 * 0.025));
        }
        float fill = 0.05 + 0.22 * uLight;
        vec3 c = col * (edge * (0.9 + 1.2 * uLight) + fill + corner * 0.6) + mix(col, vec3(1.0), 0.6) * spot * 1.6;
        float alpha = clamp(edge * 0.9 + fill + spot, 0.0, 1.0);
        float v = visible() * uAppear;
        gl_FragColor = vec4(c * v, alpha * v);
      }`,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

interface Cube {
  body: CANNON.Body;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  glow: THREE.Mesh;
  size: number;
  light: number;
  /** Main qui le tient, et comment (décalage, orientation de départ). */
  heldBy: "left" | "right" | null;
  grabOffset: THREE.Vector3;
  grabAngle: number;
  grabQuat: THREE.Quaternion;
  touchedAt: number;
}

interface Finger {
  body: CANNON.Body;
  last: THREE.Vector3 | null;
  lastAt: number;
}

export class CubeMode {
  readonly id = "cube";
  private active = false;
  private physics = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
  private cubes: Cube[] = [];
  private fingers = new Map<string, Finger>();
  private group = new THREE.Group();
  private plane = -2;
  private enteredAt = 0;
  private lastFrame = 0;
  private audio: AudioContext | null = null;
  private holding: Record<"left" | "right", Cube | null> = { left: null, right: null };
  /** Les cubes naissent à la première image où l'œil est connu. */
  private needSpawn = false;

  constructor(
    private world: MirrorWorld,
    private hands: () => HandInput[],
  ) {
    this.physics.defaultContactMaterial.restitution = 0.55;
    this.physics.defaultContactMaterial.friction = 0.2;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const size of SIZES) {
      const body = new CANNON.Body({ mass: size * 10, shape: new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2)), linearDamping: 0.35, angularDamping: 0.3 });
      const mesh = new THREE.Mesh(geo, cubeMaterial(world.shared));
      mesh.scale.setScalar(size);
      mesh.material.uniforms.uSize.value = size;
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), glowMaterial(world.shared, COLOR_A.clone().lerp(new THREE.Color(1, 1, 1), 0.4), 3.5, 0));
      this.group.add(mesh, glow);
      const cube: Cube = { body, mesh, glow, size, light: 0, heldBy: null, grabOffset: new THREE.Vector3(), grabAngle: 0, grabQuat: new THREE.Quaternion(), touchedAt: 0 };
      body.addEventListener("collide", (e: { body: CANNON.Body; contact: CANNON.ContactEquation }) => this.onCollide(cube, e));
      this.physics.addBody(body);
      this.cubes.push(cube);
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
    this.enteredAt = now;
    this.lastFrame = now;
    this.group.visible = true;
    this.needSpawn = true;
  }

  /** Un cube est tenu (le geste du menu, poing qui s'ouvre, ne doit pas partir en le lâchant). */
  get holdsCube(): boolean {
    return this.active && (this.holding.left !== null || this.holding.right !== null);
  }

  exit(): void {
    this.active = false;
    this.group.visible = false;
    this.holding = { left: null, right: null };
    for (const c of this.cubes) c.heldBy = null;
  }

  /** Les cubes apparaissent devant la personne, au milieu de l'écran, en tournant doucement. */
  private spawn(): void {
    this.plane = -this.world.camera.position.z + FRONT;
    const [sw] = this.world.screenMeters;
    const center = this.unproject(0.5 * window.innerWidth, 0.42 * window.innerHeight);
    const spread = Math.min(0.25, sw * 0.3);
    this.cubes.forEach((c, i) => {
      const x = center.x + (i - 1) * spread;
      const y = center.y + (i % 2 ? 0.08 : -0.04);
      c.body.position.set(x, y, this.plane);
      c.body.velocity.set(0, 0, 0);
      c.body.angularVelocity.set(0.3 + i * 0.2, 0.5 - i * 0.15, 0.1);
      c.body.quaternion.setFromEuler(0.4 * i, 0.7, 0.2);
      c.light = 0;
      c.heldBy = null;
    });
  }

  /** Point de l'écran (px CSS) → 3D sur le plan des cubes, sur le regard de l'œil. */
  private unproject(x: number, y: number): THREE.Vector3 {
    const [sw, sh, gap] = this.world.screenMeters;
    const eye = this.world.camera.position;
    const glass = new THREE.Vector3((x / window.innerWidth) * sw, -(y / window.innerHeight) * sh, -gap);
    return eye.clone().lerp(glass, (this.plane - eye.z) / (glass.z - eye.z));
  }

  /** Une image : mains → doigts physiques, saisies, physique, apparence. */
  frame(now: number): void {
    if (!this.active || !this.world.ready) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    if (this.needSpawn) {
      this.needSpawn = false;
      this.enteredAt = now;
      this.spawn();
    }
    this.plane += (-this.world.camera.position.z + FRONT - this.plane) * 0.02; // suit le reflet, très lentement
    const hands = this.hands();
    this.updateFingers(hands, now, dt);
    this.updateGrabs(hands, dt);
    this.keepInView();
    this.physics.step(1 / 60, dt, 4);
    this.render(hands, now, dt);
  }

  // --- Doigts -----------------------------------------------------------------------------------

  private finger(key: string, radius: number): Finger {
    let f = this.fingers.get(key);
    if (!f) {
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, shape: new CANNON.Sphere(radius) });
      this.physics.addBody(body);
      f = { body, last: null, lastAt: 0 };
      this.fingers.set(key, f);
    }
    return f;
  }

  /** Chaque bout de doigt et la paume deviennent des sphères qui suivent la main (et poussent). */
  private updateFingers(hands: HandInput[], now: number, dt: number): void {
    const seen = new Set<string>();
    for (const h of hands) {
      const held = this.holding[h.side] !== null;
      const pts: [string, [number, number], number][] = [...h.tips.map((t, i) => [`${h.side}/${i}`, t, TIP_R] as [string, [number, number], number]), [`${h.side}/palm`, h.palm, PALM_R]];
      for (const [key, px, r] of pts) {
        const f = this.finger(key, r);
        seen.add(key);
        const p = this.unproject(px[0], px[1]);
        const v = f.last && now - f.lastAt < 150 ? p.clone().sub(f.last).divideScalar(dt) : new THREE.Vector3();
        if (v.length() > MAX_FINGER_SPEED) v.setLength(MAX_FINGER_SPEED);
        f.body.position.set(p.x, p.y, p.z);
        f.body.velocity.set(v.x, v.y, v.z);
        // La main qui tient un cube ne le pousse pas.
        f.body.collisionResponse = !held;
        f.last = p;
        f.lastAt = now;
      }
    }
    // Doigts disparus : hors du jeu.
    for (const [key, f] of this.fingers) {
      if (seen.has(key)) continue;
      f.body.position.set(0, 0, 100);
      f.body.velocity.set(0, 0, 0);
      f.last = null;
    }
  }

  // --- Saisie, lancer -----------------------------------------------------------------------------

  private updateGrabs(hands: HandInput[], dt: number): void {
    for (const side of ["left", "right"] as const) {
      const h = hands.find((x) => x.side === side);
      const held = this.holding[side];
      const gripping = !!h && (h.pinch || h.closed);
      if (held && (!gripping || !h)) {
        // Lâché : il garde la vitesse de la main (lancer).
        held.heldBy = null;
        this.holding[side] = null;
        this.tone([1320, 990], 0.05);
        continue;
      }
      if (!h) continue;
      const point = h.pinch ? this.unproject((h.tips[0][0] + h.tips[1][0]) / 2, (h.tips[0][1] + h.tips[1][1]) / 2) : this.unproject(h.palm[0], h.palm[1]);
      const angle = Math.atan2(h.middle[1] - h.wrist[1], h.middle[0] - h.wrist[0]);
      if (!held && gripping) {
        // Le cube le plus proche du point de saisie, s'il est à portée.
        let best: Cube | null = null;
        let bestD = Infinity;
        for (const c of this.cubes) {
          if (c.heldBy) continue;
          const d = point.distanceTo(new THREE.Vector3(c.body.position.x, c.body.position.y, c.body.position.z));
          if (d < (c.size / 2) * GRAB_REACH + 0.03 && d < bestD) {
            best = c;
            bestD = d;
          }
        }
        if (best) {
          best.heldBy = side;
          this.holding[side] = best;
          const pos = best.body.position;
          best.grabOffset.set(pos.x - point.x, pos.y - point.y, 0).multiplyScalar(0.5);
          best.grabAngle = angle;
          best.grabQuat.set(best.body.quaternion.x, best.body.quaternion.y, best.body.quaternion.z, best.body.quaternion.w);
          this.tone([1568, 2093], 0.07);
        }
        continue;
      }
      if (held) {
        // Tenu : suit le point de saisie (par la vitesse, pour garder l'élan au lâcher) et tourne
        // avec la main (dans le plan du miroir).
        const target = point.clone().add(held.grabOffset);
        const pos = held.body.position;
        const v = new THREE.Vector3(target.x - pos.x, target.y - pos.y, this.plane - pos.z).divideScalar(Math.max(dt, 1 / 60) * 2.5);
        if (v.length() > MAX_FINGER_SPEED * 1.4) v.setLength(MAX_FINGER_SPEED * 1.4);
        held.body.velocity.set(v.x, v.y, v.z);
        const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -(angle - held.grabAngle));
        const want = turn.multiply(held.grabQuat);
        const q = held.body.quaternion;
        const cur = new THREE.Quaternion(q.x, q.y, q.z, q.w);
        const next = cur.clone().slerp(want, 0.35);
        q.set(next.x, next.y, next.z, next.w);
        held.body.angularVelocity.scale(0.8, held.body.angularVelocity);
      }
    }
  }

  /** Les cubes restent dans l'écran et près du plan (bords et profondeur : ressorts doux). */
  private keepInView(): void {
    const tl = this.unproject(0, 0);
    const br = this.unproject(window.innerWidth, window.innerHeight);
    for (const c of this.cubes) {
      const p = c.body.position;
      const m = c.size * 0.7;
      const push = (over: number) => over * 30 * c.body.mass;
      if (p.x < tl.x + m) c.body.applyForce(new CANNON.Vec3(push(tl.x + m - p.x), 0, 0));
      if (p.x > br.x - m) c.body.applyForce(new CANNON.Vec3(-push(p.x - (br.x - m)), 0, 0));
      if (p.y > tl.y - m) c.body.applyForce(new CANNON.Vec3(0, -push(p.y - (tl.y - m)), 0));
      if (p.y < br.y + m) c.body.applyForce(new CANNON.Vec3(0, push(br.y + m - p.y), 0));
      const dz = p.z - this.plane;
      if (Math.abs(dz) > DEPTH_BAND) c.body.applyForce(new CANNON.Vec3(0, 0, -Math.sign(dz) * push(Math.abs(dz) - DEPTH_BAND)));
      else c.body.applyForce(new CANNON.Vec3(0, 0, -dz * 2 * c.body.mass)); // revient doucement au plan
    }
  }

  private onCollide(cube: Cube, e: { body: CANNON.Body; contact: CANNON.ContactEquation }): void {
    const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
    const now = performance.now();
    if (speed < 0.15 || now - cube.touchedAt < 120) return;
    cube.touchedAt = now;
    cube.light = Math.max(cube.light, Math.min(1, 0.4 + speed * 0.4));
    const isFinger = e.body.type === CANNON.Body.KINEMATIC;
    // Tintement : plus aigu pour les petits cubes ; un choc entre cubes est plus sourd.
    const base = 1400 / (cube.size / 0.1);
    this.tone(isFinger ? [base, base * 1.5] : [base * 0.5], Math.min(0.08, 0.02 + speed * 0.03));
  }

  // --- Apparence ----------------------------------------------------------------------------------

  private render(hands: HandInput[], now: number, dt: number): void {
    const appear = Math.min(1, (now - this.enteredAt) / 500);
    // Bouts des doigts en 3D (pour les taches de lumière).
    const tips: THREE.Vector3[] = [];
    for (const h of hands) for (const t of h.tips) tips.push(this.unproject(t[0], t[1]));
    for (const c of this.cubes) {
      const p = c.body.position;
      const q = c.body.quaternion;
      c.mesh.position.set(p.x, p.y, p.z);
      c.mesh.quaternion.set(q.x, q.y, q.z, q.w);
      const u = c.mesh.material.uniforms;
      // Contacts : doigts à moins de TOUCH de la surface, en coordonnées du cube.
      const inv = c.mesh.quaternion.clone().invert();
      const half = c.size / 2;
      const contacts: { local: THREE.Vector3; w: number; world: THREE.Vector3 }[] = [];
      for (const t of tips) {
        const local = t.clone().sub(c.mesh.position).applyQuaternion(inv);
        const out = new THREE.Vector3(Math.max(0, Math.abs(local.x) - half), Math.max(0, Math.abs(local.y) - half), Math.max(0, Math.abs(local.z) - half)).length();
        if (out > TOUCH) continue;
        const onSurface = local.clone().clampScalar(-half, half);
        contacts.push({ local: onSurface, w: 1 - out / TOUCH, world: t });
      }
      contacts.sort((a, b) => b.w - a.w);
      (u.uContacts.value as THREE.Vector4[]).forEach((v, i) => {
        const k = contacts[i];
        v.set(k?.local.x ?? 0, k?.local.y ?? 0, k?.local.z ?? 0, k ? k.w * 0.9 : 0);
      });
      const target = c.heldBy ? 1 : contacts.length ? 0.55 : 0;
      c.light += (Math.max(target, c.light * Math.exp(-dt * 3)) - c.light) * Math.min(1, dt * 12);
      u.uLight.value = c.light;
      u.uAppear.value = appear * (0.7 + 0.3 * Math.sin(Math.min(1, appear) * Math.PI * 0.5));
      // Tenu : jamais découpé par la main qui le tient ; sinon caché derrière le corps.
      u.uHasOcc.value = c.heldBy ? 0 : this.world.shared.uHasOcc.value;
      u.uSolid.value = Math.max(0.01, -p.z);
      // Sa lumière déborde sur la main (halo au point de contact, ou autour de lui s'il est tenu).
      const at = contacts[0]?.world ?? c.mesh.position;
      c.glow.position.copy(at);
      const g = (c.glow.material as THREE.ShaderMaterial).uniforms;
      g.uIntensity.value = c.light * 1.1 * appear;
      c.glow.scale.setScalar(0.6 + c.size * 4 * (0.6 + 0.4 * c.light));
    }
  }

  /** Petites notes de verre. */
  private tone(freqs: number[], gain: number): void {
    try {
      this.audio ??= new AudioContext();
      const ctx = this.audio;
      const t0 = ctx.currentTime + 0.005;
      freqs.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * 0.05);
        g.gain.linearRampToValueAtTime(gain, t0 + i * 0.05 + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.05 + 0.5);
        o.connect(g).connect(ctx.destination);
        o.start(t0 + i * 0.05);
        o.stop(t0 + i * 0.05 + 0.55);
      });
    } catch {
      // Pas de son.
    }
  }
}

// Mode danse : on danse côte à côte avec son double doré, sur une musique générée en direct.
//
//   Accueil : le double invite en levant les bras ; lever les deux bras (ou Espace) lance la
//             musique. Décompte « 3, 2, 1, Danse ! » sur les temps.
//   Danse   : le double enchaîne les mouvements ; les prochains défilent en bas en petites
//             silhouettes. À chaque pose marquée : « Parfait / Super / Bien / Oups » au-dessus de
//             la tête, étincelles qui partent des mains, squelette qui flashe en or sur un parfait,
//             combo. Un halo pulse au sol sous chacun, sur le rythme.
//   Fin     : score et étoiles ; lever les bras pour rejouer.
//
// Tout ce qui bouge est dessiné par le moteur néon ; la page ne porte que quelques textes.
import { GHOST_COLOR } from "../../render/figures";
import { hexToRgb, type RGB, type SegmentBuffer } from "../../render/segments";
import type { Scene, Track } from "../../scene";
import { STRIDE } from "../../vision/protocol";
import { GhostPlacer, type VisibleArea } from "../ghost";
import { Choreography, invitePose, poseScore, rate, RATINGS, skeleton, type KeyPose, type Rating } from "./choreo";
import { BEAT, Groove, SONG_SECONDS } from "./music";

type State = "idle" | "playing" | "results";

/** Fenêtre de notation autour de chaque pose : on réagit au double, donc surtout après le temps. */
const WINDOW_BEFORE = 0.15;
const WINDOW_AFTER = 0.4;
/** Bras levés tenus ce temps pour lancer la musique. */
const ARMS_UP_MS = 450;
/** Plus personne pendant la danse : on arrête. */
const AWAY_MS = 4000;
/** Les prochaines poses apparaissent en bas ce nombre de temps à l'avance. */
const LEAD_BEATS = 4;
const RESULTS_MIN_MS = 2500;
const RESULTS_MAX_MS = 25000;

const COLOR: Record<Rating | "user" | "ghost" | "marker", RGB> = {
  parfait: hexToRgb("#ffd36b"),
  super: hexToRgb("#5ef2ff"),
  bien: hexToRgb("#a78bfa"),
  oups: hexToRgb("#ff7a8a"),
  user: hexToRgb("#5ef2ff"),
  ghost: hexToRgb("#ffd36b"),
  marker: hexToRgb("#fff1c9"),
};

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: RGB;
}

export class DanceMode {
  readonly id = "dance";
  private active = false;
  private state: State = "idle";
  private stateSince = 0;
  private music = new Groove();
  private choreo = new Choreography();
  private placer = new GhostPlacer();
  private idleStart = 0;
  private armsUpSince = 0;
  private personSeenAt = 0;
  private hitIndex = 0;
  private best = 0;
  private ratings: (Rating | null)[] = [];
  private points = 0;
  private rawPoints = 0;
  private combo = 0;
  private maxCombo = 0;
  private counts: Record<Rating, number> = { parfait: 0, super: 0, bien: 0, oups: 0 };
  private sparks: Spark[] = [];
  private halo: { at: number; color: RGB } | null = null;
  private flash: { body: Track; color: number; until: number } | null = null;
  private lastMove: string | null = null;
  private countdownShown = "";
  /** Où se tient le double (px de l'image caméra), pour son halo. */
  private ghostFeet: [number, number] | null = null;
  private ghostSize = 0;

  private root: HTMLElement;
  private scoreEl: HTMLElement;
  private comboEl: HTMLElement;
  private moveEl: HTMLElement;
  private centerEl: HTMLElement;
  private hintEl: HTMLElement;
  private ratingEl: HTMLElement;

  constructor(
    private scene: Scene,
    private ghost: Scene,
    private frameSize: () => [number, number],
    private visible: () => VisibleArea,
    private toScreen: (x: number, y: number) => [number, number],
    private screen: () => [number, number],
  ) {
    this.root = document.createElement("div");
    this.root.id = "dance-ui";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <div class="dance-top">
        <div class="dance-score">0</div>
        <div class="dance-combo"></div>
        <div class="dance-move"></div>
      </div>
      <div class="dance-center"></div>
      <div class="dance-hint"></div>
      <div class="dance-rating"></div>`;
    const $ = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.scoreEl = $(".dance-score");
    this.comboEl = $(".dance-combo");
    this.moveEl = $(".dance-move");
    this.centerEl = $(".dance-center");
    this.hintEl = $(".dance-hint");
    this.ratingEl = $(".dance-rating");
    document.body.append(this.root);
  }

  enter(now = performance.now()): void {
    this.active = true;
    this.root.classList.remove("hidden");
    this.ghost.clear("pose");
    this.ghost.clear("hands");
    this.placer.reset();
    this.setState("idle", now);
  }

  exit(): void {
    this.active = false;
    this.music.stop();
    this.endFlash();
    this.root.classList.add("hidden");
    this.ghost.clear("pose");
    this.ghost.clear("hands");
    this.sparks = [];
  }

  onKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    if (e.key === " ") {
      if (this.state === "playing") this.setState("idle", performance.now());
      else void this.start(performance.now());
      return true;
    }
    return false;
  }

  /** Le double danse : redessiner à la cadence de l'écran. */
  get animating(): boolean {
    return this.active;
  }

  // --- Déroulé ----------------------------------------------------------------------------------

  update(now: number): void {
    if (!this.active) return;
    const body = this.body();
    if (body) this.personSeenAt = now;
    if (this.flash && now > this.flash.until) this.endFlash();

    if (this.state === "idle" || this.state === "results") {
      if (this.state === "results" && now - this.stateSince > RESULTS_MAX_MS) this.setState("idle", now);
      const canStart = this.state === "idle" || now - this.stateSince > RESULTS_MIN_MS;
      if (body && canStart && this.armsUp(body)) {
        this.armsUpSince ||= now;
        if (now - this.armsUpSince >= ARMS_UP_MS) void this.start(now);
      } else this.armsUpSince = 0;
      if (this.state === "idle") this.setHint(this.idleHint(body));
      return;
    }

    // Danse.
    const t = this.music.time(now);
    if (t === null || t > SONG_SECONDS + 0.5) return this.showResults(now);
    if (now - this.personSeenAt > AWAY_MS) {
      this.setState("idle", now);
      return;
    }
    const beat = t / BEAT;
    this.countdown(beat);
    const move = beat >= 15.5 ? this.choreo.moveAt(beat) : null;
    if (move !== this.lastMove) {
      this.lastMove = move;
      this.moveEl.textContent = move ?? "";
      this.moveEl.classList.remove("pop");
      void this.moveEl.offsetWidth; // relance l'animation
      if (move) this.moveEl.classList.add("pop");
    }
    // Notation : meilleure ressemblance pendant la fenêtre de chaque pose.
    const hits = this.choreo.hits;
    while (this.hitIndex < hits.length) {
      const hit = hits[this.hitIndex];
      const at = hit.beat * BEAT;
      if (t < at - WINDOW_BEFORE) break;
      if (t <= at + WINDOW_AFTER) {
        if (body) this.best = Math.max(this.best, poseScore(this.userPoint(body), hit.pose));
        break;
      }
      this.judge(this.best, now, body);
      this.best = 0;
      this.hitIndex++;
    }
  }

  private async start(now: number): Promise<void> {
    if (this.state === "playing") return;
    this.armsUpSince = 0;
    this.hitIndex = 0;
    this.best = 0;
    this.ratings = this.choreo.hits.map(() => null);
    this.points = 0;
    this.rawPoints = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { parfait: 0, super: 0, bien: 0, oups: 0 };
    this.lastMove = null;
    this.countdownShown = "";
    this.scoreEl.textContent = "0";
    this.comboEl.textContent = "";
    this.setState("playing", now);
    const sound = await this.music.start(performance.now());
    if (!sound) this.setHint("Pas de son : la danse continue en silence");
  }

  private setState(state: State, now: number): void {
    this.state = state;
    this.stateSince = now;
    this.root.dataset.state = state;
    if (state !== "playing") this.music.stop();
    if (state === "idle") {
      this.idleStart = now;
      this.centerEl.innerHTML = "";
      this.moveEl.textContent = "";
      this.lastMove = null;
    }
    if (state === "playing") this.setHint("");
  }

  private countdown(beat: number): void {
    // Mesure 3 (temps 12 à 15) : « 3, 2, 1, Danse ! » ; avant : « Prêt ? » puis « Suis ton double ».
    let text = "";
    if (beat >= 4 && beat < 8) text = "Prêt ?";
    else if (beat >= 8 && beat < 12) text = "Suis ton double";
    else if (beat >= 12 && beat < 16) text = ["3", "2", "1", "Danse !"][Math.floor(beat) - 12];
    if (text === this.countdownShown) return;
    this.countdownShown = text;
    this.centerEl.innerHTML = text ? `<div class="dance-count">${text}</div>` : "";
  }

  private judge(score: number, now: number, body: Track | null): void {
    const r = rate(score);
    this.ratings[this.hitIndex] = r.rating;
    this.counts[r.rating]++;
    if (r.rating === "oups") this.combo = 0;
    else if (r.rating !== "bien") this.combo++;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    const multiplier = 1 + Math.min(3, Math.floor(this.combo / 8));
    this.points += r.points * multiplier;
    this.rawPoints += r.points;
    this.scoreEl.textContent = this.points.toLocaleString("fr-FR");
    this.comboEl.textContent = this.combo >= 3 ? `combo ×${this.combo}` : "";
    this.comboEl.classList.toggle("hot", multiplier > 1);

    // Mot au-dessus de la tête.
    const [w, h] = this.frameSize();
    let head: [number, number] = [this.screen()[0] / 2, this.screen()[1] * 0.3];
    if (body) {
      const p = body.points;
      const shoulders = Math.hypot((p[11 * STRIDE] - p[12 * STRIDE]) * w, (p[11 * STRIDE + 1] - p[12 * STRIDE + 1]) * h);
      const nose = this.toScreen(p[0], p[1]);
      head = [nose[0], nose[1] - this.screenScale(shoulders) * 0.75];
    }
    this.ratingEl.textContent = r.label;
    this.ratingEl.className = `dance-rating ${r.rating}`;
    this.ratingEl.style.transform = `translate(${head[0]}px, ${head[1]}px) translate(-50%, -100%)`;
    void this.ratingEl.offsetWidth;
    this.ratingEl.classList.add("show");

    // Halo, étincelles, flash doré, carillon.
    this.halo = { at: now, color: COLOR[r.rating] };
    if (body && (r.rating === "parfait" || r.rating === "super")) {
      for (const i of [15, 16]) {
        const p = body.points;
        if (p[i * STRIDE + 3] < 0.4) continue;
        this.burst(this.toScreen(p[i * STRIDE], p[i * STRIDE + 1]), COLOR[r.rating], r.rating === "parfait" ? 14 : 8, now);
      }
    }
    if (body && r.rating === "parfait") {
      this.endFlash();
      this.flash = { body, color: body.color, until: now + 260 };
      body.color = GHOST_COLOR;
      this.music.chime();
    }
  }

  private showResults(now: number): void {
    if (this.state !== "playing") return;
    // Dernières poses non jugées (fin du morceau).
    const body = this.body();
    while (this.hitIndex < this.choreo.hits.length) {
      this.judge(this.best, now, body);
      this.best = 0;
      this.hitIndex++;
    }
    this.setState("results", now);
    const share = this.rawPoints / (this.choreo.hits.length * 100);
    const stars = share >= 0.75 ? 3 : share >= 0.5 ? 2 : share >= 0.25 ? 1 : 0;
    const title = ["Pas mal pour un début", "Bien joué !", "Super danse !", "Incroyable !"][stars];
    this.centerEl.innerHTML = `
      <div class="dance-results">
        <div class="dance-title">${title}</div>
        <div class="dance-stars">${[0, 1, 2].map((i) => `<span class="${i < stars ? "on" : ""}">★</span>`).join("")}</div>
        <div class="dance-final">${this.points.toLocaleString("fr-FR")}</div>
        <div class="dance-detail">${RATINGS.map((r) => `${r.label.replace(" !", "")} ${this.counts[r.rating]}`).join(" · ")} · meilleur combo ${this.maxCombo}</div>
      </div>`;
    this.moveEl.textContent = "";
    this.comboEl.textContent = "";
    this.setHint("Lève les deux bras pour rejouer");
  }

  private idleHint(body: Track | null): string {
    if (!body) return "Viens devant le miroir pour danser";
    const p = body.points;
    const feet = p[27 * STRIDE + 3] > 0.5 && p[28 * STRIDE + 3] > 0.5;
    return feet ? "Lève les deux bras pour lancer la musique" : "Recule un peu, que je te voie en entier… puis lève les bras";
  }

  // --- La personne ------------------------------------------------------------------------------

  private body(): Track | null {
    let body: Track | null = null;
    for (const b of this.scene.bodies) if (b.lostAt === null) body = b;
    return body;
  }

  /** Point i de la personne dans le repère du miroir (px, x vers la droite de l'écran). */
  private userPoint(body: Track): (i: number) => [number, number] | null {
    const [w, h] = this.frameSize();
    const v = body.smoother.value;
    const vis = body.points;
    return (i) => (vis[i * STRIDE + 3] < 0.4 ? null : [-v[i * STRIDE] * w, v[i * STRIDE + 1] * h]);
  }

  /** Les deux poignets au-dessus du nez. */
  private armsUp(body: Track): boolean {
    const p = body.points;
    const ok = (i: number) => p[i * STRIDE + 3] > 0.4 && p[i * STRIDE + 1] < p[1];
    return p[3] > 0.4 && ok(15) && ok(16);
  }

  private endFlash(): void {
    if (this.flash) this.flash.body.color = this.flash.color;
    this.flash = null;
  }

  // --- Le double --------------------------------------------------------------------------------

  animate(now: number): void {
    if (!this.active) return;
    const [w, h] = this.frameSize();
    let pose: KeyPose;
    if (this.state === "playing") {
      const t = this.music.time(now) ?? 0;
      pose = this.choreo.poseAt(Math.max(0, t / BEAT));
    } else pose = invitePose((now - this.idleStart) / 1000 / BEAT);
    const body = this.body();
    let anchor = null;
    if (body) {
      const v = body.smoother.value;
      const l = [v[11 * STRIDE] * w, v[11 * STRIDE + 1] * h];
      const r = [v[12 * STRIDE] * w, v[12 * STRIDE + 1] * h];
      anchor = { center: [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] as [number, number], scale: Math.max(Math.hypot(l[0] - r[0], l[1] - r[1]), 1) };
    }
    // Bras écartés : le double occupe ~1,9 largeur d'épaules de chaque côté.
    const a = this.placer.place(now, anchor, w, h, this.visible(), 1.9);
    const pts = skeleton(pose);
    const out = new Float32Array(33 * 4);
    pts.forEach(([x, y], i) => out.set([(a.x - x * a.size) / w, (a.y + y * a.size) / h, 0, 1], i * 4));
    this.ghost.update("pose", [{ points: out, key: "d0" }], now);
    for (const t of this.ghost.tracks.pose.values()) t.color = GHOST_COLOR;
    this.ghostFeet = [(out[27 * 4] + out[28 * 4]) / 2, (out[27 * 4 + 1] + out[28 * 4 + 1]) / 2 + 0.06 * (a.size / h)];
    this.ghostSize = a.size;
  }

  // --- Dessin -----------------------------------------------------------------------------------

  draw(out: SegmentBuffer, now: number): void {
    if (!this.active) return;
    const [sw, sh] = this.screen();
    const unit = Math.min(sw, sh);
    const width = Math.max(1.5, unit * 0.0025);
    const t = this.state === "playing" ? this.music.time(now) : null;
    const beat = t !== null ? t / BEAT : (now - this.idleStart) / 1000 / BEAT;
    const pulse = Math.exp(-(beat - Math.floor(beat)) * 5); // éclat sur chaque temps

    // Halos au sol, sur le rythme.
    const body = this.body();
    const [w, h] = this.frameSize();
    if (body) {
      const p = body.points;
      if (p[27 * STRIDE + 3] > 0.5 && p[28 * STRIDE + 3] > 0.5) {
        const feet = this.toScreen((p[27 * STRIDE] + p[28 * STRIDE]) / 2, (p[27 * STRIDE + 1] + p[28 * STRIDE + 1]) / 2 + 0.015);
        const shoulders = Math.hypot((p[11 * STRIDE] - p[12 * STRIDE]) * w, (p[11 * STRIDE + 1] - p[12 * STRIDE + 1]) * h);
        const rx = this.screenScale(shoulders) * 1.3;
        const flash = this.halo ? Math.max(0, 1 - (now - this.halo.at) / 500) : 0;
        const color = flash > 0 && this.halo ? this.halo.color : COLOR.user;
        ellipse(out, feet[0], feet[1], rx * (1 + 0.25 * flash), rx * 0.2 * (1 + 0.25 * flash), width * 1.2, color, 0.35 + 0.5 * pulse + 1.2 * flash);
      }
    }
    if (this.ghostFeet) {
      const feet = this.toScreen(this.ghostFeet[0], this.ghostFeet[1]);
      const rx = this.screenScale(this.ghostSize) * 1.3;
      ellipse(out, feet[0], feet[1], rx, rx * 0.2, width * 1.2, COLOR.ghost, 0.3 + 0.5 * pulse);
    }

    // Lancer : un anneau se remplit autour de chaque poignet levé.
    if (this.state !== "playing" && this.armsUpSince && body) {
      const k = Math.min(1, (now - this.armsUpSince) / ARMS_UP_MS);
      for (const i of [15, 16]) {
        const [x, y] = this.toScreen(body.points[i * STRIDE], body.points[i * STRIDE + 1]);
        ring(out, x, y, unit * 0.035, 0, k, width * 1.6, COLOR.parfait, 1.5);
      }
    }

    if (this.state === "playing" && t !== null) this.drawTimeline(out, beat, pulse, sw, sh, unit, width);

    // Étincelles.
    this.sparks = this.sparks.filter((s) => now - s.born < s.life);
    for (const s of this.sparks) {
      const age = (now - s.born) / 1000;
      const k = 1 - (now - s.born) / s.life;
      const x = s.x + s.vx * age;
      const y = s.y + s.vy * age + 400 * age * age; // retombent doucement
      out.line(x, y, x - s.vx * 0.025, y - (s.vy + 800 * age) * 0.025, width * 1.1, s.color, 1.6 * k);
    }
  }

  /** Les prochaines poses défilent en bas vers un repère, et y arrivent pile sur le temps. */
  private drawTimeline(out: SegmentBuffer, beat: number, pulse: number, sw: number, sh: number, unit: number, width: number): void {
    const y = sh * 0.9;
    const markerX = sw * 0.22;
    const span = sw * 0.68;
    const size = unit * 0.07;
    ring(out, markerX, y, size * 0.62 * (1 + 0.06 * pulse), 0, 1, width * 1.2, COLOR.marker, 0.5 + 0.8 * pulse);
    // Avancée du morceau : un fil en bas de l'écran.
    const progress = Math.min(1, (beat * BEAT) / SONG_SECONDS);
    out.line(sw * 0.1, sh * 0.975, sw * 0.9, sh * 0.975, width * 0.8, COLOR.marker, 0.15);
    out.line(sw * 0.1, sh * 0.975, sw * (0.1 + 0.8 * progress), sh * 0.975, width * 1.2, COLOR.ghost, 0.7);

    const hits = this.choreo.hits;
    for (let i = 0; i < hits.length; i++) {
      const d = hits[i].beat - beat;
      if (d > LEAD_BEATS || d < -1.5) continue;
      const x = markerX + (d / LEAD_BEATS) * span;
      const rating = this.ratings[i];
      const fade = d >= 0 ? Math.min(1, (LEAD_BEATS - d) / 1) : Math.max(0, 1 + d / 1.5);
      const color = rating ? COLOR[rating] : COLOR.ghost;
      const glow = rating && d < 0 ? 1.6 : d < 0.5 ? 1.2 : 0.8;
      picto(out, hits[i].pose, x, y, size, width, color, glow * fade);
    }
  }

  /** px de l'image caméra → px d'écran. */
  private screenScale(px: number): number {
    const [w] = this.frameSize();
    const a = this.toScreen(0.5, 0.5);
    const b = this.toScreen(0.5 + 0.01, 0.5);
    return (px * Math.hypot(b[0] - a[0], b[1] - a[1])) / (0.01 * w);
  }

  private burst(at: [number, number], color: RGB, n: number, now: number): void {
    const unit = Math.min(...this.screen());
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.4;
      const v = unit * (0.25 + Math.random() * 0.35);
      this.sparks.push({ x: at[0], y: at[1], vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 450 + Math.random() * 350, color });
    }
  }

  private setHint(text: string): void {
    if (this.hintEl.textContent !== text) this.hintEl.textContent = text;
  }
}

// --- Formes néon ----------------------------------------------------------------------------------

function ring(out: SegmentBuffer, cx: number, cy: number, r: number, from: number, to: number, width: number, color: RGB, intensity: number): void {
  if (intensity <= 0 || r <= 0 || to <= from) return;
  const steps = Math.max(2, Math.ceil(48 * (to - from)));
  for (let i = 0; i < steps; i++) {
    const a0 = (from + ((to - from) * i) / steps) * Math.PI * 2 - Math.PI / 2;
    const a1 = (from + ((to - from) * (i + 1)) / steps) * Math.PI * 2 - Math.PI / 2;
    out.line(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, width, color, intensity);
  }
}

function ellipse(out: SegmentBuffer, cx: number, cy: number, rx: number, ry: number, width: number, color: RGB, intensity: number): void {
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const a0 = (i / steps) * Math.PI * 2;
    const a1 = ((i + 1) / steps) * Math.PI * 2;
    out.line(cx + Math.cos(a0) * rx, cy + Math.sin(a0) * ry, cx + Math.cos(a1) * rx, cy + Math.sin(a1) * ry, width, color, intensity);
  }
}

/** Petite silhouette d'une pose (pictogramme), centrée en (cx, cy), haute de `height` px. */
function picto(out: SegmentBuffer, pose: KeyPose, cx: number, cy: number, height: number, width: number, color: RGB, intensity: number): void {
  if (intensity <= 0.01) return;
  const pts = skeleton({ ...pose, dip: 0 });
  const s = height / 4.1; // de la tête (-0,8) aux pieds (+3,3)
  const P = (i: number): [number, number] => [cx + pts[i][0] * s, cy + (pts[i][1] - 1.25) * s];
  const seg = (a: number, b: number) => {
    const [ax, ay] = P(a);
    const [bx, by] = P(b);
    out.line(ax, ay, bx, by, width, color, intensity);
  };
  const mid = (a: number, b: number): [number, number] => {
    const [ax, ay] = P(a);
    const [bx, by] = P(b);
    return [(ax + bx) / 2, (ay + by) / 2];
  };
  seg(11, 12);
  const sh = mid(11, 12);
  const hp = mid(23, 24);
  out.line(sh[0], sh[1], hp[0], hp[1], width, color, intensity);
  for (const [a, b] of [[11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [23, 24]]) seg(a, b);
  const [hx, hy] = P(0);
  ring(out, hx, hy - s * 0.05, s * 0.2, 0, 1, width, color, intensity);
}

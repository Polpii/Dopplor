// Mode langue des signes (LSF) : apprendre des signes en imitant son double.
//
//   - Le mot à apprendre s'affiche en haut ; le double doré le signe en boucle à côté de toi.
//   - Une jauge montre en direct ta ressemblance avec le signe ; réussi → « Bravo » et suivant.
//   - Si tu fais un autre signe connu, le miroir te dit lequel.
//   - Les signes viennent de la bibliothèque LSF (vidéos Lingua Libre, data/lsf) et de ceux
//     enregistrés sur place. Un mot peut avoir plusieurs versions (plusieurs signeurs) : on
//     compare à toutes, et à leur reflet (on peut signer de la main gauche).
//   - Si on bloque, on passe tout seul au mot suivant au bout d'un moment.
//   - R : enregistrer un nouveau signe (par quelqu'un qui connaît la LSF) ; ← → : changer de
//     signe ; Suppr : effacer le signe affiché (seulement ceux enregistrés sur place).
import { GHOST_COLOR } from "../render/figures";
import { Scene, type Side } from "../scene";
import type { Detection } from "../vision/protocol";
import { GhostClip, GhostPlacer } from "./ghost";
import {
  SIGN_FPS,
  SignStore,
  captureFrame,
  features,
  hasHands,
  mirrored,
  matchSign,
  didTheMovement,
  extent,
  signFeatures,
  progress,
  MATCH_DISTANCE,
  type Features,
  type Sign,
  type SignFrame,
} from "./signs";

/** Un mot déjà appris est reconnu s'il est encore plus net que pour réussir. */
const RECOGNIZE_DISTANCE = MATCH_DISTANCE * 0.85;
const LIVE_SECONDS = 4;
const RECORD_MAX_MS = 4000;
const COUNTDOWN_MS = 3000;
const SUCCESS_MS = 2200;
/** Temps minimum avant de pouvoir réussir un signe (le temps de regarder le double). */
const MIN_LEARN_MS = 1500;
/** On passe au mot suivant si personne n'y arrive (le miroir ne doit pas rester bloqué). */
const SKIP_MS = 30000;
/** Au-delà, la progression s'affiche en chiffres plutôt qu'en points. */
const MAX_DOTS = 12;
/** Les premiers mots proposés, dans cet ordre (s'ils existent) ; les autres suivent par ordre alphabétique. */
const FIRST_WORDS = [
  "bonjour", "salut", "coucou", "merci", "de rien", "s'il vous plait", "pardon", "oui", "au revoir", "je ne comprends pas",
  "qui", "ou", "quand", "pourquoi", "encore", "manger", "lire", "livre", "musique", "film", "jeux", "jouet", "peur",
  "lapin", "poisson", "crabe", "cerf", "sanglier", "coquillage", "couscous", "theatre", "toilettes",
];
/** Comparaison de mots sans majuscules ni accents (« plaît » = « plait »). */
const plain = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
/** Entre deux orthographes du même mot, on affiche celle avec accents et sigles en capitales (« Réserver », « BD »). */
const spellingScore = (s: string) => (s.normalize("NFD").match(/[\u0300-\u036f]/g)?.length ?? 0) * 10 + (s.match(/[A-Z]/g)?.length ?? 0);
/** Version montrée par le double quand un mot a été signé par plusieurs personnes. */
const PREFERRED_SIGNERS = ["Taliba31", "Hugo en résidence"];
const SUGGESTIONS = ["Bonjour", "Merci", "Au revoir", "Oui", "Non", "S'il te plaît", "Pardon", "Ça va", "Je t'aime", "Miroir"];
const RING = `<svg viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="44" /><circle class="fill" cx="50" cy="50" r="44" /></svg>`;

type State = "learn" | "countdown" | "recording" | "naming" | "success";

interface LoadedSign {
  sign: Sign;
  /** Lecture fluide du signe par le double. */
  clip: GhostClip;
  features: Features[];
  mirror: Features[];
  /** Amplitude du geste du modèle. */
  extent: number;
}

/** Un mot à apprendre et ses versions (la première est celle que montre le double). */
interface Lesson {
  label: string;
  variants: LoadedSign[];
}

export class SignLanguageMode {
  readonly id = "signs";
  private root: HTMLElement;
  private word: HTMLElement;
  private hint: HTMLElement;
  private score: HTMLElement;
  private gauge: HTMLElement;
  private dots: HTMLElement;
  private credit: HTMLElement;
  private toast: HTMLElement;
  private record: HTMLElement;
  private input: HTMLInputElement;

  private store: SignStore;
  private lessons: Lesson[] = [];
  private index = 0;
  /** Mots réussis pendant cette visite : le miroir les reconnaît ensuite quand on les refait. */
  private learned = new Set<Lesson>();
  private state: State = "learn";
  private stateSince = 0;
  private live: { frame: SignFrame; features: ReturnType<typeof features> }[] = [];
  private lastCapture = 0;
  private lastMatch = 0;
  private recorded: SignFrame[] = [];
  private ghostStart = 0;
  /** Où se tient le double : suit la personne en douceur, garde son côté. */
  private placer = new GhostPlacer();
  /** Jauge affichée : monte vite, redescend doucement (pas de chiffres qui sautent). */
  private shownScore = 0;
  private active = false;
  /** Dernière comparaison (diagnostic : enregistrement d'une session sur le miroir). */
  debug: { at: number; word: string; distance: number; moved: boolean; frames: number; hands: Record<Side, [number, number] | null> } | null = null;

  constructor(
    private scene: Scene,
    /** Scène du double doré, dessinée par-dessus la scène principale. */
    readonly ghost: Scene,
    private frameSize: () => [number, number],
    api: string | null,
    /** Partie de l'image caméra visible à l'écran : le double doit y tenir. */
    private visible: () => { x0: number; x1: number; y0: number; y1: number },
  ) {
    this.store = new SignStore(api);
    this.root = document.createElement("div");
    this.root.id = "sign-ui";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <div class="sign-top">
        <div class="sign-kicker">Langue des signes · LSF</div>
        <div class="sign-word"></div>
        <div class="sign-hint"></div>
      </div>
      <div class="sign-gauge">${RING}<span class="sign-score">0</span></div>
      <div class="sign-dots"></div>
      <div class="sign-credit"></div>
      <div class="sign-toast"></div>
      <div class="sign-record hidden">
        <div class="sign-count"></div>
        <label class="sign-name">Nom du signe <input type="text" maxlength="40" /></label>
      </div>
      <div class="sign-keys">R enregistrer un signe · ← → changer · Suppr effacer</div>`;
    const $ = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    this.word = $(".sign-word");
    this.hint = $(".sign-hint");
    this.score = $(".sign-score");
    this.gauge = $(".sign-gauge");
    this.dots = $(".sign-dots");
    this.credit = $(".sign-credit");
    this.toast = $(".sign-toast");
    this.record = $(".sign-record");
    this.input = $(".sign-name input") as HTMLInputElement;
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") void this.saveRecording();
      if (e.key === "Escape") this.cancelRecording();
    });
    document.body.append(this.root);
  }

  async enter(): Promise<void> {
    this.active = true;
    this.root.classList.remove("hidden");
    document.body.classList.add("mode-signs");
    this.setState("learn", performance.now());
    await this.reload();
  }

  exit(): void {
    this.active = false;
    this.root.classList.add("hidden");
    document.body.classList.remove("mode-signs");
    this.record.classList.add("hidden");
    this.ghost.clear("pose");
    this.ghost.clear("hands");
  }

  /** Touches du mode ; renvoie vrai si la touche a été utilisée. */
  onKey(e: KeyboardEvent): boolean {
    if (!this.active || this.state === "naming") return false;
    const now = performance.now();
    switch (e.key) {
      case "r":
      case "R":
        this.setState("countdown", now);
        return true;
      case "ArrowRight":
      case "ArrowLeft":
        if (this.lessons.length) {
          this.index = (this.index + (e.key === "ArrowRight" ? 1 : this.lessons.length - 1)) % this.lessons.length;
          this.setState("learn", now);
        }
        return true;
      case "Delete":
        void this.deleteCurrent();
        return true;
    }
    return false;
  }

  update(now: number): void {
    if (!this.active) return;
    this.capture(now);
    switch (this.state) {
      case "learn":
        if (now - this.lastMatch > 150) this.match(now);
        if (this.state === "learn" && now - this.stateSince > SKIP_MS && this.lessons.length > 1) {
          this.index = (this.index + 1) % this.lessons.length;
          this.setState("learn", now);
          this.showToast("On passe au suivant");
        }
        break;
      case "success":
        if (now - this.stateSince > SUCCESS_MS) {
          if (this.lessons.length) this.index = (this.index + 1) % this.lessons.length;
          this.setState("learn", now);
        }
        break;
      case "countdown": {
        const left = Math.ceil((COUNTDOWN_MS - (now - this.stateSince)) / 1000);
        this.setCount(left > 0 ? String(left) : "");
        if (left <= 0) {
          this.recorded = [];
          this.setState("recording", now);
        }
        break;
      }
      case "recording": {
        const frame = this.live.at(-1)?.frame;
        if (frame && frame.t >= this.stateSince && this.recorded.at(-1) !== frame) this.recorded.push(frame);
        const elapsed = now - this.stateSince;
        this.setCount(`● ${(elapsed / 1000).toFixed(1)} s`);
        // Fin : durée max, ou mains baissées (absentes) après au moins une seconde.
        const handsGone = frame ? Object.keys(frame.hands).length === 0 : true;
        if (elapsed > RECORD_MAX_MS || (elapsed > 1000 && handsGone)) this.setState("naming", now);
        break;
      }
    }
  }

  // --- Suivi de la personne -----------------------------------------------------------------

  private capture(now: number): void {
    if (now - this.lastCapture < 1000 / SIGN_FPS) return;
    this.lastCapture = now;
    const frame = captureFrame(this.scene, now);
    if (!frame) return;
    const [w, h] = this.frameSize();
    this.live.push({ frame, features: features(frame, w, h) });
    const keep = LIVE_SECONDS * SIGN_FPS;
    if (this.live.length > keep) this.live.splice(0, this.live.length - keep);
  }

  private match(now: number): void {
    this.lastMatch = now;
    const target = this.lessons[this.index];
    if (!target) return;
    const live = this.live.map((l) => l.features).filter(hasHands);
    if (live.length < 4) {
      this.setScore(0); // la jauge redescend doucement pendant une pause
      return;
    }
    const { distance, moved } = this.compare(target, live);
    const last = this.live.at(-1)?.features.hands;
    this.debug = {
      at: now, word: target.label, distance, moved, frames: live.length,
      hands: { left: last?.left?.place ?? null, right: last?.right?.place ?? null },
    };
    // Bonne pose mais sans le mouvement : la jauge s'arrête avant la fin.
    this.setScore(moved ? progress(distance) : Math.min(progress(distance), 0.75));
    this.setHint(!moved && progress(distance) > 0.75 ? "Bonne position… maintenant fais le mouvement" : "Imite ton double doré");
    if (distance <= MATCH_DISTANCE && moved && now - this.stateSince > MIN_LEARN_MS) {
      this.learned.add(target);
      this.setState("success", now);
      return;
    }
    // Un mot déjà appris ? On le dit. (Pas toute la bibliothèque : avec des centaines de signes,
    // il y en aurait toujours un qui ressemble vaguement.)
    let other: { label: string; distance: number } | null = null;
    for (const lesson of this.learned) {
      if (lesson === target) continue;
      const { distance: d, moved } = this.compare(lesson, live);
      if (moved && d <= RECOGNIZE_DISTANCE && (!other || d < other.distance)) other = { label: lesson.label, distance: d };
    }
    this.showRecognized(other?.label ?? null);
  }

  /**
   * Version du mot la plus proche (de la main droite ou de la gauche) : sa distance, et si le
   * mouvement a vraiment été fait (durée et amplitude, voir didTheMovement).
   */
  private compare(lesson: Lesson, live: Features[]): { distance: number; moved: boolean } {
    let best: { match: ReturnType<typeof matchSign>; template: Features[]; extent: number } | null = null;
    for (const v of lesson.variants) {
      for (const template of [v.features, v.mirror]) {
        const m = matchSign(template, live);
        if (!best || m.distance < best.match.distance) best = { match: m, template, extent: v.extent };
      }
    }
    if (!best) return { distance: Infinity, moved: false };
    return { distance: best.match.distance, moved: didTheMovement(best.template, best.extent, live, best.match) };
  }

  // --- Le double doré ---------------------------------------------------------------------------

  /** Le double est en train de signer : il faut redessiner à la cadence de l'écran. */
  get animating(): boolean {
    return this.active && (this.state === "learn" || this.state === "success") && this.lessons.length > 0;
  }

  /**
   * Fait avancer le double ; appelé à chaque image affichée (pas seulement 30 fois par seconde),
   * pour un mouvement fluide.
   */
  animate(now: number): void {
    if (!this.animating) return;
    const clip = this.lessons[this.index]?.variants[0]?.clip;
    if (!clip || !clip.duration) return;
    const frame = clip.sample(now - this.ghostStart);
    const [w, h] = this.frameSize();
    const a = this.placer.place(now, this.body(w, h), w, h, this.visible());
    const k = a.size / clip.scale;
    const map = (x: number, y: number): [number, number] => [(a.x + (x - clip.center[0]) * k) / w, (a.y + (y - clip.center[1]) * k) / h];

    const pose = new Float32Array(33 * 4);
    for (let i = 0; i < 25; i++) {
      const [x, y] = map(frame.pose[i * 2], frame.pose[i * 2 + 1]);
      // Hanches masquées : les vidéos sont cadrées en buste, elles sont souvent hors champ.
      pose.set([x, y, 0, i === 23 || i === 24 ? 0 : 1], i * 4);
    }
    const hands: Detection[] = [];
    for (const side of ["left", "right"] as Side[]) {
      const pts = frame.hands[side];
      if (!pts) continue;
      const out = new Float32Array(21 * 4);
      for (let i = 0; i < 21; i++) {
        const [x, y] = map(pts[i * 2], pts[i * 2 + 1]);
        out.set([x, y, 0, 1], i * 4);
      }
      hands.push({ points: out, key: `g0/${side}` });
    }
    this.ghost.update("pose", [{ points: pose, key: "g0" }], now);
    this.ghost.update("hands", hands, now);
    for (const map of Object.values(this.ghost.tracks)) for (const t of map.values()) t.color = GHOST_COLOR;
  }

  /** Centre et largeur des épaules de la personne suivie (px de l'image caméra). */
  private body(w: number, h: number): { center: [number, number]; scale: number } | null {
    let body = null;
    for (const b of this.scene.bodies) if (b.lostAt === null) body = b;
    if (!body) return null;
    const v = body.smoother.value;
    const l = [v[44] * w, v[45] * h];
    const r = [v[48] * w, v[49] * h];
    return { center: [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2], scale: Math.max(Math.hypot(l[0] - r[0], l[1] - r[1]), 1) };
  }

  // --- Enregistrement ----------------------------------------------------------------------------

  private async saveRecording(): Promise<void> {
    const label = this.input.value.trim();
    const frames = this.recorded.filter((f) => Object.keys(f.hands).length > 0);
    if (!label || frames.length < 5) {
      this.showToast(frames.length < 5 ? "Signe trop court : recommence (R)" : "Donne un nom au signe");
      if (frames.length < 5) this.cancelRecording();
      return;
    }
    const t0 = frames[0].t;
    const [w, h] = this.frameSize();
    const sign: Sign = {
      id: `${Date.now().toString(36)}-${label.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}`,
      label,
      created: new Date().toISOString(),
      width: w,
      height: h,
      frames: frames.map((f) => ({ ...f, t: f.t - t0 })),
    };
    try {
      await this.store.save(sign);
      await this.reload(sign.id);
      this.showToast(`« ${label} » enregistré`);
    } catch (err) {
      this.showToast(`Échec de l'enregistrement : ${String(err)}`);
    }
    this.input.blur();
    this.record.classList.add("hidden");
    this.setState("learn", performance.now());
  }

  private cancelRecording(): void {
    this.input.blur();
    this.record.classList.add("hidden");
    this.setState("learn", performance.now());
  }

  private async deleteCurrent(): Promise<void> {
    const current = this.lessons[this.index]?.variants.find((v) => !v.sign.bundled);
    if (!current) {
      if (this.lessons[this.index]) this.showToast("Signe de la bibliothèque LSF : il ne s'efface pas");
      return;
    }
    await this.store.remove(current.sign.id);
    this.showToast(`« ${current.sign.label} » effacé`);
    await this.reload();
  }

  private async reload(selectId?: string): Promise<void> {
    const signs = await this.store.list().catch(() => [] as Sign[]);
    const byLabel = new Map<string, Lesson>();
    for (const sign of signs) {
      const loaded: LoadedSign = { sign, clip: new GhostClip(sign), features: signFeatures(sign), mirror: [], extent: 0 };
      if (loaded.features.length < 3) continue;
      loaded.mirror = loaded.features.map(mirrored);
      loaded.extent = extent(loaded.features);
      const key = plain(sign.label);
      const lesson = byLabel.get(key) ?? { label: sign.label.trim(), variants: [] };
      if (spellingScore(sign.label) > spellingScore(lesson.label)) lesson.label = sign.label.trim();
      lesson.variants.push(loaded);
      byLabel.set(key, lesson);
    }
    // Le double montre d'abord un signe enregistré ici, sinon la version du signeur préféré.
    const rank = (v: LoadedSign) => {
      if (!v.sign.bundled) return -1;
      const i = PREFERRED_SIGNERS.indexOf(v.sign.source?.author ?? "");
      return i >= 0 ? i : PREFERRED_SIGNERS.length;
    };
    for (const lesson of byLabel.values()) lesson.variants.sort((a, b) => rank(a) - rank(b));
    const first = (l: Lesson) => {
      const i = FIRST_WORDS.indexOf(plain(l.label));
      return i >= 0 ? i : FIRST_WORDS.length;
    };
    const previous = this.lessons[this.index]?.label;
    this.lessons = [...byLabel.values()].sort((a, b) => first(a) - first(b) || a.label.localeCompare(b.label, "fr"));
    const learned = new Set([...this.learned].map((l) => l.label));
    this.learned = new Set(this.lessons.filter((l) => learned.has(l.label)));
    let i = selectId ? this.lessons.findIndex((l) => l.variants.some((v) => v.sign.id === selectId)) : -1;
    if (i < 0 && previous) i = this.lessons.findIndex((l) => l.label === previous);
    this.index = i >= 0 ? i : Math.min(this.index, Math.max(0, this.lessons.length - 1));
    this.render();
  }

  // --- Affichage ----------------------------------------------------------------------------------

  private setState(state: State, now: number): void {
    this.state = state;
    this.stateSince = now;
    this.root.classList.toggle("success", state === "success");
    this.root.classList.toggle("recording", state === "countdown" || state === "recording" || state === "naming");
    if (state === "learn") {
      this.ghostStart = now;
      // On repart de zéro : sinon les mouvements d'avant (dont l'enregistrement lui-même)
      // valideraient le signe aussitôt.
      this.live = [];
      this.setScore(0, true);
    }
    if (state === "success") this.showToast("Bravo !");
    if (state === "countdown" || state === "recording") {
      this.record.classList.remove("hidden");
      this.input.parentElement!.classList.add("hidden");
      this.ghost.clear("pose");
      this.ghost.clear("hands");
    }
    if (state === "naming") {
      this.setCount("");
      this.input.parentElement!.classList.remove("hidden");
      const known = new Set(this.lessons.map((l) => l.label));
      this.input.value = SUGGESTIONS.find((s) => !known.has(s)) ?? "";
      this.input.focus();
      this.input.select();
    }
    this.render();
  }

  private render(): void {
    const lesson = this.lessons[this.index];
    const current = lesson?.variants[0]?.sign;
    if (this.state === "countdown" || this.state === "recording") {
      this.word.textContent = this.state === "countdown" ? "Prépare-toi" : "Signe !";
      this.hint.textContent = "Fais le signe face au miroir, puis baisse les mains";
    } else if (this.state === "naming") {
      this.word.textContent = "Comment s'appelle ce signe ?";
      this.hint.textContent = "Entrée pour enregistrer · Échap pour annuler";
    } else if (!current) {
      this.word.textContent = "Aucun signe";
      this.hint.textContent = "Appuie sur R pour enregistrer un premier signe";
    } else {
      this.word.textContent = lesson.label;
      this.hint.textContent = this.state === "success" ? "Signe réussi" : "Imite ton double doré";
    }
    const n = this.lessons.length;
    this.dots.classList.toggle("count", n > MAX_DOTS);
    this.dots.innerHTML =
      n > MAX_DOTS ? `${this.index + 1} / ${n}` : this.lessons.map((_, i) => `<span class="${i === this.index ? "on" : ""}"></span>`).join("");
    const src = this.state === "countdown" || this.state === "recording" ? undefined : current?.source;
    this.credit.textContent = src ? `Signé par ${src.author} · Lingua Libre · ${src.license}` : "";
    this.gauge.classList.toggle("hidden", !current || this.state !== "learn");
  }

  /** Jauge : monte vite, redescend doucement ; `immediate` pour la remettre à zéro d'un coup. */
  private setScore(score: number, immediate = false): void {
    const s = this.shownScore;
    this.shownScore = immediate ? score : s + (score - s) * (score > s ? 0.6 : 0.15);
    // On n'écrit dans la page que si l'affichage change (chaque écriture redessine).
    const p = this.shownScore.toFixed(2);
    if (this.gauge.style.getPropertyValue("--p") !== p) this.gauge.style.setProperty("--p", p);
    this.gauge.classList.toggle("close", this.shownScore >= 0.8);
    const text = String(Math.round(this.shownScore * 100));
    if (this.score.textContent !== text) this.score.textContent = text;
  }

  private setHint(text: string): void {
    if (this.hint.textContent !== text) this.hint.textContent = text;
  }

  private setCount(text: string): void {
    (this.record.querySelector(".sign-count") as HTMLElement).textContent = text;
  }

  private toastTimer = 0;
  private recognized: string | null = null;

  /** « Ça, c'est … » : affiché tant que le mot est reconnu, sans effacer les autres messages. */
  private showRecognized(label: string | null): void {
    if (label === this.recognized) return;
    const previous = this.recognized;
    this.recognized = label;
    if (label) this.showToast(`Ça, c'est « ${label} »`);
    else if (previous && this.toast.textContent === `Ça, c'est « ${previous} »`) this.showToast("");
  }

  private showToast(text: string): void {
    if (this.toast.textContent === text && text) {
      // Même message : on prolonge son affichage.
      this.toast.classList.add("visible");
    }
    this.toast.textContent = text;
    this.toast.classList.toggle("visible", text !== "");
    clearTimeout(this.toastTimer);
    if (text) this.toastTimer = window.setTimeout(() => this.toast.classList.remove("visible"), 2500);
  }
}

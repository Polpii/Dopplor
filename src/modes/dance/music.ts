// Musique du mode danse, jouée par le navigateur (Web Audio) : un groove house-funk à 112 BPM en
// la mineur. Rien à télécharger, pas de droits, et la chorégraphie se cale exactement sur les
// temps puisqu'on connaît chaque note.
//
// Structure (mesures de 4 temps) :
//   0–3   intro      nappe qui s'ouvre, charleston, grosse caisse à partir de la 3e mesure
//   4–11  couplet    grosse caisse, clap, charleston, basse, accords piqués
//   12–19 refrain    + arpège avec écho, charleston en doubles croches
//   20–23 pont       nappe, clap, montée de bruit blanc ; ni grosse caisse ni basse
//   24–31 final      tout
//   32–33 fin        un dernier coup, la nappe s'éteint
export const BPM = 112;
export const BEAT = 60 / BPM;
export const SONG_BARS = 34;
export const SONG_SECONDS = SONG_BARS * 4 * BEAT;

const STEP = BEAT / 4; // double croche
const LOOKAHEAD = 0.25; // on programme les notes 250 ms à l'avance

/** Am7 – Fmaj7 – Cmaj7 – G6 : basse (MIDI) et accord. */
const CHORDS: { bass: number; notes: number[] }[] = [
  { bass: 45, notes: [57, 60, 64, 67] },
  { bass: 41, notes: [57, 60, 64, 65] },
  { bass: 48, notes: [55, 59, 60, 64] },
  { bass: 43, notes: [55, 59, 62, 64] },
];
/** Basse : [double croche, demi-tons au-dessus de la fondamentale]. */
const BASS = [
  [0, 0],
  [3, 0],
  [6, 12],
  [8, 0],
  [10, 7],
  [13, 12],
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 3, 1, 2];

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

type Section = "intro" | "verse" | "chorus" | "bridge" | "final" | "end";
function section(bar: number): Section {
  if (bar < 4) return "intro";
  if (bar < 12) return "verse";
  if (bar < 20) return "chorus";
  if (bar < 24) return "bridge";
  if (bar < 32) return "final";
  return "end";
}

export class Groove {
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private duck!: GainNode; // basse et accords baissent un instant sur chaque grosse caisse
  private echo!: DelayNode;
  private noise!: AudioBuffer;
  private startAt = 0; // temps audio du début du morceau
  private nextStep = 0;
  private timer = 0;
  /** Horloge de secours (ms) si le son est indisponible : la danse continue en silence. */
  private silentStart: number | null = null;

  /** Démarre le morceau ; renvoie faux si le son n'a pas pu démarrer (la danse continue sans). */
  async start(now: number): Promise<boolean> {
    this.stop();
    try {
      this.ctx ??= this.build();
      if (this.ctx.state !== "running") await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 300))]);
    } catch {
      this.ctx = null;
    }
    if (!this.ctx || this.ctx.state !== "running") {
      this.silentStart = now;
      return false;
    }
    this.silentStart = null;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setValueAtTime(0.55, this.ctx.currentTime);
    this.startAt = this.ctx.currentTime + 0.15;
    this.nextStep = 0;
    this.timer = window.setInterval(() => this.schedule(), 25);
    this.schedule();
    return true;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
    this.silentStart = null;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(this.out.gain.value, t);
      this.out.gain.linearRampToValueAtTime(0, t + 0.3);
    }
  }

  get playing(): boolean {
    return this.timer !== 0 || this.silentStart !== null;
  }

  /**
   * Position dans le morceau (s) à l'instant `now` (performance.now), d'après ce qu'on entend :
   * l'horloge audio, corrigée de la latence de sortie.
   */
  time(now: number): number | null {
    if (this.silentStart !== null) return (now - this.silentStart) / 1000;
    if (!this.ctx || !this.timer) return null;
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts?.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (now - ts.performanceTime) / 1000 - this.startAt;
    }
    return this.ctx.currentTime - (this.ctx.outputLatency || 0) - this.startAt;
  }

  /** Petit carillon dans la tonalité, pour un mouvement parfait. */
  chime(): void {
    if (!this.ctx || !this.timer) return;
    const t = this.ctx.currentTime + 0.01;
    [76, 83].forEach((m, i) => this.tone(t + i * 0.06, hz(m), 0.35, "sine", 0.07, this.out));
  }

  // --- Construction ---------------------------------------------------------------------------

  private build(): AudioContext {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.out = ctx.createGain();
    this.out.gain.value = 0.55;
    this.out.connect(comp);
    this.duck = ctx.createGain();
    this.duck.connect(this.out);
    // Écho en 3/16 pour l'arpège.
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = STEP * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2500;
    this.echo.connect(tone).connect(feedback).connect(this.echo);
    tone.connect(this.duck);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return ctx;
  }

  private schedule(): void {
    const ctx = this.ctx!;
    const total = SONG_BARS * 16;
    while (this.nextStep < total && this.startAt + this.nextStep * STEP < ctx.currentTime + LOOKAHEAD) {
      this.play(this.nextStep, this.startAt + this.nextStep * STEP);
      this.nextStep++;
    }
    if (this.nextStep >= total && ctx.currentTime > this.startAt + SONG_SECONDS + 1) this.stop();
  }

  /** Les notes d'une double croche. */
  private play(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const sec = section(bar);
    const chord = CHORDS[bar % 4];
    const full = sec === "verse" || sec === "chorus" || sec === "final";

    // Nappe : en intro, au pont et à la fin, une mesure entière.
    if (s === 0 && (sec === "intro" || sec === "bridge" || sec === "end")) {
      const open = sec === "intro" ? 500 + bar * 500 : sec === "end" ? 1200 : 1600;
      const len = sec === "end" && bar === SONG_BARS - 1 ? BEAT * 6 : BEAT * 4;
      this.pad(t, chord.notes, len, open, sec === "end" ? 0.06 : 0.08);
    }
    // Grosse caisse.
    const kick = full || (sec === "intro" && bar >= 2) || (sec === "end" && bar === 32 && s === 0);
    if (kick && s % 4 === 0) this.kick(t, sec === "intro" ? 0.6 : 1);
    // Clap sur 2 et 4.
    if ((full || sec === "bridge") && (s === 4 || s === 12)) this.clap(t, sec === "bridge" ? 0.5 : 0.8);
    // Charleston : contretemps, et doubles croches légères au refrain et au final.
    if (sec !== "end" && !(sec === "intro" && bar === 0)) {
      if (s % 4 === 2) this.hat(t, 0.16, 0.09);
      else if ((sec === "chorus" || sec === "final") && s % 2 === 1) this.hat(t, 0.05, 0.03);
    }
    // Basse.
    if (full) for (const [at, interval] of BASS) if (s === at) this.bass(t, hz(chord.bass + interval), STEP * 1.6);
    // Accords piqués sur les contretemps.
    if (full && s % 4 === 2) this.stab(t, chord.notes);
    // Arpège avec écho.
    if (sec === "chorus" || sec === "final" || sec === "bridge") {
      const note = chord.notes[ARP[s] % chord.notes.length] + 12;
      this.tone(t, hz(note), STEP * 0.9, "triangle", sec === "bridge" ? 0.025 : 0.035, this.echo, this.duck);
    }
    // Montée de bruit blanc à la fin du pont.
    if (bar === 23 && s === 0) this.riser(t, BEAT * 4);
  }

  // --- Instruments ------------------------------------------------------------------------------

  private kick(t: number, vel: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(0.9 * vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.4);
    // La basse et les accords se poussent pour laisser respirer la grosse caisse.
    this.duck.gain.setValueAtTime(0.35, t);
    this.duck.gain.linearRampToValueAtTime(1, t + 0.18);
  }

  private clap(t: number, vel: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    // Trois petites attaques rapprochées, comme des mains.
    for (const [dt, v] of [[0, 1], [0.012, 0.7], [0.024, 1]] as const) {
      g.gain.setValueAtTime(0.5 * vel * v, t + dt);
      g.gain.exponentialRampToValueAtTime(0.05 * vel, t + dt + 0.01);
    }
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 0.25);
  }

  private hat(t: number, vel: number, len: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(hp).connect(g).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + len + 0.01);
  }

  private bass(t: number, freq: number, len: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    osc.connect(lp).connect(g).connect(this.duck);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }

  private stab(t: number, notes: number[]): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(600, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    lp.connect(g).connect(this.duck);
    for (const n of notes) {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        osc.type = "sawtooth";
        osc.frequency.value = hz(n);
        osc.detune.value = detune;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + 0.25);
      }
    }
  }

  private pad(t: number, notes: number[], len: number, cutoff: number, vel: number): void {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(cutoff, t);
    lp.frequency.linearRampToValueAtTime(cutoff * 1.5, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.4);
    g.gain.setValueAtTime(vel, t + len - 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + len + 0.2);
    lp.connect(g).connect(this.duck);
    for (const n of notes) {
      for (const detune of [-9, 0, 9]) {
        const osc = ctx.createOscillator();
        osc.type = detune === 0 ? "triangle" : "sawtooth";
        osc.frequency.value = hz(n);
        osc.detune.value = detune;
        osc.connect(lp);
        osc.start(t);
        osc.stop(t + len + 0.3);
      }
    }
  }

  private riser(t: number, len: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 2;
    bp.frequency.setValueAtTime(400, t);
    bp.frequency.exponentialRampToValueAtTime(6000, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + 0.05);
    src.connect(bp).connect(g).connect(this.out);
    src.start(t);
    src.stop(t + len + 0.1);
  }

  private tone(t: number, freq: number, len: number, type: OscillatorType, vel: number, ...dest: AudioNode[]): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    osc.connect(g);
    for (const d of dest) g.connect(d);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }
}

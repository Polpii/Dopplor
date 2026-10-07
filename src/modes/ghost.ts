// Le double doré : lecture fluide d'un signe enregistré.
//
// Les signes sont enregistrés à 15 images/s, avec des trous (une main que le modèle a perdue une
// image ou deux). Pour que le double bouge sans à-coups à la cadence de l'écran : on comble les
// trous des mains, on interpole entre deux images, et à la fin du signe on tient la pose un
// instant puis on revient en douceur au début plutôt que de sauter.
import type { Side } from "../scene";
import type { Sign } from "./signs";

const POSE_POINTS = 25;
const SIDES: Side[] = ["left", "right"];
/** Fin du signe : pose tenue, puis retour au début. */
const HOLD_MS = 600;
const RETURN_MS = 600;

/** Une image du double, en px de l'image d'origine du signe. */
export interface GhostPose {
  pose: Float32Array; // 25 × (x, y)
  hands: Partial<Record<Side, Float32Array>>; // 21 × (x, y)
}

export class GhostClip {
  private times: number[] = [];
  private poses: Float32Array[] = [];
  private hands: Record<Side, (Float32Array | null)[]> = { left: [], right: [] };
  readonly duration: number;
  /** Centre et largeur moyens des épaules du signeur (px) : le repère du double. */
  readonly center: [number, number];
  readonly scale: number;

  constructor(sign: Sign) {
    const t0 = sign.frames[0]?.t ?? 0;
    const px = (arr: number[]) => {
      const out = new Float32Array(arr.length);
      for (let i = 0; i < arr.length; i += 2) {
        out[i] = arr[i] * sign.width;
        out[i + 1] = arr[i + 1] * sign.height;
      }
      return out;
    };
    for (const f of sign.frames) {
      this.times.push(f.t - t0);
      this.poses.push(px(f.pose.slice(0, POSE_POINTS * 2)));
      for (const side of SIDES) this.hands[side].push(f.hands[side] ? px(f.hands[side]!) : null);
    }
    for (const side of SIDES) fillGaps(this.hands[side], this.times);
    this.duration = this.times.at(-1) ?? 0;
    let cx = 0, cy = 0, s = 0;
    for (const p of this.poses) {
      cx += (p[22] + p[24]) / 2;
      cy += (p[23] + p[25]) / 2;
      s += Math.hypot(p[22] - p[24], p[23] - p[25]);
    }
    const n = Math.max(1, this.poses.length);
    this.center = [cx / n, cy / n];
    this.scale = Math.max(1, s / n);
  }

  /** Pose du double à l'instant `t` (ms) depuis le début de la lecture (qui boucle). */
  sample(t: number): GhostPose {
    const cycle = this.duration + HOLD_MS + RETURN_MS;
    t %= cycle;
    if (t <= this.duration) return this.at(t);
    if (t <= this.duration + HOLD_MS) return this.at(this.duration);
    // Retour au début, en douceur.
    const k = easeInOut((t - this.duration - HOLD_MS) / RETURN_MS);
    return mix(this.at(this.duration), this.at(0), k);
  }

  private at(t: number): GhostPose {
    const n = this.times.length;
    let i = 0;
    while (i < n - 2 && this.times[i + 1] < t) i++;
    const j = Math.min(n - 1, i + 1);
    const span = this.times[j] - this.times[i];
    const k = span > 0 ? Math.min(1, Math.max(0, (t - this.times[i]) / span)) : 0;
    const out: GhostPose = { pose: lerp(this.poses[i], this.poses[j], k), hands: {} };
    for (const side of SIDES) {
      const a = this.hands[side][i];
      const b = this.hands[side][j];
      if (a && b) out.hands[side] = lerp(a, b, k);
      else if (a || b) out.hands[side] = (a ?? b)!;
    }
    return out;
  }
}

/** Trous au milieu : interpolés ; au début et à la fin : la main la plus proche, tenue. */
function fillGaps(seq: (Float32Array | null)[], times: number[]): void {
  const known = seq.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  if (!known.length) return;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i]) continue;
    const prev = [...known].reverse().find((k) => k < i);
    const next = known.find((k) => k > i);
    if (prev !== undefined && next !== undefined) {
      seq[i] = lerp(seq[prev]!, seq[next]!, (times[i] - times[prev]) / (times[next] - times[prev]));
    } else seq[i] = seq[(prev ?? next)!];
  }
}

function lerp(a: Float32Array, b: Float32Array, k: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * k;
  return out;
}

function mix(a: GhostPose, b: GhostPose, k: number): GhostPose {
  const out: GhostPose = { pose: lerp(a.pose, b.pose, k), hands: {} };
  for (const side of SIDES) {
    const ha = a.hands[side];
    const hb = b.hands[side];
    if (ha && hb) out.hands[side] = lerp(ha, hb, k);
    else if (ha || hb) out.hands[side] = (ha ?? hb)!;
  }
  return out;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

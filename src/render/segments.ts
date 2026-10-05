export type RGB = readonly [number, number, number];

/** Floats par segment : ax, ay, bx, by, r, g, b, intensité, épaisseur. */
export const SEGMENT_FLOATS = 9;

/** Liste de segments lumineux, prête à être envoyée telle quelle au GPU (instancing). */
export class SegmentBuffer {
  data = new Float32Array(4096 * SEGMENT_FLOATS);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  line(ax: number, ay: number, bx: number, by: number, width: number, color: RGB, intensity: number): void {
    if ((this.count + 1) * SEGMENT_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const d = this.data;
    const o = this.count * SEGMENT_FLOATS;
    d[o] = ax;
    d[o + 1] = ay;
    d[o + 2] = bx;
    d[o + 3] = by;
    d[o + 4] = color[0];
    d[o + 5] = color[1];
    d[o + 6] = color[2];
    d[o + 7] = intensity;
    d[o + 8] = width;
    this.count++;
  }

  /** Un point = segment de longueur nulle (rond grâce au SDF). */
  dot(x: number, y: number, diameter: number, color: RGB, intensity: number): void {
    this.line(x, y, x, y, diameter, color, intensity);
  }
}

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

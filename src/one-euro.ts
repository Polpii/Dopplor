/**
 * Banque de filtres One Euro (Casiez et al., 2012) sur un Float32Array : un filtre par valeur,
 * sans allocation par frame. Lisse fort quand on bouge lentement (supprime la tremblote)
 * et peu quand on bouge vite (supprime la latence).
 *
 * Calcule aussi la vitesse de chaque valeur filtrée, qui sert à prédire où sera le point au
 * moment de l'affichage (compensation de latence).
 */
export class OneEuroBank {
  readonly value: Float32Array;
  /** Vitesse de chaque valeur filtrée (unités par seconde). */
  readonly velocity: Float32Array;
  private derivative: Float32Array;
  private lastTime = -1;

  constructor(
    size: number,
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1.0,
    /** Fréquence de coupure de la vitesse : assez haute pour suivre les changements de direction. */
    private velocityCutoff = 4.0,
  ) {
    this.value = new Float32Array(size);
    this.velocity = new Float32Array(size);
    this.derivative = new Float32Array(size);
  }

  /** Filtre `input` (temps en secondes) et renvoie `this.value`. */
  filter(input: Float32Array, t: number): Float32Array {
    const { value, derivative, velocity } = this;
    if (this.lastTime < 0) {
      value.set(input);
      this.lastTime = t;
      return value;
    }
    const dt = t - this.lastTime;
    if (dt <= 0) return value;
    this.lastTime = t;

    const aD = alpha(dt, this.dCutoff);
    const aV = alpha(dt, this.velocityCutoff);
    for (let i = 0; i < value.length; i++) {
      const d = derivative[i] + ((input[i] - value[i]) / dt - derivative[i]) * aD;
      derivative[i] = d;
      const previous = value[i];
      value[i] += (input[i] - value[i]) * alpha(dt, this.minCutoff + this.beta * Math.abs(d));
      velocity[i] += ((value[i] - previous) / dt - velocity[i]) * aV;
    }
    return value;
  }
}

const alpha = (dt: number, cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

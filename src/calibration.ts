// Panneau de calibration du miroir (touche K) : position de la caméra par rapport à l'écran,
// taille de l'écran, écart vitre/dalle. L'inclinaison de la caméra est mesurée par son
// accéléromètre. Une croix de 20 cm permet de vérifier la taille d'écran à la règle, et un cercle
// montre où l'œil devrait voir son propre reflet (vérification une fois la vitre posée).

export interface CalibrationData {
  enabled: boolean;
  camera_right: number;
  camera_down: number;
  camera_front: number;
  yaw: number;
  pitch: number | null;
  roll: number | null;
  screen_width: number;
  screen_height: number;
  glass_gap: number;
}

export interface MirrorInfo {
  /** La caméra fournit la profondeur (sinon l'alignement est impossible). */
  available: boolean;
  /** L'alignement est en cours (activé et inclinaison connue). */
  active: boolean;
  calibration: CalibrationData;
  /** Inclinaison mesurée (pitch, roulis) en degrés. */
  tilt: [number, number] | null;
}

type NumberField = Exclude<keyof CalibrationData, "enabled">;

const FIELDS: { key: NumberField; label: string; hint?: string; optional?: boolean }[] = [
  { key: "camera_right", label: "Caméra → droite (cm)", hint: "du bord gauche de l'écran au centre de la caméra" },
  { key: "camera_down", label: "Caméra ↓ bas (cm)", hint: "du bord haut de l'écran ; négatif si la caméra est au-dessus" },
  { key: "camera_front", label: "Caméra en avant (cm)", hint: "de la surface de l'écran (ou de la vitre) à l'objectif" },
  { key: "yaw", label: "Caméra tournée (°)", hint: "0 = face à la pièce ; positif = vers ta droite" },
  { key: "pitch", label: "Inclinaison (°)", hint: "par rapport à l'écran : 0 si la caméra est à plat contre lui ; vide = verticale mesurée (seulement si l'écran est d'aplomb)", optional: true },
  { key: "roll", label: "Roulis (°)", hint: "par rapport à l'écran : -90 pour une caméra le long du bord ; vide = mesuré", optional: true },
  { key: "screen_width", label: "Largeur de l'écran (cm)", hint: "zone d'affichage" },
  { key: "screen_height", label: "Hauteur de l'écran (cm)" },
  { key: "glass_gap", label: "Écart vitre / dalle (cm)", hint: "0 sans vitre" },
];

const SVG = "http://www.w3.org/2000/svg";

export class CalibrationPanel {
  private panel: HTMLElement;
  private overlay: SVGSVGElement;
  private inputs = new Map<NumberField, HTMLInputElement>();
  private enabled: HTMLInputElement;
  private status: HTMLElement;
  private shown = false;
  private sendTimer = 0;
  private data: CalibrationData | null = null;

  constructor(private onChange: (data: Partial<CalibrationData>) => void) {
    this.panel = document.createElement("aside");
    this.panel.id = "calib";
    this.panel.className = "hidden";
    this.panel.innerHTML = `
      <h2>Alignement sur le reflet</h2>
      <p class="help">Mesure depuis le <b>coin haut-gauche de l'écran</b> (vu de face) jusqu'au centre de la caméra.
      L'inclinaison de la caméra est mesurée toute seule.</p>
      <label class="toggle"><input type="checkbox" id="calib-enabled" /> Aligner sur le reflet</label>
      <div class="fields"></div>
      <p class="status" id="calib-status"></p>
      <p class="help">La croix au centre doit mesurer <b>20 cm</b> dans chaque sens : sinon corrige la taille de l'écran.
      Le cercle montre où tu devrais voir le reflet de ton œil (avec la vitre).</p>`;
    const fields = this.panel.querySelector(".fields")!;
    for (const f of FIELDS) {
      const row = document.createElement("label");
      row.className = "field";
      row.innerHTML = `<span>${f.label}${f.hint ? `<small>${f.hint}</small>` : ""}</span>`;
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.5";
      if (f.optional) input.placeholder = "auto";
      input.addEventListener("input", () => this.changed());
      row.append(input);
      fields.append(row);
      this.inputs.set(f.key, input);
    }
    this.enabled = this.panel.querySelector("#calib-enabled")!;
    this.enabled.addEventListener("change", () => this.changed());
    this.status = this.panel.querySelector("#calib-status")!;

    this.overlay = document.createElementNS(SVG, "svg");
    this.overlay.id = "calib-overlay";
    this.overlay.classList.add("hidden");
    document.body.append(this.overlay, this.panel);
  }

  get open(): boolean {
    return this.shown;
  }

  toggle(): void {
    this.shown = !this.shown;
    this.panel.classList.toggle("hidden", !this.shown);
    this.overlay.classList.toggle("hidden", !this.shown);
    if (this.shown && this.data) this.fill(this.data);
  }

  /** Nouvelles infos du serveur : met à jour l'état, la mire et le cercle de l'œil. */
  update(info: MirrorInfo | null, eye: [number, number] | null): void {
    if (!info) {
      this.status.textContent = "Alignement indisponible : il faut le serveur Python et une caméra avec profondeur.";
      return;
    }
    const firstTime = this.data === null;
    this.data = info.calibration;
    if (firstTime && this.shown) this.fill(info.calibration);
    const tilt = info.tilt ? `inclinaison mesurée ${info.tilt[0].toFixed(1)}°, roulis ${info.tilt[1].toFixed(1)}°` : "inclinaison inconnue";
    this.status.textContent = !info.available
      ? "Cette caméra ne donne pas la profondeur : alignement impossible."
      : `${info.active ? "Alignement actif" : "Alignement désactivé"} · ${tilt}`;
    if (this.shown) this.draw(info.calibration, info.active ? eye : null);
  }

  private fill(c: CalibrationData): void {
    this.enabled.checked = c.enabled;
    for (const [key, input] of this.inputs) {
      if (document.activeElement !== input) input.value = c[key] === null ? "" : String(c[key]);
    }
  }

  private changed(): void {
    const data: Partial<CalibrationData> = { enabled: this.enabled.checked };
    for (const f of FIELDS) {
      const raw = this.inputs.get(f.key)!.value.trim();
      if (raw === "" && f.optional) (data as Record<string, unknown>)[f.key] = null;
      else if (raw !== "" && Number.isFinite(Number(raw))) (data as Record<string, unknown>)[f.key] = Number(raw);
    }
    // On attend une pause dans la saisie avant d'envoyer (et d'écrire le fichier côté serveur).
    clearTimeout(this.sendTimer);
    this.sendTimer = window.setTimeout(() => this.onChange(data), 250);
  }

  /** Croix de 20 cm au centre de l'écran + cercle de 3 cm là où l'œil devrait voir son reflet. */
  private draw(c: CalibrationData, eye: [number, number] | null): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pxPerCmX = w / c.screen_width;
    const pxPerCmY = h / c.screen_height;
    const cx = w / 2;
    const cy = h / 2;
    const parts = [
      `<line x1="${cx - 10 * pxPerCmX}" y1="${cy}" x2="${cx + 10 * pxPerCmX}" y2="${cy}" />`,
      `<line x1="${cx}" y1="${cy - 10 * pxPerCmY}" x2="${cx}" y2="${cy + 10 * pxPerCmY}" />`,
      `<text x="${cx + 10 * pxPerCmX + 8}" y="${cy + 5}">20 cm</text>`,
    ];
    if (eye) {
      const ex = eye[0] * w;
      const ey = eye[1] * h;
      parts.push(`<circle cx="${ex}" cy="${ey}" r="${3 * pxPerCmX}" class="eye" />`, `<text x="${ex + 3 * pxPerCmX + 6}" y="${ey + 5}" class="eye">ton œil</text>`);
    }
    this.overlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.overlay.innerHTML = parts.join("");
  }
}

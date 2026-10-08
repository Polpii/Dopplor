import type { CalibrationData, MirrorInfo } from "../calibration";
import type { Detection, TaskKind } from "./protocol";

/** Point 3D dans le repère du miroir (m) : x vers la droite, y vers le bas, z vers le mur. */
export type Vec3 = [number, number, number];

/**
 * Le corps tel qu'on le voit dans le reflet (serveur Python avec profondeur) : pour chaque case
 * d'une grille posée sur l'écran, la distance du reflet derrière la vitre (`scale` m par unité,
 * 255 = pas de corps). Avec l'œil, l'écran et quelques points du corps (personne réelle, devant
 * la vitre), de quoi placer de la 3D derrière la vitre et la cacher derrière la personne.
 */
export interface Occlusion {
  /** Par case : distance (× scale m, 255 = rien), puis couverture par le corps (0–255). */
  grid: Uint8Array;
  w: number;
  h: number;
  channels: number;
  scale: number;
  eye: Vec3;
  /** Largeur, hauteur de l'écran, écart vitre/dalle (m). */
  screen: Vec3;
  /** Personne réelle (devant la vitre) : poitrine, hanches, tête, poignets, épaules, paumes. */
  body: Record<"chest" | "hips" | "head" | "lw" | "rw" | "ls" | "rs" | "lp" | "rp", Vec3>;
  vis: { lw: boolean; rw: boolean };
  /** Reçue à (performance.now()). */
  at: number;
}

/** "camera" : points dans l'image caméra ; "screen" : déjà calés sur le reflet (écran 0–1). */
export type Space = "camera" | "screen";

/**
 * D'où viennent les points : du navigateur (webcam + MediaPipe en Web Workers) ou du serveur
 * Python (caméra + MediaPipe natif, reçus par WebSocket). Le rendu ne voit pas la différence.
 */
export interface VisionSource {
  /** "navigateur" ou "python". */
  readonly label: string;
  /** `raw` : quand les points sont calés sur le reflet (`detections`), les mêmes dans l'image
   * caméra, pour les gestes et les modes. */
  onResult: (kind: TaskKind, detections: Detection[], timestamp: number, raw?: Detection[]) => void;
  onError: (message: string) => void;
  /** Taille de l'image caméra (pour caler le rendu dessus). */
  frameSize(): [number, number];
  gpu(): string;
  /** Résumé caméra pour le panneau d'infos. */
  cameraText(): string;
  /** Résumé d'un modèle pour le panneau d'infos. */
  taskText(kind: TaskKind): string;
  /** Active / désactive un modèle ; renvoie le nouvel état. */
  toggle(kind: TaskKind): boolean;
  cyclePoseModel(): Promise<void>;
  /** Affiche (ou non) l'image caméra sous le rendu. */
  setCameraView(on: boolean): void;
  /** Temps écoulé depuis la capture de l'image du dernier squelette reçu (ms). */
  latency(): number | null;
  /** Repère des points reçus (serveur Python avec calibration : "screen"). */
  space?(): Space;
  /** État de l'alignement sur le reflet (serveur Python uniquement). */
  mirror?(): MirrorInfo | null;
  /** Où l'œil devrait voir son propre reflet (écran 0–1). */
  eye?(): [number, number] | null;
  setCalibration?(data: Partial<CalibrationData>): void;
  /** Silhouette du reflet : demander au serveur de l'envoyer (mode fée), et la dernière reçue. */
  setOcclusion?(on: boolean): void;
  occlusion?(): Occlusion | null;
  /** Adresse HTTP du serveur Python (stockage des signes), si la source en a un. */
  apiBase?(): string;
}

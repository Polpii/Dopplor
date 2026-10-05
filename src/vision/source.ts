import type { CalibrationData, MirrorInfo } from "../calibration";
import type { Detection, TaskKind } from "./protocol";

/** "camera" : points dans l'image caméra ; "screen" : déjà calés sur le reflet (écran 0–1). */
export type Space = "camera" | "screen";

/**
 * D'où viennent les points : du navigateur (webcam + MediaPipe en Web Workers) ou du serveur
 * Python (caméra + MediaPipe natif, reçus par WebSocket). Le rendu ne voit pas la différence.
 */
export interface VisionSource {
  /** "navigateur" ou "python". */
  readonly label: string;
  onResult: (kind: TaskKind, detections: Detection[], timestamp: number) => void;
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
}

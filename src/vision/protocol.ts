// Messages échangés entre le thread principal et les workers d'inférence.

export type TaskKind = "pose" | "hands" | "face";
export type PoseModel = "lite" | "full" | "heavy";
export type Delegate = "GPU" | "CPU";

/** Chaque landmark est packé en 4 floats : x, y, z, visibilité. */
export const STRIDE = 4;

/**
 * Expressions extraites des 52 blendshapes du visage (0 → 1), dans cet ordre.
 * Calculées dans le worker pour n'envoyer que l'utile.
 */
export const EXPRESSIONS = [
  "smile",
  "jawOpen",
  "blinkLeft",
  "blinkRight",
  "browUp",
  "browDown",
  "eyeWide",
  "pucker",
  "cheekPuff",
  "frown",
] as const;
export type Expression = (typeof EXPRESSIONS)[number];

/**
 * Zone carrée (px de l'image caméra) où chercher une main ou un visage, déduite du squelette.
 * `key` = "<corps>/<partie>", ex. "pose-0/left", "pose-0/face" : identité stable du résultat.
 */
export interface Roi {
  key: string;
  x: number;
  y: number;
  size: number;
}

export interface Detection {
  /** Coordonnées normalisées [0, 1] dans l'image caméra entière (non inversée). */
  points: Float32Array;
  /** Main détectée par MediaPipe ("Left" / "Right"), en recherche plein cadre uniquement. */
  label?: string;
  /** Identité imposée (recherche par zone) : la clé de la Roi. */
  key?: string;
  /** Visage : valeurs des EXPRESSIONS. */
  expressions?: Float32Array;
}

export type ToWorker =
  | { type: "init"; kind: TaskKind; modelUrl: string; wasmUrl: string; maxItems: number }
  | { type: "model"; modelUrl: string }
  /** `rois` null : recherche dans l'image entière. */
  | { type: "frame"; frame: VideoFrame; timestamp: number; rois: Roi[] | null };

export type FromWorker =
  | { type: "ready"; delegate: Delegate; gpu: string }
  | { type: "result"; timestamp: number; inferMs: number; detections: Detection[] }
  | { type: "error"; message: string };

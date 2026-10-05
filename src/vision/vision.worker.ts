// Un worker = un type de modèle MediaPipe. L'inférence ne bloque jamais le rendu,
// et les trois types (corps, mains, visage) tournent en parallèle.
//
// Mains et visage : quand le thread principal fournit des zones (déduites du squelette),
// on découpe chaque zone en pleine résolution et on la passe au modèle en gros plan.
// Le visage est alors détecté de loin, et une main rapide est retrouvée là où va le poignet.
import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type Classifications,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import {
  EXPRESSIONS,
  STRIDE,
  type Delegate,
  type Detection,
  type Expression,
  type FromWorker,
  type Roi,
  type TaskKind,
  type ToWorker,
} from "./protocol";

type Fileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;
type Source = VideoFrame | OffscreenCanvas;

interface RawResult {
  landmarks: NormalizedLandmark[][];
  labels?: (string | undefined)[];
  expressions?: Float32Array[];
}

interface Detector {
  detect(source: Source, timestamp: number): RawResult;
  close(): void;
}

/** Taille de la découpe envoyée au modèle (les modèles mains/visage travaillent en 192–256 px). */
const CROP_SIZE = 256;

let fileset: Fileset | null = null;
/**
 * Fabrique du module WASM. MediaPipe la lit sur `self.ModuleFactory` puis l'efface après
 * chaque création ; or un module ES n'est exécuté qu'une fois par worker. Sans ce cache,
 * le deuxième modèle (ex. passage à « heavy ») échoue avec « ModuleFactory not set ».
 */
let moduleFactory: unknown = null;
const wasmGlobals = self as unknown as { ModuleFactory?: unknown };

let kind: TaskKind = "pose";
let maxItems = 1;
/** Recherche dans l'image entière (repli quand aucun corps n'est suivi). */
let fullDetector: Detector | null = null;
/**
 * Un détecteur par zone (main gauche, main droite, visage) : chacun garde son propre suivi
 * d'une image à l'autre. Indexés par la partie de la clé ("left", "right", "face").
 */
const zoneDetectors = new Map<string, Detector>();

const crop = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);
const cropCtx = crop.getContext("2d", { alpha: false })!;

const post = (msg: FromWorker, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

/** Coordonnées de la découpe → image entière. */
interface Mapping {
  x0: number;
  y0: number;
  sx: number;
  sy: number;
  sz: number;
}
const IDENTITY: Mapping = { x0: 0, y0: 0, sx: 1, sy: 1, sz: 1 };

function pack(landmarks: NormalizedLandmark[], withVisibility: boolean, m: Mapping): Float32Array {
  const out = new Float32Array(landmarks.length * STRIDE);
  for (let i = 0; i < landmarks.length; i++) {
    const l = landmarks[i];
    out[i * STRIDE] = m.x0 + l.x * m.sx;
    out[i * STRIDE + 1] = m.y0 + l.y * m.sy;
    out[i * STRIDE + 2] = l.z * m.sz;
    out[i * STRIDE + 3] = withVisibility ? l.visibility : 1;
  }
  return out;
}

function expressionsFrom(blendshapes: Classifications | undefined): Float32Array {
  const s: Record<string, number> = {};
  for (const c of blendshapes?.categories ?? []) s[c.categoryName] = c.score;
  const avg = (a: string, b: string) => ((s[a] ?? 0) + (s[b] ?? 0)) / 2;
  const values: Record<Expression, number> = {
    smile: avg("mouthSmileLeft", "mouthSmileRight"),
    jawOpen: s.jawOpen ?? 0,
    blinkLeft: s.eyeBlinkLeft ?? 0,
    blinkRight: s.eyeBlinkRight ?? 0,
    browUp: Math.max(s.browInnerUp ?? 0, avg("browOuterUpLeft", "browOuterUpRight")),
    browDown: avg("browDownLeft", "browDownRight"),
    eyeWide: avg("eyeWideLeft", "eyeWideRight"),
    pucker: s.mouthPucker ?? 0,
    cheekPuff: s.cheekPuff ?? 0,
    frown: avg("mouthFrownLeft", "mouthFrownRight"),
  };
  return Float32Array.from(EXPRESSIONS, (e) => values[e]);
}

async function createDetector(modelUrl: string, delegate: Delegate, count: number): Promise<Detector> {
  const base = { baseOptions: { modelAssetPath: modelUrl, delegate }, runningMode: "VIDEO" as const };
  wasmGlobals.ModuleFactory = moduleFactory;
  switch (kind) {
    case "pose": {
      const lm = await PoseLandmarker.createFromOptions(fileset!, { ...base, numPoses: count });
      return { detect: (s, t) => ({ landmarks: lm.detectForVideo(s, t).landmarks }), close: () => lm.close() };
    }
    case "hands": {
      const lm = await HandLandmarker.createFromOptions(fileset!, {
        ...base,
        numHands: count,
        // Seuils un peu plus bas : en gros plan, les faux positifs sont rares.
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      return {
        detect: (s, t) => {
          const r = lm.detectForVideo(s, t);
          return { landmarks: r.landmarks, labels: r.handedness.map((h) => h[0]?.categoryName) };
        },
        close: () => lm.close(),
      };
    }
    case "face": {
      const lm = await FaceLandmarker.createFromOptions(fileset!, {
        ...base,
        numFaces: count,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
      });
      return {
        detect: (s, t) => {
          const r = lm.detectForVideo(s, t);
          return { landmarks: r.faceLandmarks, expressions: r.faceLandmarks.map((_, i) => expressionsFrom(r.faceBlendshapes[i])) };
        },
        close: () => lm.close(),
      };
    }
  }
}

function closeAll(): void {
  fullDetector?.close();
  fullDetector = null;
  for (const d of zoneDetectors.values()) d.close();
  zoneDetectors.clear();
}

/** (Re)crée les détecteurs. GPU (WebGL2 sur OffscreenCanvas) d'abord, CPU en secours. */
async function load(modelUrl: string): Promise<void> {
  closeAll();
  const zones = kind === "hands" ? ["left", "right"] : kind === "face" ? ["face"] : [];
  for (const delegate of ["GPU", "CPU"] as const) {
    try {
      fullDetector = await createDetector(modelUrl, delegate, maxItems);
      for (const zone of zones) zoneDetectors.set(zone, await createDetector(modelUrl, delegate, 1));
      // Préchauffage : la première inférence compile les shaders GPU (plusieurs secondes).
      // On la fait ici, pendant l'écran de chargement, plutôt que sur les premières images.
      // Timestamps 1, 2… : chaque nouveau détecteur repart de zéro, les vraies images suivent.
      const blank = new OffscreenCanvas(CROP_SIZE, CROP_SIZE);
      blank.getContext("2d")!.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
      for (const d of [fullDetector, ...zoneDetectors.values()]) for (let t = 1; t <= 2; t++) d.detect(blank, t);
      post({ type: "ready", delegate, gpu: gpuName() });
      return;
    } catch (err) {
      closeAll();
      if (delegate === "CPU") throw err;
      console.warn(`[${kind}] GPU indisponible, repli sur CPU`, err);
    }
  }
}

/** Copie la zone dans le canvas de découpe (les parties hors image restent noires). */
function cropZone(frame: VideoFrame, roi: Roi): boolean {
  const w = frame.displayWidth;
  const h = frame.displayHeight;
  const x0 = Math.max(0, roi.x);
  const y0 = Math.max(0, roi.y);
  const x1 = Math.min(w, roi.x + roi.size);
  const y1 = Math.min(h, roi.y + roi.size);
  if (x1 - x0 < 2 || y1 - y0 < 2) return false;
  const k = CROP_SIZE / roi.size;
  cropCtx.fillStyle = "#000";
  cropCtx.fillRect(0, 0, CROP_SIZE, CROP_SIZE);
  cropCtx.drawImage(frame, x0, y0, x1 - x0, y1 - y0, (x0 - roi.x) * k, (y0 - roi.y) * k, (x1 - x0) * k, (y1 - y0) * k);
  return true;
}

function toDetections(raw: RawResult, m: Mapping, key?: string): Detection[] {
  return raw.landmarks.map((l, i) => ({
    points: pack(l, kind === "pose", m),
    label: raw.labels?.[i],
    expressions: raw.expressions?.[i],
    key,
  }));
}

function detect(frame: VideoFrame, timestamp: number, rois: Roi[] | null): Detection[] {
  if (!rois || kind === "pose") return fullDetector ? toDetections(fullDetector.detect(frame, timestamp), IDENTITY) : [];

  const w = frame.displayWidth;
  const h = frame.displayHeight;
  const out: Detection[] = [];
  for (const roi of rois) {
    const detector = zoneDetectors.get(roi.key.split("/")[1]);
    if (!detector || !cropZone(frame, roi)) continue;
    const mapping = { x0: roi.x / w, y0: roi.y / h, sx: roi.size / w, sy: roi.size / h, sz: roi.size / w };
    // Une seule détection par zone : la clé de la zone donne son identité.
    out.push(...toDetections(detector.detect(crop, timestamp), mapping, roi.key).slice(0, 1));
  }
  return out;
}

/** Nom de la carte graphique réellement utilisée par le navigateur (diagnostic). */
function gpuName(): string {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2");
  if (!gl) return "WebGL2 indisponible";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 with Max-Q Design (0x00001F11) Direct3D11 …)" → "NVIDIA GeForce RTX 2060 …"
  return name.match(/ANGLE \([^,]+, (.+?) \(0x[0-9a-f]+\)/i)?.[1] ?? name;
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case "init":
        kind = msg.kind;
        maxItems = msg.maxItems;
        // Variante ES module du runtime WASM : requise dans un worker de type module.
        fileset = await FilesetResolver.forVisionTasks(msg.wasmUrl, true);
        moduleFactory = ((await import(/* @vite-ignore */ fileset.wasmLoaderPath)) as { default: unknown }).default;
        await load(msg.modelUrl);
        break;
      case "model":
        await load(msg.modelUrl);
        break;
      case "frame": {
        const t0 = performance.now();
        let detections: Detection[] = [];
        try {
          detections = detect(msg.frame, msg.timestamp, msg.rois);
        } finally {
          msg.frame.close();
        }
        const transfer: Transferable[] = [];
        for (const d of detections) {
          transfer.push(d.points.buffer);
          if (d.expressions) transfer.push(d.expressions.buffer);
        }
        post({ type: "result", timestamp: msg.timestamp, inferMs: performance.now() - t0, detections }, transfer);
        break;
      }
    }
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

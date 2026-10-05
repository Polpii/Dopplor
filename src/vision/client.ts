import type { Delegate, Detection, FromWorker, Roi, TaskKind, ToWorker } from "./protocol";

const BASE = import.meta.env.BASE_URL;
// Servis en local depuis public/ (voir scripts/setup-assets.mjs). URL absolues : le worker
// résout les chemins relatifs par rapport à son propre script.
const WASM_URL = new URL(`${BASE}mediapipe/wasm`, location.href).href;
export const modelUrl = (file: string) => new URL(`${BASE}models/${file}`, location.href).href;

/** Pilote un worker d'inférence depuis le thread principal. */
export class VisionClient {
  private worker = new Worker(new URL("./vision.worker.ts", import.meta.url), { type: "module" });
  /** Vrai tant qu'une frame est en cours de traitement (ou que le modèle charge). */
  private busy = true;
  private resultsInWindow = 0;
  private windowStart = performance.now();

  enabled = true;
  delegate: Delegate | null = null;
  gpu = "";
  fps = 0;
  inferMs = 0;

  onResult: (detections: Detection[], timestamp: number) => void = () => {};
  onError: (message: string) => void = () => {};
  private onReady: () => void = () => {};

  constructor(
    readonly kind: TaskKind,
    modelFile: string,
    maxItems: number,
  ) {
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => this.handle(e.data);
    this.worker.onerror = (e) => this.onError(e.message || `Worker ${kind} en échec`);
    this.send({ type: "init", kind, modelUrl: modelUrl(modelFile), wasmUrl: WASM_URL, maxItems });
  }

  /** Résolu quand le modèle est chargé. */
  ready(): Promise<void> {
    return this.delegate && !this.busy ? Promise.resolve() : new Promise((resolve) => (this.onReady = resolve));
  }

  get wantsFrame(): boolean {
    return this.enabled && !this.busy;
  }

  /**
   * Transfère la frame au worker (sans copie). Ne jamais appeler quand `wantsFrame` est faux :
   * on saute les frames plutôt que de les empiler, pour garder une latence minimale.
   */
  process(frame: VideoFrame, timestamp: number, rois: Roi[] | null = null): void {
    this.busy = true;
    this.send({ type: "frame", frame, timestamp, rois }, [frame]);
  }

  async setModel(modelFile: string): Promise<void> {
    this.busy = true;
    this.delegate = null;
    this.send({ type: "model", modelUrl: modelUrl(modelFile) });
    await this.ready();
  }

  private handle(msg: FromWorker): void {
    switch (msg.type) {
      case "ready":
        this.delegate = msg.delegate;
        this.gpu = msg.gpu;
        this.busy = false;
        this.onReady();
        break;
      case "result": {
        // Pendant un changement de modèle, on reste « occupé » jusqu'au message ready.
        if (this.delegate !== null) this.busy = false;
        this.inferMs += (msg.inferMs - this.inferMs) * 0.1;
        this.resultsInWindow++;
        const now = performance.now();
        if (now - this.windowStart >= 500) {
          this.fps = (this.resultsInWindow * 1000) / (now - this.windowStart);
          this.resultsInWindow = 0;
          this.windowStart = now;
        }
        // Un résultat qui arrive après une désactivation est ignoré.
        if (this.enabled) this.onResult(msg.detections, msg.timestamp);
        break;
      }
      case "error":
        this.busy = false;
        this.onError(msg.message);
        break;
    }
  }

  private send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }
}

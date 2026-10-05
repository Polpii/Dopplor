// Source « navigateur » : webcam lue par Chrome, MediaPipe dans des Web Workers (WebGL).
// Utilisée quand aucun serveur Python n'est disponible (ex. développement avec Vite).
import { startCamera } from "../camera";
import type { Scene } from "../scene";
import { VisionClient } from "./client";
import type { PoseModel, Roi, TaskKind } from "./protocol";
import { faceRois, handRois, trackedBody } from "./roi";
import type { VisionSource } from "./source";

const MAX_PEOPLE = 1;
const POSE_MODELS: PoseModel[] = ["lite", "full", "heavy"];
const poseFile = (m: PoseModel) => `pose_landmarker_${m}.task`;

export class WebSource implements VisionSource {
  readonly label = "navigateur";
  onResult: VisionSource["onResult"] = () => {};
  onError: VisionSource["onError"] = () => {};

  private poseModel: PoseModel = "full";
  private clients: Record<TaskKind, VisionClient>;
  private zoomed: Record<TaskKind, boolean> = { pose: false, hands: false, face: false };
  private lastPoseCapture = 0;
  private frames = 0;
  private fps = 0;

  private constructor(
    private video: HTMLVideoElement,
    private scene: Scene,
  ) {
    this.clients = {
      pose: new VisionClient("pose", poseFile(this.poseModel), MAX_PEOPLE),
      hands: new VisionClient("hands", "hand_landmarker.task", MAX_PEOPLE * 2),
      face: new VisionClient("face", "face_landmarker.task", MAX_PEOPLE),
    };
    for (const c of Object.values(this.clients)) {
      c.onResult = (detections, timestamp) => {
        if (c.kind === "pose") this.lastPoseCapture = timestamp;
        this.onResult(c.kind, detections, timestamp);
      };
      c.onError = (message) => this.onError(`${c.kind} : ${message}`);
    }
  }

  static async start(video: HTMLVideoElement, scene: Scene, onStatus: (text: string) => void): Promise<WebSource> {
    onStatus("Accès à la caméra…");
    await startCamera(video);
    onStatus("Chargement des modèles…");
    const source = new WebSource(video, scene);
    await Promise.all(Object.values(source.clients).map((c) => c.ready()));
    source.loop();
    return source;
  }

  /**
   * À chaque nouvelle image caméra, une VideoFrame clonée (sans copie) par worker libre. Mains et
   * visage sont cherchés dans des zones déduites du squelette ; sans corps, dans l'image entière.
   */
  private loop(): void {
    const all = Object.values(this.clients);
    let windowStart = performance.now();
    const onVideoFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
      // Heure de capture réelle quand le navigateur la fournit : sert au lissage et à la latence.
      const captured = meta.captureTime ?? now;
      const free = all.filter((c) => c.wantsFrame);
      if (free.length > 0) {
        const frame = new VideoFrame(this.video, { timestamp: Math.round(captured * 1000) });
        const body = trackedBody(this.scene);
        const { videoWidth: w, videoHeight: h } = this.video;
        for (const c of free) {
          let rois: Roi[] | null = null;
          if (body && c.kind === "hands") rois = handRois(body, w, h, captured);
          if (body && c.kind === "face") rois = faceRois(body, w, h, captured);
          this.zoomed[c.kind] = rois !== null;
          c.process(frame.clone(), captured, rois);
        }
        frame.close();
      }
      this.frames++;
      if (now - windowStart >= 1000) {
        this.fps = (this.frames * 1000) / (now - windowStart);
        this.frames = 0;
        windowStart = now;
      }
      this.video.requestVideoFrameCallback(onVideoFrame);
    };
    this.video.requestVideoFrameCallback(onVideoFrame);
  }

  frameSize(): [number, number] {
    return [this.video.videoWidth, this.video.videoHeight];
  }

  gpu(): string {
    return this.clients.pose.gpu;
  }

  cameraText(): string {
    return `webcam · ${this.video.videoWidth}×${this.video.videoHeight} · ${Math.round(this.fps)} fps`;
  }

  taskText(kind: TaskKind): string {
    const c = this.clients[kind];
    if (!c.enabled) return "désactivé";
    const mode = kind === "pose" ? `${this.poseModel} · ` : this.zoomed[kind] ? "zoom · " : "plein cadre · ";
    return `${mode}${c.delegate ?? "…"} · ${Math.round(c.fps)} fps · ${c.inferMs.toFixed(1)} ms`;
  }

  toggle(kind: TaskKind): boolean {
    const c = this.clients[kind];
    c.enabled = !c.enabled;
    return c.enabled;
  }

  async cyclePoseModel(): Promise<void> {
    this.poseModel = POSE_MODELS[(POSE_MODELS.indexOf(this.poseModel) + 1) % POSE_MODELS.length];
    await this.clients.pose.setModel(poseFile(this.poseModel));
  }

  setCameraView(): void {
    // La vidéo est déjà affichée sous le canvas ; la classe CSS du body gère sa visibilité.
  }

  latency(): number | null {
    return this.lastPoseCapture ? performance.now() - this.lastPoseCapture : null;
  }
}

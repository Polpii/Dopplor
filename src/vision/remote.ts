// Source « python » : le serveur (server/server.py) lit la caméra et fait tourner MediaPipe en
// natif sur le GPU ; on reçoit seulement les points, en binaire, par WebSocket.
import type { CalibrationData, MirrorInfo } from "../calibration";
import type { Detection, PoseModel, TaskKind } from "./protocol";
import type { Space, VisionSource } from "./source";

const POSE_MODELS: PoseModel[] = ["lite", "full", "heavy"];

interface Hello {
  type: "hello";
  width: number;
  height: number;
  camera: string;
  gpu: string;
  delegates: Record<TaskKind, string>;
  poseModel: PoseModel;
  enabled: Record<TaskKind, boolean>;
  mirror?: MirrorInfo;
}

interface Stats {
  type: "stats";
  cameraFps: number;
  poseModel: PoseModel;
  delegates: Record<TaskKind, string>;
  mirror?: MirrorInfo;
  tasks: Record<TaskKind, { fps: number; infer: number; zoom: boolean; enabled: boolean }>;
}

interface ResultHeader {
  type: "result";
  kind: TaskKind;
  t: number;
  wall: number;
  infer: number;
  zoom: boolean;
  space?: Space;
  eye?: [number, number];
  dets: { n: number; key?: string; label?: string; expr?: number[] }[];
}

const decoder = new TextDecoder();

export class RemoteSource implements VisionSource {
  readonly label = "python";
  onResult: VisionSource["onResult"] = () => {};
  onError: VisionSource["onError"] = () => {};

  private ws!: WebSocket;
  private hello!: Hello;
  private stats: Stats | null = null;
  private enabled: Record<TaskKind, boolean> = { pose: true, hands: true, face: true };
  private poseModel: PoseModel = "full";
  private lastWall = 0;
  private wantPreview = false;
  private previewUrl = "";
  private mirrorInfo: MirrorInfo | null = null;
  private resultSpace: Space = "camera";
  private eyeOnGlass: [number, number] | null = null;

  private constructor(
    private url: string,
    private preview: HTMLImageElement,
  ) {}

  /** Se connecte et attend le message d'accueil du serveur. */
  static connect(url: string, preview: HTMLImageElement): Promise<RemoteSource> {
    const source = new RemoteSource(url, preview);
    return source.open().then(() => source);
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      let greeted = false;
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          const msg = JSON.parse(e.data) as Hello | Stats;
          if (msg.type === "hello") {
            this.hello = msg;
            this.mirrorInfo = msg.mirror ?? null;
            this.enabled = { ...msg.enabled };
            this.poseModel = msg.poseModel;
            // Reconnexion : on réapplique ce que l'utilisateur avait choisi.
            for (const kind of Object.keys(this.enabled) as TaskKind[]) this.send({ cmd: "enable", kind, on: this.enabled[kind] });
            if (this.wantPreview) this.send({ cmd: "preview", on: true });
            if (!greeted) {
              greeted = true;
              resolve();
            }
          } else if (msg.type === "stats") {
            this.stats = msg;
            this.poseModel = msg.poseModel;
            this.mirrorInfo = msg.mirror ?? this.mirrorInfo;
          }
        } else {
          this.handleBinary(e.data as ArrayBuffer);
        }
      };
      ws.onclose = () => {
        if (!greeted) reject(new Error(`Serveur Python injoignable (${this.url})`));
        else {
          this.onError("Serveur Python déconnecté, reconnexion…");
          setTimeout(() => this.open().then(() => this.onError("")).catch(() => {}), 1000);
        }
      };
      this.ws = ws;
    });
  }

  private handleBinary(buffer: ArrayBuffer): void {
    const headerLength = new DataView(buffer).getUint32(0, true);
    const header = JSON.parse(decoder.decode(new Uint8Array(buffer, 4, headerLength))) as ResultHeader | { type: "preview" };
    let offset = 4 + headerLength;
    offset += (4 - (offset % 4)) % 4;

    if (header.type === "preview") {
      if (!this.wantPreview) return;
      const url = URL.createObjectURL(new Blob([new Uint8Array(buffer, offset)], { type: "image/jpeg" }));
      this.preview.src = url;
      if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = url;
      return;
    }

    const detections: Detection[] = header.dets.map((d) => {
      const points = new Float32Array(buffer, offset, d.n * 4);
      offset += d.n * 16;
      return { points, key: d.key, label: d.label, expressions: d.expr ? Float32Array.from(d.expr) : undefined };
    });
    if (header.kind === "pose") {
      this.lastWall = header.wall;
      this.resultSpace = header.space ?? "camera";
      this.eyeOnGlass = header.eye ?? null;
    }
    // Daté à l'heure murale de capture : même horloge que Date.now() côté page (mesures de retard).
    if (this.enabled[header.kind]) this.onResult(header.kind, detections, header.wall);
  }

  private send(cmd: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
  }

  frameSize(): [number, number] {
    return [this.hello.width, this.hello.height];
  }

  gpu(): string {
    return this.hello.gpu;
  }

  cameraText(): string {
    const fps = this.stats ? `${Math.round(this.stats.cameraFps)} fps` : "…";
    return `${this.hello.camera} · ${this.hello.width}×${this.hello.height} · ${fps}`;
  }

  taskText(kind: TaskKind): string {
    if (!this.enabled[kind]) return "désactivé";
    const s = this.stats?.tasks[kind];
    const delegate = this.stats?.delegates[kind] ?? this.hello.delegates[kind];
    const mode = kind === "pose" ? `${this.poseModel} · ` : s?.zoom ? "zoom · " : "plein cadre · ";
    return s ? `${mode}${delegate} · ${Math.round(s.fps)} fps · ${s.infer.toFixed(1)} ms` : `${mode}${delegate}`;
  }

  toggle(kind: TaskKind): boolean {
    this.enabled[kind] = !this.enabled[kind];
    this.send({ cmd: "enable", kind, on: this.enabled[kind] });
    return this.enabled[kind];
  }

  async cyclePoseModel(): Promise<void> {
    const next = POSE_MODELS[(POSE_MODELS.indexOf(this.poseModel) + 1) % POSE_MODELS.length];
    this.send({ cmd: "model", model: next });
  }

  setCameraView(on: boolean): void {
    this.wantPreview = on;
    this.send({ cmd: "preview", on });
  }

  latency(): number | null {
    return this.lastWall ? Date.now() - this.lastWall : null;
  }

  space(): Space {
    return this.resultSpace;
  }

  mirror(): MirrorInfo | null {
    return this.mirrorInfo;
  }

  eye(): [number, number] | null {
    return this.eyeOnGlass;
  }

  apiBase(): string {
    return this.url.replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  setCalibration(data: Partial<CalibrationData>): void {
    this.send({ cmd: "calibration", data });
  }
}

/**
 * Faut-il utiliser le serveur Python ? Oui si la page est servie par lui (/api/info répond),
 * ou si l'URL contient ?server=hôte:port. ?source=web force l'inférence dans le navigateur.
 */
export async function findServer(): Promise<string | null> {
  const params = new URLSearchParams(location.search);
  if (params.get("source") === "web") return null;
  const server = params.get("server");
  if (server) return `ws://${server}/ws`;
  try {
    const res = await fetch("/api/info", { cache: "no-store" });
    const info = (await res.json()) as { type?: string };
    if (info.type === "hello") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  } catch {
    // Pas de serveur Python (ex. serveur de dev Vite) : inférence dans le navigateur.
  }
  return null;
}

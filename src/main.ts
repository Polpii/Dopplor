import { startCamera } from "./camera";
import { NeonRenderer } from "./render/neon-renderer";
import { Scene } from "./scene";
import { VisionClient } from "./vision/client";
import { EXPRESSIONS, type Expression, type PoseModel, type Roi, type TaskKind } from "./vision/protocol";
import { faceRois, handRois, trackedBody } from "./vision/roi";

// Un miroir = une personne devant. Avec 2, le modèle « invente » parfois un second corps fantôme.
const MAX_PEOPLE = 1;
const POSE_MODELS: PoseModel[] = ["lite", "full", "heavy"];
const poseFile = (m: PoseModel) => `pose_landmarker_${m}.task`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("camera");
const canvas = $<HTMLCanvasElement>("overlay");
const status = $("status");
const hud = $("hud");
const hudBg = $("hud-bg");
const hudRender = $("hud-render");
const hudGpu = $("hud-gpu");
const hudTask: Record<TaskKind, HTMLElement> = { pose: $("hud-pose"), hands: $("hud-hands"), face: $("hud-face") };
const hudExpression = $("hud-expression");

const EXPRESSION_NAMES: Record<Expression, string> = {
  smile: "sourire",
  jawOpen: "bouche ouverte",
  blinkLeft: "clin d'œil",
  blinkRight: "clin d'œil",
  browUp: "sourcils levés",
  browDown: "sourcils froncés",
  eyeWide: "yeux écarquillés",
  pucker: "bisou",
  cheekPuff: "joues gonflées",
  frown: "moue",
};

function setStatus(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle("error", isError);
  status.classList.toggle("hidden", text === "");
}

async function main(): Promise<void> {
  setStatus("Accès à la caméra…");
  await startCamera(video);

  setStatus("Chargement des modèles…");
  let poseModel: PoseModel = "full";
  const clients: Record<TaskKind, VisionClient> = {
    pose: new VisionClient("pose", poseFile(poseModel), MAX_PEOPLE),
    hands: new VisionClient("hands", "hand_landmarker.task", MAX_PEOPLE * 2),
    face: new VisionClient("face", "face_landmarker.task", MAX_PEOPLE),
  };
  const all = Object.values(clients);

  const scene = new Scene();
  const renderer = new NeonRenderer(canvas);
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __Scene: Scene }); // inspection depuis la console
  for (const client of all) {
    client.onResult = (detections, timestamp) => scene.update(client.kind, detections, timestamp);
    client.onError = (message) => setStatus(`Erreur (${client.kind}) : ${message}`, true);
  }
  await Promise.all(all.map((c) => c.ready()));
  setStatus("");

  // Capture : à chaque nouvelle image caméra, une VideoFrame clonée (sans copie) par worker libre.
  // Mains et visage sont cherchés dans des zones déduites du squelette (gros plan en pleine
  // résolution) ; sans corps suivi, on cherche dans l'image entière.
  const zoomed: Record<TaskKind, boolean> = { pose: false, hands: false, face: false };
  const onVideoFrame = (now: number) => {
    const free = all.filter((c) => c.wantsFrame);
    if (free.length > 0) {
      const frame = new VideoFrame(video, { timestamp: Math.round(now * 1000) });
      const body = trackedBody(scene);
      const { videoWidth: w, videoHeight: h } = video;
      for (const c of free) {
        let rois: Roi[] | null = null;
        if (body && c.kind === "hands") rois = handRois(body, w, h, now);
        if (body && c.kind === "face") rois = faceRois(body, w, h, now);
        zoomed[c.kind] = rois !== null;
        c.process(frame.clone(), now, rois);
      }
      frame.close();
    }
    video.requestVideoFrameCallback(onVideoFrame);
  };
  video.requestVideoFrameCallback(onVideoFrame);

  // Rendu : découplé de l'inférence, on ne redessine que quand la scène change.
  let drawnVersion = -1;
  let draws = 0;
  const onAnimationFrame = (now: number) => {
    const fading = scene.prune(now);
    if (fading || scene.version !== drawnVersion) {
      renderer.render(scene, now, video.videoWidth, video.videoHeight);
      drawnVersion = scene.version;
      draws++;
    }
    requestAnimationFrame(onAnimationFrame);
  };
  requestAnimationFrame(onAnimationFrame);

  // Panneau d'infos, rafraîchi deux fois par seconde.
  const updateHud = () => {
    hudBg.textContent = document.body.classList.contains("black") ? "écran noir" : "flux caméra";
    hudRender.textContent = `${draws * 2} img/s · ${video.videoWidth}×${video.videoHeight}`;
    hudGpu.textContent = clients.pose.gpu || "…";
    hudGpu.classList.toggle("warn", /Radeon\(TM\) Graphics|Intel|SwiftShader|llvmpipe|Basic Render/i.test(clients.pose.gpu));
    draws = 0;
    for (const c of all) {
      const mode = c.kind === "pose" ? `${poseModel} · ` : zoomed[c.kind] ? "zoom · " : "plein cadre · ";
      hudTask[c.kind].textContent = c.enabled
        ? `${mode}${c.delegate ?? "…"} · ${Math.round(c.fps)} fps · ${c.inferMs.toFixed(1)} ms`
        : "désactivé";
    }
    // Expressions les plus marquées du visage suivi.
    const face = scene.faces[Symbol.iterator]().next().value;
    const shown = face?.expressions
      ? [...new Set(EXPRESSIONS.filter((e) => Scene.expression(face, e) > 0.5).map((e) => EXPRESSION_NAMES[e]))]
      : [];
    hudExpression.textContent = !face?.expressions ? "–" : shown.length ? shown.join(" · ") : "neutre";
  };
  updateHud();
  setInterval(updateHud, 500);

  const toggle = (kind: TaskKind) => {
    const c = clients[kind];
    c.enabled = !c.enabled;
    if (!c.enabled) scene.clear(kind);
  };

  window.addEventListener("keydown", async (e) => {
    if (e.repeat) return;
    switch (e.key.toLowerCase()) {
      case "c":
        document.body.classList.toggle("black");
        break;
      case "1":
        toggle("pose");
        break;
      case "2":
        toggle("hands");
        break;
      case "3":
        toggle("face");
        break;
      case "p":
        poseModel = POSE_MODELS[(POSE_MODELS.indexOf(poseModel) + 1) % POSE_MODELS.length];
        hudTask.pose.textContent = `chargement ${poseModel}…`;
        await clients.pose.setModel(poseFile(poseModel));
        break;
      case "f":
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
        break;
      case "h":
        hud.classList.toggle("hidden");
        break;
      default:
        return;
    }
    updateHud();
  });
}

main().catch((err: unknown) => {
  console.error(err);
  const denied = err instanceof DOMException && err.name === "NotAllowedError";
  setStatus(denied ? "Accès caméra refusé — autorise la caméra puis recharge." : `Erreur : ${String(err)}`, true);
});

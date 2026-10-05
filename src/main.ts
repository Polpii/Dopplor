import { NeonRenderer } from "./render/neon-renderer";
import { Scene } from "./scene";
import { EXPRESSIONS, type Expression, type TaskKind } from "./vision/protocol";
import { RemoteSource, findServer } from "./vision/remote";
import type { VisionSource } from "./vision/source";
import { WebSource } from "./vision/web-source";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("camera");
const preview = $<HTMLImageElement>("preview");
const canvas = $<HTMLCanvasElement>("overlay");
const status = $("status");
const hud = $("hud");
const hudBg = $("hud-bg");
const hudSource = $("hud-source");
const hudCamera = $("hud-camera");
const hudRender = $("hud-render");
const hudLatency = $("hud-latency");
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
  const scene = new Scene();
  const renderer = new NeonRenderer(canvas);
  if (import.meta.env.DEV) Object.assign(window, { __scene: scene, __Scene: Scene }); // inspection depuis la console

  // Serveur Python s'il y en a un (caméra + MediaPipe natif), sinon tout dans le navigateur.
  setStatus("Connexion…");
  const server = await findServer();
  const source: VisionSource = server ? await RemoteSource.connect(server, preview) : await WebSource.start(video, scene, setStatus);
  document.body.classList.add(`source-${source.label}`);
  source.onResult = (kind, detections, timestamp) => scene.update(kind, detections, timestamp);
  source.onError = (message) => setStatus(message, message !== "");
  setStatus("");

  // Rendu : découplé de l'inférence, on ne redessine que quand la scène change.
  let drawnVersion = -1;
  let draws = 0;
  let latency = 0;
  const onAnimationFrame = (now: number) => {
    const fading = scene.prune(now);
    if (fading || scene.version !== drawnVersion) {
      const [w, h] = source.frameSize();
      renderer.render(scene, now, w, h);
      drawnVersion = scene.version;
      draws++;
      // Latence capture → image dessinée (hors affichage de l'écran lui-même).
      const l = source.latency();
      if (l !== null && l < 1000) latency += (l - latency) * 0.1;
    }
    requestAnimationFrame(onAnimationFrame);
  };
  requestAnimationFrame(onAnimationFrame);

  // Panneau d'infos, rafraîchi deux fois par seconde.
  const updateHud = () => {
    const [w, h] = source.frameSize();
    hudBg.textContent = document.body.classList.contains("black") ? "écran noir" : "flux caméra";
    hudSource.textContent = source.label === "python" ? "python (natif)" : "navigateur";
    hudCamera.textContent = source.cameraText();
    hudRender.textContent = `${draws * 2} img/s · ${w}×${h}`;
    hudLatency.textContent = latency ? `${Math.round(latency)} ms capture → rendu` : "–";
    hudGpu.textContent = source.gpu() || "…";
    hudGpu.classList.toggle("warn", /Radeon\(TM\) Graphics|Intel|SwiftShader|llvmpipe|Basic Render|^CPU$/i.test(source.gpu()));
    draws = 0;
    for (const kind of Object.keys(hudTask) as TaskKind[]) hudTask[kind].textContent = source.taskText(kind);
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
    if (!source.toggle(kind)) scene.clear(kind);
  };

  window.addEventListener("keydown", async (e) => {
    if (e.repeat) return;
    switch (e.key.toLowerCase()) {
      case "c":
        document.body.classList.toggle("black");
        source.setCameraView(!document.body.classList.contains("black"));
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
        hudTask.pose.textContent = "changement de modèle…";
        await source.cyclePoseModel();
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

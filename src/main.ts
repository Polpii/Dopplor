import { CalibrationPanel } from "./calibration";
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
const hudPrediction = $("hud-prediction");

/** Latence compensée par la prédiction (ms), réglable avec les flèches et retenue d'une fois sur l'autre. */
const LEAD_KEY = "dopplor.predictionMs";
// 80 ms : mesuré sur la vidéo de test, ramène le retard de notre chaîne (inférence, lissage,
// rendu) à ~0. Plus haut, on compense aussi la caméra et l'écran, au prix de dépassements.
const LEAD_DEFAULT = 80;
const LEAD_STEP = 10;
/** Plafond du rendu continu (prédiction) quand l'écran n'impose plus de synchronisation. */
const MAX_RENDER_FPS = 144;
const LEAD_MAX = 200;
function loadLead(): number {
  try {
    const v = Number(localStorage.getItem(LEAD_KEY));
    return Number.isFinite(v) && localStorage.getItem(LEAD_KEY) !== null ? v : LEAD_DEFAULT;
  } catch {
    return LEAD_DEFAULT;
  }
}
function saveLead(v: number): void {
  try {
    localStorage.setItem(LEAD_KEY, String(v));
  } catch {
    // Stockage indisponible : la valeur ne sera simplement pas retenue.
  }
}

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
  const calibration = new CalibrationPanel((data) => source.setCalibration?.(data));

  // Rendu : découplé de l'inférence. Avec la prédiction, les points avancent à chaque
  // rafraîchissement de l'écran tant que quelqu'un est suivi ; sinon on ne redessine que quand
  // la scène change.
  let lead = loadLead();
  let drawnVersion = -1;
  let lastDraw = 0;
  let draws = 0;
  let latency = 0;
  const onAnimationFrame = (now: number) => {
    const fading = scene.prune(now);
    const predicting = lead > 0 && !scene.empty;
    // Sans vsync (kiosque), requestAnimationFrame n'est plus limité à 60 Hz : on plafonne le rendu
    // « de prédiction » pour ne pas voler la carte graphique à l'inférence. Un nouveau résultat,
    // lui, est dessiné tout de suite.
    const due = now - lastDraw >= 1000 / MAX_RENDER_FPS - 0.5;
    if ((predicting && due) || fading || scene.version !== drawnVersion) {
      lastDraw = now;
      const [w, h] = source.frameSize();
      scene.extrapolate(now, lead);
      renderer.render(scene, now, w, h, source.space?.() ?? "camera");
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
    hudPrediction.textContent = lead > 0 ? `${lead} ms d'avance` : "désactivée";
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
    calibration.update(source.mirror?.() ?? null, source.eye?.() ?? null);
  };
  updateHud();
  setInterval(updateHud, 500);

  const toggle = (kind: TaskKind) => {
    if (!source.toggle(kind)) scene.clear(kind);
  };

  window.addEventListener("keydown", async (e) => {
    if (e.repeat && !e.key.startsWith("Arrow")) return;
    // Pendant la saisie d'une valeur de calibration, les touches servent au champ.
    if (e.target instanceof HTMLInputElement) {
      if (e.key === "Escape") (e.target as HTMLInputElement).blur();
      return;
    }
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
      case "k":
        calibration.toggle();
        document.body.classList.toggle("calibrating", calibration.open);
        break;
      case "arrowup":
      case "arrowdown":
        lead = Math.min(LEAD_MAX, Math.max(0, lead + (e.key === "ArrowUp" ? LEAD_STEP : -LEAD_STEP)));
        saveLead(lead);
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

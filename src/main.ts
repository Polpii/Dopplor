import { CalibrationPanel } from "./calibration";
import { ICONS, Menu, type MenuItem } from "./modes/menu";
import { DanceMode } from "./modes/dance/dance-mode";
import { FairyMode } from "./modes/fairy/fairy-mode";
import { MirrorWorld } from "./modes/fairy/world";
import { Menu3D, type ScreenPose } from "./modes/menu3d";
import { BubbleMode, type Fingertips } from "./modes/bubbles/bubble-mode";
import { PortalMode } from "./modes/portal/portal-mode";
import { STRIDE } from "./vision/protocol";
import { SignLanguageMode } from "./modes/sign-language";
import { NeonRenderer } from "./render/neon-renderer";
import { REFLECTED, Scene } from "./scene";
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
const hudMode = $("hud-mode");

const MODE_NAMES: Record<string, string> = { skeleton: "squelette", signs: "langue des signes", dance: "danse", fairy: "fée", bubbles: "bulles", portal: "portail" };

/** Latence compensée par la prédiction (ms), réglable avec les flèches et retenue d'une fois sur l'autre. */
const LEAD_KEY = "dopplor.predictionMs";
// 80 ms : mesuré sur la vidéo de test, ramène le retard de notre chaîne (inférence, lissage,
// rendu) à ~0. Plus haut, on compense aussi la caméra et l'écran, au prix de dépassements.
const LEAD_DEFAULT = 80;
const LEAD_STEP = 10;
/** Plafond du rendu continu (prédiction) quand l'écran n'impose plus de synchronisation. */
const MAX_RENDER_FPS = 144;
const LEAD_MAX = 200;
/** Cadence du double doré (langue des signes, danse). */
const GHOST_FPS = 60;
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
  // Kiosque sans synchronisation verticale (demo.sh ajoute ?novsync) : on ne s'appuie plus sur
  // requestAnimationFrame, que Chrome recadence alors à ~60 Hz dès qu'on ne dessine pas à chaque
  // fois. On dessine dès qu'un résultat arrive, et un minuteur fait avancer la prédiction.
  const noVsync = new URLSearchParams(location.search).has("novsync");
  // Calé sur le reflet, le serveur envoie deux versions : `scene` garde ce que voit la caméra
  // (gestes, modes), `reflected` ce qu'on voit dans le reflet (affichage du squelette).
  const reflected = new Scene(REFLECTED);
  source.onResult = (kind, detections, timestamp, raw) => {
    scene.update(kind, raw ?? detections, timestamp);
    if (raw) reflected.update(kind, detections, timestamp);
    // Rien de détecté (ou pas calé sur le reflet cette fois) : la version reflet aussi perd ses points.
    else if (source.space?.() === "screen") reflected.update(kind, [], timestamp);
    if (noVsync) draw(performance.now());
  };
  source.onError = (message) => setStatus(message, message !== "");
  setStatus("");
  const calibration = new CalibrationPanel((data) => source.setCalibration?.(data));

  // Modes, choisis dans le menu (geste ou touche M) : chacun s'allume ou s'éteint quand on le
  // choisit. Le squelette s'ajoute à ce qu'on fait (on peut danser en le voyant ou non) ; la
  // langue des signes et la danse sont des activités, une seule à la fois. Au démarrage, seul le
  // squelette est allumé (on peut l'éteindre dans le menu).
  const ghost = new Scene(); // double doré (langue des signes, danse)
  const signs = new SignLanguageMode(scene, ghost, () => source.frameSize(), source.apiBase?.() ?? null, () => renderer.visibleArea());
  const dance = new DanceMode(
    scene,
    ghost,
    () => source.frameSize(),
    (x, y) => renderer.toScreen(x, y),
    () => [window.innerWidth, window.innerHeight],
  );
  // Le monde derrière la vitre (3D, Three.js) : la fée et le menu y vivent, vus depuis l'œil de
  // la personne et cachés derrière son reflet (serveur avec profondeur).
  const worldCanvas = document.createElement("canvas");
  worldCanvas.id = "fairy-canvas";
  worldCanvas.className = "hidden";
  document.body.append(worldCanvas);
  const world = new MirrorWorld(worldCanvas);
  window.addEventListener("resize", () => world.resize());
  const screenSize = (): [number, number, number] | null => {
    const c = source.mirror?.()?.calibration;
    return c ? [c.screen_width / 100, c.screen_height / 100, c.glass_gap / 100] : null;
  };
  const occlusion = () => source.occlusion?.() ?? null;
  const fairy = new FairyMode(world, scene, () => source.frameSize(), occlusion);
  let skeleton = true;
  let activity: "signs" | "dance" | "fairy" | "bubbles" | "portal" | null = null;
  const blank = new Scene(); // dessiné à la place de la personne quand le squelette est éteint
  const activeModes = () => [...(skeleton ? ["skeleton"] : []), ...(activity ? [activity] : [])];
  const choose = async (id: string) => {
    if (id === "skeleton") skeleton = !skeleton;
    else if (id === "signs" || id === "dance" || id === "fairy" || id === "bubbles" || id === "portal") {
      const next = activity === id ? null : id;
      if (activity === "signs") signs.exit();
      if (activity === "dance") dance.exit();
      if (activity === "fairy") fairy.exit();
      if (activity === "bubbles") bubbles.exit();
      if (activity === "portal") portal.exit();
      activity = next;
      if (activity === "signs") await signs.enter();
      if (activity === "dance") dance.enter();
      if (activity === "fairy") fairy.enter();
      if (activity === "bubbles") bubbles.enter();
      if (activity === "portal") portal.enter();
    }
    // Visage coupé pendant le portail (la carte graphique va à la pose : œil plus régulier),
    // sauf si le squelette est affiché : il dessine le visage (sinon un simple rond).
    source.setTask?.("face", !(activity === "portal" && !skeleton));
    menu.setActive(activeModes());
    updateHud();
  };
  const items: MenuItem[] = [
    { id: "skeleton", label: "Squelette", icon: ICONS.skeleton },
    { id: "signs", label: "Langue des signes", icon: ICONS.hand },
    { id: "dance", label: "Danse", icon: ICONS.dance },
    { id: "fairy", label: "Fée", icon: ICONS.fairy },
    { id: "bubbles", label: "Bulles", icon: ICONS.bubbles },
    { id: "portal", label: "Portail", icon: ICONS.portal },
  ];
  const menu = new Menu(
    items,
    (x, y) => renderer.toScreen(x, y),
    () => [window.innerWidth, window.innerHeight],
    () => source.frameSize(),
    (id) => void choose(id),
  );
  menu.setActive(activeModes());
  // Bulles en 3D dans le reflet, avec la fée (si le serveur donne l'œil et le corps en 3D).
  // Le reflet tel qu'il est dessiné (px CSS) : paumes, épaules, main grande ouverte.
  const screenPose = (): ScreenPose | null => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const body = [...reflected.bodies].find((b) => b.lostAt === null);
    if (!body) return null;
    const p = body.points;
    const shoulders = Math.hypot((p[11 * 4] - p[12 * 4]) * W, (p[11 * 4 + 1] - p[12 * 4 + 1]) * H);
    const palm: ScreenPose["palm"] = { left: null, right: null };
    for (const h of reflected.hands) {
      if (h.lostAt !== null || !h.side) continue;
      const idx = [0, 5, 9, 13, 17];
      palm[h.side] = [idx.reduce((a, i) => a + h.points[i * 4], 0) / 5 * W, idx.reduce((a, i) => a + h.points[i * 4 + 1], 0) / 5 * H];
    }
    const open = { left: false, right: false };
    for (const hs of menu.lastHands) if (hs.track.side) open[hs.track.side] = hs.extended >= 4 && hs.reach >= 1.5;
    return { palm, shoulders, open };
  };
  const menu3d = new Menu3D(world, items, fairy, screenPose);
  // Bulles : les bouts des doigts du reflet dessiné (px CSS).
  const fingertips = (): Fingertips[] => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out: Fingertips[] = [];
    for (const h of reflected.hands) {
      if (h.lostAt !== null) continue;
      out.push({ tips: [4, 8, 12, 16, 20].map((i): [number, number] => [h.points[i * 4] * W, h.points[i * 4 + 1] * H]) });
    }
    return out;
  };
  const bubbles = new BubbleMode(world, fingertips);
  // Indices pour le portail : les yeux sont-ils bien vus (visibilité MediaPipe), la personne
  // est-elle de face (épaule gauche à droite de la droite dans l'image caméra) ?
  const bodyCues = () => {
    const r = [...reflected.bodies].find((b) => b.lostAt === null);
    if (!r) return null;
    const c = [...scene.bodies].find((b) => b.lostAt === null);
    const vis = (i: number) => r.points[i * STRIDE + 3];
    return { eyeVis: (vis(2) + vis(5)) / 2, facing: c ? c.points[11 * STRIDE] - c.points[12 * STRIDE] : 1 };
  };
  const portal = new PortalMode(world, () => [...reflected.bodies].some((b) => b.lostAt === null), () => source.eyeSample?.() ?? null, bodyCues);
  // Le paysage du portail se calcule à l'avance (quelques centaines de ms), pas à l'ouverture.
  setTimeout(() => portal.prepare(), 5000);
  if (source.setOcclusion) menu.stage = menu3d;
  // La main tendue à plat pour la fée ressemble au geste du menu : pas de menu pendant ce temps.
  menu.paused = () => activity === "fairy" && fairy.holdsHand;
  fairy.busy = () => menu.open;
  if (import.meta.env.DEV) Object.assign(window, { __menu: menu, __ghost: ghost, __signs: signs, __dance: dance, __fairy: fairy });
  // Diagnostic sur le miroir (enregistrement d'une session par le débogueur du kiosque) : instants
  // des rendus et état des modes, aussi dans la version construite.
  const drawTimes: number[] = [];
  Object.assign(window, { __dopplor: { scene, reflected, ghost, signs, dance, fairy, bubbles, portal, menu, menu3d, world, drawTimes, source } });
  setInterval(() => {
    const now = performance.now();
    menu.update(scene, now);
    signs.update(now);
    dance.update(now);
  }, 33);

  // Rendu : découplé de l'inférence. Avec la prédiction, les points avancent à chaque
  // rafraîchissement de l'écran tant que quelqu'un est suivi ; sinon on ne redessine que quand
  // la scène change.
  let lead = loadLead();
  let drawnVersion = -1;
  let drawnGhost = -1;
  let drawnSkeleton = false;
  let uiWasAnimating = false;
  let lastDraw = 0;
  let lastGhost = 0;
  let draws = 0;
  let latency = 0;
  // Recalage caméra → reflet (échelle + décalage, px CSS), ajusté sur le corps de la personne vu
  // des deux façons, et lissé : ce qui se place autour d'elle (double, halos, menu) suit son reflet.
  let fit = { s: 1, x: 0, y: 0, at: 0 };
  const FIT_POINTS = [0, 2, 5, 11, 12, 13, 14, 15, 16, 23, 24];
  const alignment = (now: number) => {
    const a = [...scene.bodies].find((b) => b.lostAt === null);
    const b = [...reflected.bodies].find((t) => t.lostAt === null);
    if (a && b) {
      const c: [number, number][] = [];
      const d: [number, number][] = [];
      for (const i of FIT_POINTS) {
        if (a.points[i * 4 + 3] < 0.5 || b.points[i * 4 + 3] < 0.5) continue;
        c.push(renderer.coverPoint(a.points[i * 4], a.points[i * 4 + 1]));
        d.push([b.points[i * 4] * window.innerWidth, b.points[i * 4 + 1] * window.innerHeight]);
      }
      if (c.length >= 3) {
        const mean = (p: [number, number][]) => p.reduce((m, q) => [m[0] + q[0] / p.length, m[1] + q[1] / p.length], [0, 0]);
        const [cx, cy] = mean(c);
        const [dx, dy] = mean(d);
        let num = 0;
        let den = 0;
        c.forEach((q, i) => {
          num += (q[0] - cx) * (d[i][0] - dx) + (q[1] - cy) * (d[i][1] - dy);
          den += (q[0] - cx) ** 2 + (q[1] - cy) ** 2;
        });
        const sc = den > 0 ? num / den : 0;
        if (sc > 0.05) {
          const target = { s: sc, x: dx - sc * cx, y: dy - sc * cy };
          const k = fit.at ? 1 - Math.exp(-Math.max(0, now - fit.at) / 250) : 1;
          fit = { s: fit.s + (target.s - fit.s) * k, x: fit.x + (target.x - fit.x) * k, y: fit.y + (target.y - fit.y) * k, at: now };
        }
      }
    }
    return fit;
  };
  const draw = (now: number) => {
    // Le monde 3D (fée, menu) : à chaque rafraîchissement de l'écran, sur son propre canevas.
    // Silhouette demandée au serveur : complète quand de la 3D est à l'écran, sinon juste l'œil
    // et les points du corps (de quoi ouvrir le menu en 3D tout de suite).
    const occ = occlusion();
    world.update(occ, now, screenSize());
    // Pendant le menu (poing allumé, ouverture, choix, fermeture), aucune silhouette : rien n'est
    // découpé par le corps, ni la fée, ni les bulles.
    if (menu.animating || menu3d.visible) world.shared.uHasOcc.value = 0;
    fairy.frame(now);
    bubbles.frame(now);
    portal.frame(now);
    menu3d.frame(menu.view(now), now);
    const show3d = fairy.visible || menu3d.visible || bubbles.visible || portal.visible;
    // Carte complète dès que le poing s'allume (menu prêt à s'ouvrir) : elle est déjà là quand
    // les bulles naissent, qui ne passent ainsi jamais devant le corps.
    // Le portail n'a besoin que de l'œil (rien ne le cache) : pas de silhouette à calculer.
    const needMask = fairy.visible || fairy.on || menu3d.visible || menu.animating;
    source.setOcclusion?.(needMask ? 2 : 1);
    world.setVisible(show3d);
    if (show3d) world.render();
    // Le suivi tourne toujours (les modes s'en servent) ; la personne n'est dessinée que si le
    // squelette est allumé.
    const aligned = source.space?.() === "screen";
    const user = aligned ? reflected : scene;
    if (aligned) scene.prune(now);
    else reflected.prune(now);
    const userFading = user.prune(now);
    renderer.setAlignment(aligned ? alignment(now) : null);
    const fading = (skeleton && userFading) || ghost.prune(now);
    const predicting = skeleton && lead > 0 && !user.empty;
    // Rendu « de prédiction » plafonné pour ne pas voler la carte graphique à l'inférence ; un
    // nouveau résultat, lui, est dessiné tout de suite.
    const due = now - lastDraw >= 1000 / MAX_RENDER_FPS - 0.5;
    // Le double avance à la cadence de l'écran (60 Hz), pas plus : au-delà, rien de plus ne
    // s'affiche et la carte graphique est prise à l'inférence (mesuré : pose 12 → 14,5 ms).
    // Synchronisé sur l'écran, chaque image affichée le fait avancer.
    const ghostDue = !noVsync || now - lastGhost >= 1000 / GHOST_FPS - 0.5;
    if (ghostDue && (signs.animating || dance.animating)) {
      lastGhost = now;
      if (signs.animating) signs.animate(now);
      if (dance.animating) dance.animate(now);
    }
    // Une animation du menu ou de la danse vient de finir : encore un rendu, sinon sa dernière
    // image (onde de validation, lueur…) resterait figée à l'écran quand rien d'autre ne
    // redessine (squelette éteint, fée sur son propre canevas).
    const uiAnimating = menu.animating || dance.animating;
    const ui = (menu.animating && due) || (dance.animating && ghostDue) || (uiWasAnimating && !uiAnimating);
    uiWasAnimating = uiAnimating;
    const userChanged = skeleton && user.version !== drawnVersion;
    if ((predicting && due) || ui || fading || userChanged || skeleton !== drawnSkeleton || ghost.version !== drawnGhost) {
      lastDraw = now;
      const [w, h] = source.frameSize();
      // Calé sur le reflet : avance plafonnée à 60 ms (le meilleur sur le banc d'essai).
      // Au-delà, la prédiction dépasse puis revient à chaque arrêt : des sauts (mesuré, 150 ms
      // doublait les plus grands écarts d'une image à l'autre pour le même suivi en mouvement).
      if (skeleton) user.extrapolate(now, aligned ? Math.min(lead, 60) : lead);
      renderer.render(skeleton ? user : blank, now, w, h, aligned ? "screen" : "camera", [ghost], (out) => {
        dance.draw(out, now);
        menu.draw(out, now);
      });
      drawTimes.push(now);
      if (drawTimes.length > 4000) drawTimes.splice(0, 2000);
      drawnVersion = user.version;
      drawnGhost = ghost.version;
      drawnSkeleton = skeleton;
      draws++;
      // Latence capture → image dessinée (hors affichage de l'écran lui-même).
      const l = source.latency();
      if (l !== null && l < 1000) latency += (l - latency) * 0.1;
    }
  };
  if (noVsync) {
    setInterval(() => draw(performance.now()), 1000 / MAX_RENDER_FPS);
  } else {
    const onAnimationFrame = (now: number) => {
      draw(now);
      requestAnimationFrame(onAnimationFrame);
    };
    requestAnimationFrame(onAnimationFrame);
  }

  // Panneau d'infos, rafraîchi deux fois par seconde.
  const updateHud = () => {
    const [w, h] = source.frameSize();
    hudBg.textContent = document.body.classList.contains("black") ? "écran noir" : "flux caméra";
    hudSource.textContent = source.label === "python" ? "python (natif)" : "navigateur";
    hudCamera.textContent = source.cameraText();
    hudRender.textContent = `${draws * 2} img/s · ${w}×${h}`;
    hudLatency.textContent = latency ? `${Math.round(latency)} ms capture → rendu` : "–";
    hudPrediction.textContent = lead > 0 ? `${lead} ms d'avance` : "désactivée";
    hudMode.textContent = activeModes().map((m) => MODE_NAMES[m]).join(" + ") || "rien (miroir)";
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
    if (activity === "signs" && signs.onKey(e)) return;
    if (activity === "dance" && dance.onKey(e)) return;
    // Menu ouvert : 1, 2, 3… choisissent un mode au clavier.
    const pick = menu.open ? items[Number(e.key) - 1] : undefined;
    if (pick) {
      menu.toggle();
      await choose(pick.id);
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
      case "m":
        menu.toggle();
        break;
      case "escape":
        // Ferme le menu, sinon arrête l'activité en cours, sinon éteint le squelette.
        if (menu.open) menu.toggle();
        else if (activity) await choose(activity);
        else if (skeleton) await choose("skeleton");
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

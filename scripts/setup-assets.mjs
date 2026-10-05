// Copie le runtime WASM de MediaPipe et télécharge les modèles (corps, mains, visage) dans public/,
// pour que l'app tourne entièrement en local (pas de CDN ni de réseau en démo).
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasmSrc = path.join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmDst = path.join(root, "public/mediapipe/wasm");
const modelsDir = path.join(root, "public/models");

const BASE = "https://storage.googleapis.com/mediapipe-models";
const MODELS = {
  "pose_landmarker_lite.task": `${BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
  "pose_landmarker_full.task": `${BASE}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
  "pose_landmarker_heavy.task": `${BASE}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task`,
  "hand_landmarker.task": `${BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`,
  "face_landmarker.task": `${BASE}/face_landmarker/face_landmarker/float16/latest/face_landmarker.task`,
};

const exists = (p) => stat(p).then(() => true, () => false);

await mkdir(wasmDst, { recursive: true });
await cp(wasmSrc, wasmDst, { recursive: true });
console.log("✓ WASM MediaPipe copié");

await mkdir(modelsDir, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const file = path.join(modelsDir, name);
  if (await exists(file)) continue;
  process.stdout.write(`↓ ${name}… `);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Téléchargement échoué (${res.status}) : ${url}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  console.log("ok");
}
console.log("✓ Modèles prêts");

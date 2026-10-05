import { defineConfig } from "vite";

export default defineConfig({
  // Workers en ES modules : le runtime WASM de MediaPipe est chargé via import() dans le worker.
  worker: { format: "es" },
});

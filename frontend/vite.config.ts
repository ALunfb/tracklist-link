import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri dev server expects a fixed port so the webview can load the UI
// before the Rust side is ready. 5173 is Vite's default — mirrored in
// tauri.conf.json's `devUrl`.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    sourcemap: true,
    outDir: "dist",
  },
});

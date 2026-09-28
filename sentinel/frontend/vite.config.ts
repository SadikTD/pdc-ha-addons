import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served under Home Assistant ingress at an unknown path prefix, so every URL is relative.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../www", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    // Local development against a running Sentinel (e.g. SENTINEL_DEV=http://192.168.0.226:8099).
    proxy: Object.fromEntries(
      ["/api", "/go2rtc"].map((p) => [p, { target: process.env.SENTINEL_DEV ?? "http://192.168.0.226:8099", ws: true, changeOrigin: true }]),
    ),
  },
});

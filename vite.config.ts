import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  base: "./",
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            // Keep the 3D engine in its own lazy chunk. Lite mode never mounts
            // the runtime component, so this large module is not loaded at all.
            if (id.includes("/three/")) {
              return "three-runtime";
            }
            if (
              id.includes("/react/") ||
              id.includes("/react-dom/") ||
              id.includes("/scheduler/")
            ) {
              return "react-vendor";
            }
            if (
              id.includes("/i18next/") ||
              id.includes("/react-i18next/")
            ) {
              return "i18n-vendor";
            }
            if (id.includes("/@tauri-apps/")) {
              return "tauri-vendor";
            }
            if (id.includes("/lucide-react/")) {
              return "ui-vendor";
            }
            return "vendor";
          }

          if (id.includes("/src/i18n/")) {
            return "i18n-core";
          }

        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. Watch frontend source only. Build output, sidecars and browser-review
      // profiles can contain locked SQLite files and must never crash Vite.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/dist/**",
        "**/build-staging/**",
        "**/sidecars/**",
        "**/third_party/**",
      ],
    },
  },
}));

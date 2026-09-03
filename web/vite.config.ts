import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The workspace-root package.json is the single source of truth for the
// version; it is baked into the bundle at build time.
const rootManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootManifest.version ?? "0.0.0"),
  },
  build: {
    // Pixi is intentionally isolated as the office engine (about 166 kB gzip).
    // Keep the warning threshold above that one audited vendor chunk.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("pixi.js") || id.includes("pixi-filters")) return "pixi";
          if (id.includes("react-markdown") || id.includes("remark-") || id.includes("rehype-") || id.includes("hast-") || id.includes("mdast-") || id.includes("micromark")) return "rich-text";
          if (id.includes("react-dom") || id.includes("/react/")) return "react";
          if (id.includes("/yaml/")) return "yaml";
          // Only QrTree (the remote-access QR "night city" animation) pulls
          // in three.js. Isolate it into its own vendor chunk so that lazy
          // chunk stays feature-code-sized instead of ~95% vendor library.
          if (id.includes("node_modules/three/")) return "three-vendor";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/internal": "http://127.0.0.1:8787",
      "/healthz": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});

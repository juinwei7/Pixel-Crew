import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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

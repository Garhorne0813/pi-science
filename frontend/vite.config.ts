import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // Mol* has circular ESM dependencies between its plugin context and the
    // built-in state behaviors. Vite's dependency pre-bundle can emit
    // BuiltInPluginBehaviors before the State namespace is initialized, which
    // makes PluginUIContext fail before a structure is parsed.
    exclude: ["molstar"],
    // Mol*'s viewer extension registry imports this legacy CommonJS package
    // even when MP4 export is disabled. Pre-bundle only that leaf dependency
    // so its `module.exports` wrapper is browser-compatible.
    include: ["molstar > h264-mp4-encoder"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Mol* imports Mutative's CommonJS entry with a named ESM import. When
      // Mol* stays unbundled in development, point that import at Mutative's
      // equivalent native ESM build so browsers can resolve `create`.
      "mutative/dist/index.js": "mutative/dist/mutative.esm.mjs",
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
        ...(process.env.PI_SCIENCE_INTERNAL_TOKEN
          ? { headers: { "x-pi-science-internal-token": process.env.PI_SCIENCE_INTERNAL_TOKEN } }
          : {}),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Shared wire-schema validation is only needed by lazy data surfaces
          // (Runs/provenance). Keep Zod out of the initial conversation bundle.
          if (id.includes("node_modules/zod")) return "vendor-contracts";
          if (id.includes("node_modules/echarts") || id.includes("node_modules/zrender")) return "vendor-echarts";
          if (id.includes("node_modules/openchemlib")) return "vendor-openchemlib";
          if (id.includes("node_modules/three")) return "vendor-three";
          if (id.includes("node_modules/docx-preview")) return "vendor-docx";
          if (id.includes("node_modules/pptx-preview")) return "vendor-pptx";
          if (id.includes("node_modules/exceljs")) return "vendor-exceljs";
          if (id.includes("node_modules/react-virtuoso")) return "vendor-virtuoso";
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/react-router")
          ) return "vendor-react";
          if (id.includes("node_modules/@radix-ui")) return "vendor-radix";
          if (
            id.includes("node_modules/react-markdown") ||
            id.includes("node_modules/remark-gfm") ||
            id.includes("node_modules/highlight.js")
          ) return "vendor-markdown";
          // Keep Mol* and its parser/runtime dependencies in the molecule-only
          // dynamic graph. Everything else can share the existing common vendor
          // chunk without pulling the molecular viewer into the initial bundle.
          const isMolecularViewerDependency = /[\\/]node_modules[\\/](?:molstar|immutable|rxjs|mutative|fp-ts|io-ts|h264-mp4-encoder)[\\/]/.test(id);
          if (id.includes("node_modules") && !isMolecularViewerDependency) return "vendor-common";
          return undefined;
        },
      },
    },
  },
});

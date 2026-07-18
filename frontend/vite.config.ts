import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@ai4s/shared": path.resolve(__dirname, "src/types/thread.ts"),
      "@ai4s/sdk": path.resolve(__dirname, "src/types/thread.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.PI_SCIENCE_BACKEND_URL || "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/3dmol") || id.includes("3Dmol")) return "vendor-3dmol";
          if (id.includes("node_modules/openchemlib")) return "vendor-openchemlib";
          if (id.includes("node_modules/three")) return "vendor-three";
          if (id.includes("node_modules/docx-preview")) return "vendor-docx";
          if (id.includes("node_modules/pptx-preview")) return "vendor-pptx";
          if (id.includes("node_modules/exceljs")) return "vendor-exceljs";
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
          if (id.includes("node_modules")) return "vendor-common";
          return undefined;
        },
      },
    },
  },
});

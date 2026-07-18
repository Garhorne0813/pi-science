import { defineConfig } from "vitest/config";
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
  test: {
    environment: "jsdom",
    globals: true,
  },
});

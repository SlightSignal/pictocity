import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4100",
      "/assets": "http://localhost:4100",
      "/fonts": "http://localhost:4100",
      "/ws": { target: "ws://localhost:4100", ws: true },
    },
  },
  build: { outDir: "dist", assetsDir: "app" }, // "assets" is taken by uploaded images on the server
});

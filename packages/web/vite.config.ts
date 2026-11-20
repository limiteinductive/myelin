import { fileURLToPath } from "node:url";
import solid from "@solidjs/vite-plugin";
import { defineConfig } from "vite";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: { alias: { "@myelin/core": at("../core/src/index.ts") } },
  server: {
    port: 5173,
    fs: { allow: [at("../..")] },
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, target: "es2023" },
});

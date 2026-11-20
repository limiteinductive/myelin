import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: { alias: { "@myelin/core": at("../core/src/index.ts"), "@myelin/server": at("../server/src/index.ts") } },
  test: { testTimeout: 15000 },
});

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, "../..");

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [rootDir, repoRoot],
    },
  },
  build: {
    outDir: "dist",
  },
});

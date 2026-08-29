import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, "../..");

export default defineConfig({
  // Relative assets work both at localhost and under the /Metra/ GitHub Pages path.
  base: "./",
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

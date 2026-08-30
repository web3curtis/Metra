import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(rootDir, "../..");

export default defineConfig({
  base: "./",
  root: ".",
  server: { port: 5174, strictPort: true, fs: { allow: [rootDir, repoRoot] } },
  build: { outDir: "dist" },
});

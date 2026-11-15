import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type Plugin, defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteCoreLicense } from "./scripts/vite-core-license.mjs";

const NOTICES = "THIRD_PARTY_LICENSES.md";

/**
 * build.license lists the npm packages bundled into the app. Vite's own runtime helpers (the
 * module-preload polyfill and dynamic-import preloader) are also in the bundle, so the "Vite core
 * license" section of the installed vite package is appended once the notices file is written.
 */
function viteCoreNotice(): Plugin {
  return {
    name: "lvn-vite-core-notice",
    apply: "build",
    writeBundle(opts) {
      const file = path.join(opts.dir ?? "dist", NOTICES);
      if (!existsSync(file)) throw new Error(`${NOTICES} was not written`);
      const dir = path.dirname(createRequire(import.meta.url).resolve("vite/package.json"));
      const version = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).version;
      appendFileSync(file, `\n## vite - ${version} (MIT)\n\nRuntime helpers (module preload) included in the bundle.\n\n${viteCoreLicense(dir)}\n`);
    },
  };
}

// base "./" keeps the static build portable to any host path.
// build.license writes the license texts of every bundled dependency (from the installed
// packages) to dist/THIRD_PARTY_LICENSES.md; scripts/check-notices.mjs verifies it after builds.
export default defineConfig({
  base: "./",
  plugins: [react(), viteCoreNotice()],
  build: {
    license: { fileName: NOTICES },
  },
});

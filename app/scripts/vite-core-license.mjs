// The "Vite core license" section of the installed vite package's LICENSE.md (its MIT notice),
// without the list of Vite's own build-time dependencies that follows it.
import { readFileSync } from "node:fs";
import path from "node:path";

export function viteCoreLicense(viteDir) {
  const full = readFileSync(path.join(viteDir, "LICENSE.md"), "utf8").replace(/\r\n/g, "\n");
  const head = full.split("\n# Licenses of bundled dependencies")[0];
  return head.replace(/^# Vite core license\n+/, "").trim();
}

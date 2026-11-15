// Post-build check: the static build must ship the third-party notices of the code bundled into
// it, with each installed package's own license text (minified bundles drop license comments).
import { readFileSync } from "node:fs";
import path from "node:path";
import { viteCoreLicense } from "./vite-core-license.mjs";

const dist = path.resolve(import.meta.dirname, "..", "dist");
const notices = readFileSync(path.join(dist, "THIRD_PARTY_LICENSES.md"), "utf8");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const failures = [];
for (const name of ["three", "react", "react-dom", "scheduler", "vite"]) {
  // the installed package directory (three does not export its package.json)
  const pkgDir = path.resolve(import.meta.dirname, "..", "node_modules", name);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  // vite: only its core MIT section applies to the runtime helpers in the bundle
  const license = name === "vite" ? viteCoreLicense(pkgDir) : readFileSync(path.join(pkgDir, "LICENSE"), "utf8");
  if (!notices.includes(`## ${name} - ${pkg.version}`)) failures.push(`${name}@${pkg.version}: not listed`);
  if (!norm(notices).includes(norm(license))) failures.push(`${name}@${pkg.version}: installed license text not found`);
}
if (failures.length) {
  console.error(`Third-party notice check FAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("Third-party notices OK: dist/THIRD_PARTY_LICENSES.md has the installed license texts of three, react, react-dom, scheduler and vite (core).");

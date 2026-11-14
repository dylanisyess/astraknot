// Launch Vitest with a normalized working directory.
// On Windows, a lowercase drive letter in the shell's cwd ("c:\...") makes
// Vitest 5 load two module instances and fail with "failed to find the current
// suite". Re-spawning with an uppercase drive letter avoids it; elsewhere this
// is a plain pass-through.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("vitest/package.json"));
const upper = (p) => p.replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = upper(path.join(pkgDir, require("vitest/package.json").bin.vitest));
const r = spawnSync(process.execPath, [bin, "run", ...process.argv.slice(2)], { cwd, stdio: "inherit" });
process.exit(r.status ?? 1);

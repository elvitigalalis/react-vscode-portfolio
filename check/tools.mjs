// Gates that wrap an outside checker. Each returns its findings as problem lines.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { htmlPages } from "./lib.mjs";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return r;
}
const lines = (r) => (r.stdout + r.stderr).split("\n").filter((l) => l.trim());

// html-validate, html-validate:recommended, on every built page.
export async function html({ root, dist }) {
  const r = run(join(root, "node_modules/.bin/html-validate"), ["--config", join(root, ".htmlvalidate.json"), ...htmlPages(dist)], { cwd: dist });
  return r.status === 0 ? [] : lines(r);
}

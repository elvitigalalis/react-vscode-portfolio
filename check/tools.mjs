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

// lychee: every internal link and #anchor resolves in the build. External links are checked
// only with CHECK_EXTERNAL_LINKS=1 (the scheduled CI run), since they can flake; LinkedIn is
// always skipped because it answers bots with HTTP 999.
export async function links({ dist }) {
  const online = process.env.CHECK_EXTERNAL_LINKS === "1";
  const r = run("lychee", [
    "--no-progress", "--include-fragments", "--root-dir", dist, "--index-files", "index.html",
    "--remap", `^https://www\\.lisul-elvi\\.com file://${dist}`, "--exclude", String.raw`linkedin\.com`, ...(online ? ["--max-retries", "3"] : ["--offline"]), dist,
  ]);
  if (r.status === 0) return [];
  const errors = lines(r).filter((l) => /ERROR|\[\d{3}\]|Timeout/i.test(l));
  return errors.length ? errors : lines(r);
}

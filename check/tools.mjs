// Gates that wrap an outside checker. Each returns its findings as problem lines.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeRe, htmlPages, ORIGIN, serve } from "./lib.mjs";

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

// lychee: every internal link and #anchor resolves in the build. With CHECK_EXTERNAL_LINKS=1
// (every CI run) external links are checked too, retried with back-off, and a 429 rate limit
// counts as alive rather than broken; without it (a local run) lychee stays offline. LinkedIn
// is always skipped because it answers bots with HTTP 999.
export async function links({ dist }) {
  const online = process.env.CHECK_EXTERNAL_LINKS === "1";
  const r = run("lychee", [
    "--no-progress", "--include-fragments", "--root-dir", dist, "--index-files", "index.html",
    "--remap", `^${escapeRe(ORIGIN)} file://${dist}`, "--exclude", String.raw`linkedin\.com`,
    ...(online ? ["--max-retries", "4", "--retry-wait-time", "3", "--accept", "200..=299,429"] : ["--offline"]), dist,
  ]);
  if (r.status === 0) return [];
  const errors = lines(r).filter((l) => /ERROR|\[\d{3}\]|Timeout/i.test(l));
  return errors.length ? errors : lines(r);
}

// Lighthouse CI with the spec's mobile budgets (lighthouserc.cjs): / and 404 at 100 KB and
// 15 requests, write-ups under /projects/ at 300 KB, Perf >= 0.95 and 100 elsewhere.
export async function lighthouse({ root, dist, runs }) {
  const work = mkdtempSync(join(tmpdir(), "lhci-"));
  const lhci = join(root, "node_modules/.bin/lhci");
  const config = `--config=${join(root, "lighthouserc.cjs")}`;
  const collect = run(lhci, ["collect", config, `--collect.staticDistDir=${dist}`, ...(runs ? [`--collect.numberOfRuns=${runs}`] : [])], { cwd: work });
  if (collect.status !== 0) return [`lhci collect failed:`, ...lines(collect)];
  const assert = run(lhci, ["assert", config], { cwd: work });
  const results = JSON.parse(readFileSync(join(work, ".lighthouseci/assertion-results.json"), "utf8"));
  const problems = results
    .filter((r) => r.level === "error" && !r.passed)
    .map((r) => `${new URL(r.url).pathname}: ${[r.auditId, r.auditProperty?.replace(".", ":")].filter(Boolean).join(":")} ${r.name} ${r.operator} ${r.expected}, found ${r.actual}`);
  return assert.status === 0 || problems.length ? problems : lines(assert);
}

// pa11y-ci with the axe runner on every built page, served as GitHub Pages would. pa11y's
// WCAG2AA standard maps to axe's 2.0/2.1 A and AA tags plus best-practice; the WCAG 2.2 AA rule
// (target-size) is switched on by name. Every axe violation fails, whatever its impact;
// "needs review" results do not.
const WCAG22 = ["target-size"];

export async function a11y({ root, dist }) {
  const work = mkdtempSync(join(tmpdir(), "pa11y-"));
  const server = await serve(dist);
  try {
    const config = join(work, "pa11y.json");
    writeFileSync(config, JSON.stringify({
      defaults: {
        runners: ["axe"], standard: "WCAG2AA", rules: WCAG22, includeWarnings: true, includeNotices: true,
        timeout: 60_000, chromeLaunchConfig: { args: ["--no-sandbox"] },
      },
      urls: htmlPages(dist).map((f) => `${server.url}/${f}`),
    }));
    // Async spawn: the server above must keep answering while pa11y-ci runs. Its stdout goes to a
    // file, not a pipe: pa11y-ci exits before a pipe drains, which cut reports over 64 KB short.
    const reportPath = join(work, "report.json");
    const fd = openSync(reportPath, "w");
    const out = await new Promise((ok, fail) => {
      const p = spawn(join(root, "node_modules/.bin/pa11y-ci"), ["--json", "--config", config], { cwd: work, stdio: ["ignore", fd, "pipe"] });
      let stderr = "";
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", fail);
      p.on("close", () => { closeSync(fd); ok({ stdout: readFileSync(reportPath, "utf8"), stderr }); });
    });
    let report;
    try { report = JSON.parse(out.stdout); } catch { return ["pa11y-ci gave no report:", ...(out.stdout + out.stderr).split("\n").filter(Boolean)]; }
    return Object.entries(report.results).flatMap(([url, issues]) =>
      issues
        .filter((i) => !i.runnerExtras?.needsFurtherReview)
        .map((i) => i instanceof Error || i.message && !i.code ? `${new URL(url).pathname}: ${i.message}` : `${new URL(url).pathname}: ${i.code} ${i.message} at ${i.selector}`));
  } finally {
    await server.close();
  }
}

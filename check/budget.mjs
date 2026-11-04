// Budget gate: the gzipped JavaScript a page loads before it can draw, its module scripts and
// everything they import statically (dynamic import() is left out: it loads later). GitHub Pages
// serves it gzipped, which Lighthouse's local run can't see (lighthouserc.cjs). /plan/gym/ gets
// 40 KB, so the tracker opens fast on a phone in a basement gym (docs/sheet-gym.md).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

export const BUDGETS = { "plan/gym/index.html": 40 * 1024 };

// The page's first-load scripts, as paths under dist.
export function firstLoad(dist, page) {
  const html = readFileSync(join(dist, page), "utf8");
  const queue = [...html.matchAll(/<script\b[^>]*\bsrc="(\/[^"]+\.js)"/g)].map((m) => m[1].slice(1));
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(join(dist, file))) continue;
    seen.add(file);
    const code = readFileSync(join(dist, file), "utf8");
    for (const m of code.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) queue.push(join(dirname(file), m[1]));
  }
  return [...seen];
}

export async function budget({ dist }) {
  const problems = [];
  for (const [page, max] of Object.entries(BUDGETS)) {
    if (!existsSync(join(dist, page))) { problems.push(`${page}: missing`); continue; }
    const files = firstLoad(dist, page);
    const size = files.reduce((n, f) => n + gzipSync(readFileSync(join(dist, f))).length, 0);
    if (size > max) problems.push(`${page}: ${(size / 1024).toFixed(1)} KB of gzipped JS on first load, over ${max / 1024} KB (${files.join(", ")})`);
  }
  return problems;
}

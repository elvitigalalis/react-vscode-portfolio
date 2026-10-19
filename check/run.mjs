// `npm run check`: every gate over the built site. Exits non-zero if any gate finds a problem.
// Usage: node check/run.mjs [--dist dir] [gate ...]   (no gate names = all of them)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { mirror } from "./mirror.mjs";
import { routing } from "./routing.mjs";
import { lint } from "./lint.mjs";
import { tags } from "./tags.mjs";
import { html } from "./tools.mjs";

const gates = { mirror, lint, tags, routing, html };

const { values, positionals } = parseArgs({ options: { dist: { type: "string", default: "dist" } }, allowPositionals: true });
const root = new URL("..", import.meta.url).pathname;
const ctx = {
  root,
  dist: resolve(values.dist),
  content: resolve(root, "src/content"),
  resume: JSON.parse(readFileSync(resolve(process.env.RESUME_JSON ?? resolve(root, "src/data/resume.json")), "utf8")),
};

let failed = 0;
for (const name of positionals.length ? positionals : Object.keys(gates)) {
  if (!gates[name]) throw new Error(`no gate named ${name}; gates: ${Object.keys(gates).join(", ")}`);
  const problems = await gates[name](ctx);
  console.log(`${problems.length ? "✖" : "✔"} ${name}${problems.length ? ` (${problems.length})` : ""}`);
  for (const p of problems) console.log(`    ${p}`);
  if (problems.length) failed++;
}
if (failed) {
  console.error(`\n${failed} gate(s) failed.`);
  process.exit(1);
}

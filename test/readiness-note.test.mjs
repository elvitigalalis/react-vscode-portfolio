// The readiness note (src/sheet/readiness-note.mjs, docs/sheet.md "Readiness note"): a fixed
// threshold and sentence, and, per docs/adr/0005, no server or AI path ever imports it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lowReadiness, readinessLine, dismissedOn, dismiss, LOW_READINESS } from "../src/sheet/readiness-note.mjs";

test("lowReadiness: today's readiness under 70, else null", () => {
  const rows = [{ day: "2026-11-08", readiness: 50 }, { day: "2026-11-09", readiness: 64 }];
  assert.equal(LOW_READINESS, 70);
  assert.equal(lowReadiness(rows, "2026-11-09"), 64);
  assert.equal(lowReadiness([{ day: "2026-11-09", readiness: 70 }], "2026-11-09"), null);
  assert.equal(lowReadiness([{ day: "2026-11-09", readiness: null }], "2026-11-09"), null);
  assert.equal(lowReadiness(rows, "2026-11-10"), null); // yesterday's low score doesn't carry over
});

test("readinessLine: the fixed sentence, no alarm words", () => {
  assert.equal(readinessLine(64), "Readiness 64 today · consider a lighter day");
});

test("dismiss: hides it for that day only; storage errors read as not dismissed", () => {
  const m = new Map();
  const store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  assert.equal(dismissedOn("2026-11-09", store), false);
  dismiss("2026-11-09", store);
  assert.equal(dismissedOn("2026-11-09", store), true);
  assert.equal(dismissedOn("2026-11-10", store), false);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.doesNotThrow(() => dismiss("2026-11-09", broken));
  assert.equal(dismissedOn("2026-11-09", broken), false);
});

// Every module reachable by relative static or dynamic import from `entries`.
const root = resolve(import.meta.dirname, "..");
function reach(entries) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"'?]+)["']/g)) walk(resolve(dirname(file), spec));
  };
  entries.forEach(walk);
  return seen;
}
const tsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? tsFiles(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []);

test("ADR 0005: no Supabase function or AI path imports the readiness note", () => {
  const sheet = (f) => join(root, "src/sheet", f);
  const entries = [
    ...tsFiles(join(root, "supabase/functions")), // planner-mcp (read_planner, proposals), telegram, message, capture...
    ...["proposal.mjs", "proposal-io.mjs", "messages.mjs", "routine-fire.mjs", "voice.mjs", "nudges.mjs", "horizon-io.mjs", "morning.mjs"].map(sheet),
  ];
  const seen = reach(entries);
  assert.ok(seen.has(sheet("proposal.mjs")) && seen.has(sheet("voice.mjs")), "the walk follows the functions' imports");
  assert.equal(seen.has(sheet("readiness-note.mjs")), false);
  for (const f of seen) assert.doesNotMatch(readFileSync(f, "utf8"), /readiness-note/, f);
});

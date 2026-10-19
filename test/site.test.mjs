// Checks on the built site: what a visitor or crawler gets, never how it is built.
// One build of the real data, then assertions on dist/. Run with `npm test`.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const resume = JSON.parse(readFileSync(join(root, "src/data/resume.json"), "utf8"));

function build(env = {}) {
  return spawnSync(join(root, "node_modules/.bin/astro"), ["build"], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

let home;
before(() => {
  const r = build();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  home = readFileSync(join(dist, "index.html"), "utf8");
});

test("the home page builds", () => {
  assert.ok(home.length > 0);
});

// Last: a failed build leaves dist/ incomplete.
test("the build fails when resume.json breaks the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-"));
  const bad = { ...resume, projects: resume.projects.map((p) => ({ ...p, note: "Return offer" })) };
  writeFileSync(join(dir, "resume.json"), JSON.stringify(bad));
  const r = build({ RESUME_JSON: join(dir, "resume.json") });
  assert.notEqual(r.status, 0, "build should fail on a schema violation");
  assert.match(r.stdout + r.stderr, /resume\.json does not match its schema/);
});

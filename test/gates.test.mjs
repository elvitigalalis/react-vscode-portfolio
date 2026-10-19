// The gate suite (`npm run check`) against the real build and against broken copies of it.
// Each gate must pass on the real dist/ and fail on a fixture broken in exactly one way.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mirror } from "../check/mirror.mjs";
import { routing } from "../check/routing.mjs";

const root = new URL("..", import.meta.url).pathname;
const realDist = join(root, "dist");
const resume = JSON.parse(readFileSync(join(root, "src/data/resume.json"), "utf8"));

before(() => {
  const r = spawnSync(join(root, "node_modules/.bin/astro"), ["build"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// A copy of the real build, changed by `edit(dir)`.
function broken(edit) {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  cpSync(realDist, dist, { recursive: true });
  edit?.(dist);
  return dist;
}
const read = (dist, file) => readFileSync(join(dist, file), "utf8");
const write = (dist, file, body) => {
  mkdirSync(dirname(join(dist, file)), { recursive: true });
  writeFileSync(join(dist, file), body);
};
const page = (body, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>${head}</head><body><main>${body}</main></body></html>`;
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const glance = (bullets) => `<h2>At a glance</h2><ul>${bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul><h2>Problem</h2><p>Text.</p>`;

// --- mirror ---------------------------------------------------------------

test("mirror: passes on the real build", async () => {
  assert.deepEqual(await mirror({ dist: realDist, resume }), []);
});

test("mirror: fails when a résumé bullet is missing from the home page", async () => {
  const bullet = resume.experience[0].bullets[0];
  const dist = broken((d) => write(d, "index.html", read(d, "index.html").replace(esc(bullet).slice(0, 40), "")));
  const problems = await mirror({ dist, resume });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /index\.html/);
});

test("mirror: fails when the phone number appears in any built file", async () => {
  const dist = broken((d) => write(d, "404.html", read(d, "404.html").replace("</main>", `<p>${resume.basics.phone}</p></main>`)));
  assert.match((await mirror({ dist, resume })).join("\n"), /404\.html.*phone/);
});

test("mirror: a write-up's At a glance must carry its project's bullets verbatim", async () => {
  const p = resume.projects[0];
  const file = `projects/${p.slug}/index.html`;
  const ok = broken((d) => write(d, file, page(`<h1>${p.title}</h1>` + glance(p.bullets))));
  assert.deepEqual(await mirror({ dist: ok, resume }), []);

  // A bullet lower on the page, outside the box, does not count.
  const bad = broken((d) => write(d, file, page(glance(p.bullets.slice(1)) + `<p>${esc(p.bullets[0])}</p>`)));
  const problems = await mirror({ dist: bad, resume });
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], new RegExp(`${file}.*At a glance`));

  const none = broken((d) => write(d, file, page(`<p>${p.bullets.map(esc).join(" ")}</p>`)));
  assert.match((await mirror({ dist: none, resume })).join("\n"), /no "At a glance"/);
});

// --- routing --------------------------------------------------------------

test("routing: passes on the real build", async () => {
  assert.deepEqual(await routing({ dist: realDist }), []);
});

test("routing: fails without the 404 page", async () => {
  const dist = broken((d) => rmSync(join(d, "404.html")));
  assert.match((await routing({ dist })).join("\n"), /404\.html/);
});

test("routing: fails without the résumé PDF at its old path", async () => {
  const dist = broken((d) => rmSync(join(d, "Lisul_Elvitigala_resume.pdf")));
  assert.match((await routing({ dist })).join("\n"), /Lisul_Elvitigala_resume\.pdf/);
});

test("routing: fails when old #/section links no longer land", async () => {
  const gone = broken((d) => write(d, "index.html", read(d, "index.html").replace(/<script\b[\s\S]*?<\/script>/, "")));
  assert.match((await routing({ dist: gone })).join("\n"), /hash/);
  const wrong = broken((d) => write(d, "index.html", read(d, "index.html").replace('"#" +', '"#x" +')));
  assert.match((await routing({ dist: wrong })).join("\n"), /#\/projects/);
});

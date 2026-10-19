// Checks on the built site: what a visitor or crawler gets, never how it is built.
// One build of the real data, then assertions on dist/. Run with `npm test`.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const resume = JSON.parse(readFileSync(join(root, "src/data/resume.json"), "utf8"));

// Every text file in dist/ (HTML, CSS, JS, XML, TXT).
function builtFiles(dir = dist) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? builtFiles(join(dir, d.name)) : /\.(html|css|js|xml|txt|json)$/.test(d.name) ? [join(dir, d.name)] : []);
}

function build(env = {}) {
  return spawnSync(join(root, "node_modules/.bin/astro"), ["build"], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

// The text a reader sees: tags dropped, entities decoded, whitespace collapsed.
function textOf(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
const squash = (s) => s.replace(/\s+/g, " ");

let home, homeText;
before(() => {
  const r = build();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  home = readFileSync(join(dist, "index.html"), "utf8");
  homeText = textOf(home);
});

test("every resume.json fact appears verbatim on the home page", () => {
  const { basics, education, experience, projects, skills } = resume;
  const facts = [
    basics.name, basics.citizenship, basics.email,
    ...basics.links.map((l) => l.label),
    ...education.flatMap((e) => [e.school, e.degree, e.honorific, e.date, e.gpa, ...e.items]),
    ...experience.flatMap((e) => [e.company, e.title, e.team, e.dates, e.location, ...e.stack, ...e.bullets]),
    ...projects.flatMap((p) => [p.title, p.role, p.dates, ...p.stack, ...p.bullets]),
    ...skills.languages, ...skills.frameworks, ...skills.tools,
  ].filter(Boolean);
  const missing = facts.filter((f) => !homeText.includes(squash(f)));
  assert.deepEqual(missing, []);
});

test("every resume.json link is a working href on the home page", () => {
  const urls = [...resume.basics.links.map((l) => l.url), ...resume.projects.map((p) => p.url), `mailto:${resume.basics.email}`];
  const missing = urls.filter((u) => !home.includes(`href="${u}"`));
  assert.deepEqual(missing, []);
});

test("the phone number is never rendered", () => {
  const digits = resume.basics.phone.replace(/\D/g, "");
  for (const file of builtFiles()) {
    const body = readFileSync(file, "utf8");
    assert.ok(!body.includes(resume.basics.phone), file);
    assert.ok(!body.replace(/\D/g, "").includes(digits), file);
    assert.ok(!/href="tel:/.test(body), file);
  }
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

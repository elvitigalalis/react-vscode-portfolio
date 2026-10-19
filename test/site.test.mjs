// Checks on the built site: what a visitor or crawler gets, never how it is built.
// One build of the real data, then assertions on dist/. Run with `npm test`.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const resume = JSON.parse(readFileSync(join(root, "src/data/resume.json"), "utf8"));

// Every text file in dist/ (HTML, CSS, JS, XML, TXT).
function builtFiles(dir = dist) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? builtFiles(join(dir, d.name)) : /\.(html|css|js|xml|txt|json)$/.test(d.name) ? [join(dir, d.name)] : []);
}

function build(env = {}, args = []) {
  return spawnSync(join(root, "node_modules/.bin/astro"), ["build", ...args], {
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

test("a plain 404 page exists with the top bar", () => {
  const page = readFileSync(join(dist, "404.html"), "utf8");
  assert.match(page, /href="\/Lisul_Elvitigala_resume\.pdf"/);
  assert.match(page, /href="\/#projects"/);
});

test("the résumé PDF keeps its old public path", () => {
  const pdf = readFileSync(join(dist, "Lisul_Elvitigala_resume.pdf"));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(home, /href="\/Lisul_Elvitigala_resume\.pdf"/);
});

test("no client JS beyond the inline hash script", () => {
  const scripts = [...home.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0][1], /src=/);
  assert.ok(scripts[0][2].length < 1024, "hash script stays tiny");
  assert.deepEqual(builtFiles().filter((f) => f.endsWith(".js")), []);
});

test("old #/section links land on the matching section", () => {
  const code = home.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1];
  const land = (hash) => {
    let replaced = null;
    const location = { hash, replace: (h) => { replaced = h; } };
    new Function("location", code)(location);
    return replaced;
  };
  assert.equal(land("#/projects"), "#projects");
  assert.equal(land("#/experience"), "#experience");
  assert.equal(land("#/education"), "#education");
  assert.equal(land("#/skills"), "#skills");
  assert.equal(land("#/overview"), "#top");
  assert.equal(land("#/accomplishments"), "#education");
  assert.equal(land("#/"), "#top");
  assert.equal(land("#projects"), null, "new hashes are left alone");
  assert.equal(land(""), null);
  for (const id of ["top", "projects", "experience", "education", "skills"]) assert.match(home, new RegExp(`id="${id}"`));
});

test("each project card shows a photo of at most 100 KB with alt text", () => {
  const imgs = [...home.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  for (const p of resume.projects) {
    const img = imgs.find((i) => i.includes(`/images/${p.slug}.`));
    assert.ok(img, `no photo for ${p.slug}`);
    assert.match(img, /alt="[^"]{10,}"/);
    assert.match(img, /width="\d+" height="\d+"/);
    const src = img.match(/src="([^"]+)"/)[1];
    assert.ok(statSync(join(dist, src)).size <= 100 * 1024, src);
  }
});

test("hand-written home page text obeys the standing wording rules", () => {
  const text = readFileSync(join(root, "src/content/home.md"), "utf8").replace(/^\s*#.*$/gm, "");
  const banned = [
    /\boffers?\b/i, // offer tags
    /acquired by/i,
    /\bformerly\b/i,
    /\b\d[\d,]*\s+commits?\b/i,
    /LA Metro/i,
    /robotic arm/i,
    /\bCUDA\b/i,
  ];
  assert.deepEqual(banned.filter((re) => re.test(text)).map(String), []);
});

test("the build fails when resume.json breaks the schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "resume-"));
  const bad = { ...resume, projects: resume.projects.map((p) => ({ ...p, note: "Return offer" })) };
  writeFileSync(join(dir, "resume.json"), JSON.stringify(bad));
  const r = build({ RESUME_JSON: join(dir, "resume.json") }, ["--outDir", join(dir, "dist")]);
  assert.notEqual(r.status, 0, "build should fail on a schema violation");
  assert.match(r.stdout + r.stderr, /resume\.json does not match its schema/);
});

// Write-ups: one markdown file in src/content/writeups/<slug>.md builds /projects/<slug>/.
const writeupDir = join(root, "src/content/writeups");
const writeupSlugs = () => readdirSync(writeupDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
const writeupHtml = (slug) => readFileSync(join(dist, "projects", slug, "index.html"), "utf8");

test("each write-up file builds a page that only its card's Write-up button links to", () => {
  const slugs = writeupSlugs();
  assert.ok(slugs.includes("micromouse"), "the Micromouse write-up exists");
  for (const p of resume.projects) {
    const linked = home.includes(`href="/projects/${p.slug}/"`);
    assert.equal(linked, slugs.includes(p.slug), `Write-up button for ${p.slug}`);
  }
  for (const slug of slugs) assert.ok(writeupHtml(slug).length > 0);
});

test("a write-up's header and At a glance mirror its résumé project verbatim", () => {
  for (const slug of writeupSlugs()) {
    const p = resume.projects.find((x) => x.slug === slug);
    assert.ok(p, `${slug} is a resume.json project`);
    const html = writeupHtml(slug);
    const header = textOf(html.match(/<header class="writeup-head"[\s\S]*?<\/header>/)[0]);
    for (const f of [p.title, p.role, p.dates, ...p.stack].filter(Boolean)) assert.ok(header.includes(squash(f)), f);
    assert.match(html, new RegExp(`href="${p.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    const glance = textOf(html.match(/<aside[^>]*id="at-a-glance"[\s\S]*?<\/aside>/)[0]);
    assert.deepEqual(p.bullets.filter((b) => !glance.includes(squash(b))), []);
  }
});

test("a write-up ends with links back to all projects and the résumé", () => {
  for (const slug of writeupSlugs()) {
    const end = writeupHtml(slug).match(/<nav class="writeup-end"[\s\S]*?<\/nav>/)[0];
    assert.match(end, /href="\/#projects"[^>]*>← All projects</);
    assert.match(end, /href="\/Lisul_Elvitigala_resume\.pdf"/);
  }
});

test("each write-up has its own title, description and absolute canonical", () => {
  const pages = [home, ...writeupSlugs().map(writeupHtml)];
  const tag = (html, re) => html.match(re)?.[1];
  const titles = pages.map((h) => tag(h, /<title>([^<]+)<\/title>/));
  const descs = pages.map((h) => tag(h, /<meta name="description" content="([^"]+)"/));
  assert.equal(new Set(titles).size, pages.length);
  assert.equal(new Set(descs).size, pages.length);
  for (const slug of writeupSlugs()) {
    assert.match(writeupHtml(slug), new RegExp(`<link rel="canonical" href="https://www\\.lisul-elvi\\.com/projects/${slug}/"`));
  }
});

// A write-up's hand-written text: its front matter fields (except sources) and its body.
function writeupSource(slug) {
  const raw = readFileSync(join(writeupDir, `${slug}.md`), "utf8");
  const [, fm, body] = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const sourcesAt = fm.search(/^sources:/m);
  // Front matter comments and media fields (paths, pixel sizes) are not prose.
  const fields = fm.slice(0, sourcesAt).replace(/^\s*(#|src:|poster:|captions:|width:|height:).*$/gm, "");
  return { prose: fields + "\n" + body, sources: fm.slice(sourcesAt) };
}
const numbersIn = (text) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];
const proseText = (s) => textOf(s.replace(/<!--[\s\S]*?-->/g, "")); // tags and attributes are not prose

const banned = [
  /\boffers?\b/i, /acquired by/i, /\bformerly\b/i, /\b\d[\d,]*\s+commits?\b/i,
  /LA Metro/i, /robotic arm/i, /\bCUDA\b/i,
];

test("every number in a write-up traces to resume.json or its sources: list", () => {
  const known = new Set(numbersIn(JSON.stringify(resume)));
  for (const slug of writeupSlugs()) {
    const { prose, sources } = writeupSource(slug);
    const allowed = new Set([...known, ...numbersIn(sources)]);
    const untraced = [...new Set(numbersIn(proseText(prose)))].filter((n) => !allowed.has(n));
    assert.deepEqual(untraced, [], `${slug}: numbers missing from sources:`);
  }
});

test("write-ups obey the standing wording rules", () => {
  for (const slug of writeupSlugs()) {
    const text = proseText(writeupSource(slug).prose);
    assert.deepEqual(banned.filter((re) => re.test(text)).map(String), [], slug);
  }
  // The robot's run code plans with A*; its flood-fill code never runs, so it gets no credit.
  assert.doesNotMatch(proseText(writeupSource("micromouse").prose), /flood[- ]?fill/i);
});

test("a write-up runs 700 to 1,200 words with 2 to 4 figures", () => {
  for (const slug of writeupSlugs()) {
    const html = writeupHtml(slug);
    const prose = html.match(/<div class="prose"[^>]*>([\s\S]*?)<\/div>\s*<nav class="writeup-end"/)[1];
    const tldr = html.match(/<p class="tldr">([\s\S]*?)<\/p>/)[1];
    const words = textOf(tldr + " " + prose.replace(/<figure[\s\S]*?<\/figure>/g, "")).split(" ").filter((w) => /\w/.test(w));
    assert.ok(words.length >= 700 && words.length <= 1200, `${slug}: ${words.length} words`);
    const figures = prose.match(/<figure\b/g) ?? [];
    assert.ok(figures.length >= 2 && figures.length <= 4, `${slug}: ${figures.length} figures`);
  }
});

test("write-up figures are described, sized, lazy and light", () => {
  for (const slug of writeupSlugs()) {
    const prose = writeupHtml(slug).match(/<div class="prose"[^>]*>[\s\S]*<nav class="writeup-end"/)[0];
    for (const fig of prose.match(/<figure\b[\s\S]*?<\/figure>/g) ?? []) {
      assert.match(fig, /<figcaption>[^<]{20,}/, "each figure has a caption");
      const img = fig.match(/<img\b[^>]*>/)?.[0];
      if (img) {
        assert.match(img, /alt="[^"]{10,}"/);
        assert.match(img, /width="\d+" height="\d+"/);
        assert.match(img, /loading="lazy"/);
        const src = img.match(/src="([^"]+)"/)[1];
        assert.match(src, /\.webp$/);
        assert.ok(statSync(join(dist, src)).size <= 150 * 1024, `${src} is over 150 KB`);
      } else {
        assert.match(fig, /<svg\b[^>]*role="img"[^>]*aria-labelledby="[^"]+"/, "a drawn figure is labelled");
      }
    }
  }
});

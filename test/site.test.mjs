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

// ---- SEO and link previews (the tag gate) ----
const ORIGIN = "https://www.lisul-elvi.com";
const pages = () => builtFiles().filter((f) => f.endsWith(".html")).map((file) => ({ file, html: readFileSync(file, "utf8") }));
const indexable = () => pages().filter((p) => !p.file.endsWith("/404.html"));
const tags = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const meta = (html, key) => tags(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, "g"));
const decode = (s) => textOf(s).trim();

test("every page has one title and description, unique across the site", () => {
  const all = pages();
  const titles = all.map((p) => tags(p.html, /<title>([^<]*)<\/title>/g));
  const descs = all.map((p) => meta(p.html, "description"));
  for (const [i, p] of all.entries()) {
    assert.equal(titles[i].length, 1, `${p.file}: one <title>`);
    assert.equal(descs[i].length, 1, `${p.file}: one description`);
    assert.ok(descs[i][0].length >= 20, `${p.file}: description too short`);
  }
  assert.equal(new Set(titles.flat()).size, all.length, "titles are unique");
  assert.equal(new Set(descs.flat()).size, all.length, "descriptions are unique");
});

test("the home title names Lisul first, then his role", () => {
  assert.equal(decode(tags(home, /<title>([^<]*)<\/title>/g)[0]), "Lisul Elvitigala – Software Engineer · Stony Brook CS");
});

test("every indexable page has a self-referencing absolute https://www canonical", () => {
  for (const { file, html } of indexable()) {
    const canon = tags(html, /<link rel="canonical" href="([^"]*)"/g);
    assert.equal(canon.length, 1, file);
    const rel = file.slice(dist.length).replace(/index\.html$/, "");
    assert.equal(canon[0], ORIGIN + rel, file);
  }
});

test("the 404 page is kept out of the index", () => {
  const page = readFileSync(join(dist, "404.html"), "utf8");
  assert.match(page, /<meta name="robots" content="noindex"/);
  assert.doesNotMatch(page, /rel="canonical"/);
});

// Width and height from a JPEG's start-of-frame or a PNG's IHDR.
function imageSize(buf) {
  if (buf.subarray(1, 4).toString() === "PNG") return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  assert.equal(buf.readUInt16BE(0), 0xffd8, "not a JPEG or PNG");
  for (let i = 2; i < buf.length; ) {
    const marker = buf.readUInt16BE(i);
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { type: "jpeg", height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  throw new Error("no JPEG frame header");
}

test("every indexable page has full Open Graph and Twitter card tags", () => {
  for (const { file, html } of indexable()) {
    const one = (key) => {
      const v = meta(html, key);
      assert.equal(v.length, 1, `${file}: one ${key}`);
      return decode(v[0]);
    };
    const title = decode(tags(html, /<title>([^<]*)<\/title>/g)[0]);
    const ogTitle = one("og:title");
    assert.ok(ogTitle && title.includes(ogTitle), `${file}: og:title comes from the title`);
    assert.equal(one("og:description"), decode(meta(html, "description")[0]), file);
    assert.equal(one("og:url"), tags(html, /<link rel="canonical" href="([^"]*)"/g)[0], file);
    assert.equal(one("og:type"), "website");
    assert.equal(one("og:site_name"), resume.basics.name);
    assert.match(one("og:image"), new RegExp(`^${ORIGIN}/`), file);
    assert.equal(one("og:image:width"), "1200");
    assert.equal(one("og:image:height"), "630");
    assert.ok(one("og:image:alt").length >= 10, `${file}: og:image:alt`);
    assert.equal(one("twitter:card"), "summary_large_image");
  }
});

test("the preview image is 1200×630 and at most 300 KB", () => {
  const url = decode(meta(home, "og:image")[0]);
  const buf = readFileSync(join(dist, new URL(url).pathname));
  assert.ok(buf.length <= 300 * 1024, `${buf.length} bytes`);
  const { width, height } = imageSize(buf);
  assert.deepEqual({ width, height }, { width: 1200, height: 630 });
});

test("iMessage gets a square 180×180 touch icon", () => {
  assert.match(home, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  const { type, width, height } = imageSize(readFileSync(join(dist, "apple-touch-icon.png")));
  assert.deepEqual({ type, width, height }, { type: "png", width: 180, height: 180 });
});

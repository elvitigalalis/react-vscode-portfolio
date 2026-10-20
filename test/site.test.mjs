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

let home;
before(() => {
  const r = build();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  home = readFileSync(join(dist, "index.html"), "utf8");
});

test("every resume.json link is a working href on the home page", () => {
  const urls = [...resume.basics.links.map((l) => l.url), ...resume.projects.map((p) => p.url), `mailto:${resume.basics.email}`];
  const missing = urls.filter((u) => !home.includes(`href="${u}"`));
  assert.deepEqual(missing, []);
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
  // JSON-LD is data, not code, so it does not count.
  const scripts = [...home.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !m[1].includes("ld+json"));
  assert.equal(scripts.length, 1);
  assert.doesNotMatch(scripts[0][1], /src=/);
  assert.ok(scripts[0][2].length < 1024, "hash script stays tiny");
  assert.deepEqual(builtFiles().filter((f) => f.endsWith(".js")), []);
});

test("old #/section links land on the matching section", () => {
  const code = home.match(/<script>([\s\S]*?)<\/script>/)[1];
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
  assert.ok(slugs.includes("workit"), "the WorkIt write-up exists");
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

test("a write-up's header repeats its card's Demo link, label and all", () => {
  for (const slug of writeupSlugs()) {
    const card = home.split('<article class="card">').find((c) => c.includes(`href="/projects/${slug}/"`));
    const demo = card.match(/<a class="btn" href="([^"]+)">(Demo[^<]*)<\/a>/);
    const links = writeupHtml(slug).match(/<p class="links">[\s\S]*?<\/p>/)[0];
    if (demo) assert.ok(links.includes(`href="${demo[1]}">${demo[2]}</a>`), `${slug}: Demo link`);
    else assert.doesNotMatch(links, /Demo/, `${slug}: no Demo link`);
  }
  // The demo needs sign-in and is still being built; the label says so.
  assert.match(writeupHtml("workit"), /href="https:\/\/workit-web-gamma\.vercel\.app">Demo \(in development, sign-in required\)<\/a>/);
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

test("the WorkIt write-up credits teammates and never links WorkIt issues or PRs", () => {
  const raw = readFileSync(join(writeupDir, "workit.md"), "utf8");
  // A link or #-reference posts a "mentioned this" event on the WorkIt PR; plain text only.
  assert.doesNotMatch(raw, /github\.com\/WorkIt-CSE-416\/[^/\s]+\/(pull|issues)\//i);
  assert.doesNotMatch(raw, /(^|[\s(])#\d+\b|WorkIt-CSE-416\/[\w-]+#\d+/m);
  for (const f of builtFiles()) assert.doesNotMatch(readFileSync(f, "utf8"), /WorkIt-CSE416\/(pull|issues)\//, f);
  const text = proseText(writeupSource("workit").prose);
  // The import script, its transaction and its guards are Xiang's; Supabase was Brian's to create.
  assert.match(text, /Xiang Liu/);
  assert.doesNotMatch(text, /\bset up Supabase|Supabase setup/i);
});

test("no built page carries an unanswered TODO(Lisul) marker", () => {
  const marked = builtFiles().filter((f) => readFileSync(f, "utf8").includes("TODO(Lisul)"));
  assert.deepEqual(marked, []);
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

test("the WorkIt screenshot sits under the summary, described, sized and light", () => {
  const html = writeupHtml("workit");
  const fig = html.match(/<figure class="shot">[\s\S]*?<\/figure>/)?.[0];
  assert.ok(fig, "the screenshot sits under the summary");
  assert.ok(html.indexOf('class="tldr"') < html.indexOf(fig), "after the summary");
  assert.ok(html.indexOf(fig) < html.indexOf('id="at-a-glance"'), "before At a glance");
  const img = fig.match(/<img\b[^>]*>/)[0];
  assert.match(img, /alt="[^"]{10,}"/);
  assert.match(img, /width="\d+" height="\d+"/);
  const src = img.match(/src="([^"]+)"/)[1];
  assert.match(src, /\.webp$/);
  assert.ok(statSync(join(dist, src)).size <= 150 * 1024, `${src} is over 150 KB`);
  assert.match(fig, /<figcaption>[^<]{20,}/);
});

// Seconds in an MP4, from its movie header (mvhd) box.
function mp4Seconds(buf) {
  const at = buf.indexOf("mvhd");
  const v1 = buf[at + 4] === 1;
  const timescale = buf.readUInt32BE(at + (v1 ? 24 : 16));
  const duration = v1 ? Number(buf.readBigUInt64BE(at + 28)) : buf.readUInt32BE(at + 20);
  return duration / timescale;
}

test("the Micromouse run clip is click-to-play, muted, captioned, credited and light", () => {
  const html = writeupHtml("micromouse");
  const fig = html.match(/<figure class="clip">[\s\S]*?<\/figure>/)?.[0];
  assert.ok(fig, "the clip sits under the summary");
  assert.ok(html.indexOf(fig) < html.indexOf('id="at-a-glance"'), "the clip comes before At a glance");
  const video = fig.match(/<video\b[^>]*>/)[0];
  assert.match(video, /preload="none"/);
  assert.match(video, /\bmuted\b/);
  assert.match(video, /\bcontrols\b/);
  assert.doesNotMatch(video, /autoplay/);
  assert.match(video, /width="\d+" height="\d+"/);

  const poster = video.match(/poster="([^"]+)"/)[1];
  assert.ok(statSync(join(dist, poster)).size <= 60 * 1024, "poster ≤ 60 KB");

  const src = fig.match(/<source src="([^"]+)" type="video\/mp4"/)[1];
  const mp4 = readFileSync(join(dist, src));
  assert.ok(mp4.length <= 3 * 1024 * 1024, "clip ≤ 3 MB");
  assert.ok(mp4.includes("avc1"), "H.264 video");
  assert.ok(!mp4.includes("mp4a") && !mp4.includes("soun"), "no audio track");
  const seconds = mp4Seconds(mp4);
  assert.ok(seconds >= 15 && seconds <= 30, `${seconds} s long`);

  const track = fig.match(/<track\b[^>]*>/)[0];
  assert.match(track, /kind="captions"/);
  const vtt = readFileSync(join(dist, track.match(/src="([^"]+)"/)[1]), "utf8");
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /Video: Manasa/);

  const caption = textOf(fig.match(/<figcaption>([\s\S]*?)<\/figcaption>/)[1]);
  assert.match(caption, /Video: Manasa/);
  assert.match(caption, /before the Montclair 2026 competition/);
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

test("the sitemap lists exactly the indexable pages, and robots.txt points to it", () => {
  const robots = readFileSync(join(dist, "robots.txt"), "utf8");
  const line = robots.match(/^Sitemap: (\S+)$/m);
  assert.ok(line, "robots.txt has a Sitemap: line");
  assert.match(line[1], new RegExp(`^${ORIGIN}/`));
  const locs = (path) => tags(readFileSync(join(dist, new URL(path).pathname), "utf8"), /<loc>([^<]*)<\/loc>/g);
  const sitemaps = /index\.xml$/.test(line[1]) ? locs(line[1]) : [line[1]];
  const urls = sitemaps.flatMap(locs).sort();
  const canonicals = indexable().map((p) => tags(p.html, /<link rel="canonical" href="([^"]*)"/g)[0]).sort();
  assert.deepEqual(urls, canonicals);
});

test("home JSON-LD: WebSite and ProfilePage about a Person, from resume.json", () => {
  const blocks = tags(home, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  assert.equal(blocks.length, 1);
  const items = JSON.parse(blocks[0]);
  const byType = Object.fromEntries(items.map((i) => [i["@type"], i]));
  for (const i of items) assert.equal(i["@context"], "https://schema.org");

  // Google site names: WebSite with name and url, on the home page.
  assert.equal(byType.WebSite.name, "Lisul Elvitigala");
  assert.equal(byType.WebSite.url, `${ORIGIN}/`);

  // Google profile pages: ProfilePage with mainEntity (a Person) that has a name.
  const page = byType.ProfilePage;
  assert.equal(page.url, `${ORIGIN}/`);
  assert.equal(page.dateModified, resume.meta.generatedAt);
  const person = page.mainEntity;
  assert.equal(person["@type"], "Person");
  assert.equal(person.name, "Lisul Elvitigala");
  assert.equal(person.url, `${ORIGIN}/`);
  assert.deepEqual(person.sameAs, ["https://linkedin.com/in/lisul", "https://github.com/elvitigalalis"]);
  assert.deepEqual(person.alumniOf, { "@type": "CollegeOrUniversity", name: "Stony Brook University" });
  assert.ok(!("telephone" in person), "the phone number stays off the site");
  assert.ok(!("worksFor" in person), "no employer claim for a past role");
});

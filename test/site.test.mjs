// Checks on the built site: what a visitor or crawler gets, never how it is built.
// One build of the real data, then assertions on dist/. Run with `npm test`.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANALYTICS, decode, escapeRe, files, imageSize, ORIGIN, RESUME_PDF, squash, textOf } from "../check/lib.mjs";
import { BANNED, numbersIn } from "../check/lint.mjs";
import { parse } from "yaml";
import { FIGURES, WORDS, figureCount, wordCount, writeupText } from "../check/writeup.mjs";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
const resume = JSON.parse(readFileSync(join(root, "src/data/resume.json"), "utf8"));

// Every text file in dist/ (HTML, CSS, JS, XML, TXT, JSON), as full paths.
const builtFiles = () => files(dist, /\.(html|css|js|xml|txt|json)$/).map((f) => join(dist, f));

function build(env = {}, args = []) {
  return spawnSync(join(root, "node_modules/.bin/astro"), ["build", ...args], {
    cwd: root,
    // Analytics stay out of the build under test unless a test turns them on.
    env: { ...process.env, ANALYTICS: "off", ...env },
    encoding: "utf8",
  });
}

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
  assert.ok(page.includes(`href="${RESUME_PDF}"`));
  assert.match(page, /href="\/#projects"/);
});

test("the résumé PDF keeps its old public path", () => {
  const pdf = readFileSync(join(dist, RESUME_PDF));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.ok(home.includes(`href="${RESUME_PDF}"`));
});

test("no client JS beyond three tiny inline scripts, except on The Sheet's pages", () => {
  // JSON-LD is data, not code, so it does not count. The rest: the old-hash redirect, the theme
  // pick applied before first paint, and the top bar's light/dark switch and Plan link.
  const scripts = [...home.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !m[1].includes("ld+json"));
  assert.deepEqual(scripts.map((m) => m[1].trim()).sort(), ["", "data-theme-init", "data-topbar"]);
  for (const [, attrs, code] of scripts) {
    assert.doesNotMatch(attrs, /src=/);
    assert.ok(code.length < 1024, `${attrs.trim() || "hash"} script stays tiny`);
  }
  // Script files exist only for /plan and /now (docs/sheet.md): no other page loads one, and every
  // one is loaded by those pages, directly or through another script's import.
  const rel = (f) => f.slice(dist.length);
  const html = builtFiles().filter((f) => f.endsWith(".html"));
  const jsFiles = builtFiles().filter((f) => f.endsWith(".js"));
  const loads = (file, js) => readFileSync(file, "utf8").includes(js.split("/").pop());
  for (const page of html.filter((f) => !/^\/(plan|now)\//.test(rel(f)))) {
    for (const js of jsFiles) assert.ok(!loads(page, js), `${rel(page)} loads ${rel(js)}`);
  }
  const reached = new Set(jsFiles.filter((js) => html.some((page) => /^\/(plan|now)\//.test(rel(page)) && loads(page, js))));
  for (let grew = true; grew;) {
    grew = false;
    for (const js of jsFiles) if (!reached.has(js) && [...reached].some((from) => loads(from, js))) { reached.add(js); grew = true; }
  }
  for (const js of jsFiles) assert.ok(reached.has(js), `${rel(js)} is loaded by nothing`);
});

test("analytics load after the page, and only in the deployed build", () => {
  const r = build({ ANALYTICS: "" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const { gaId, clarityId } = ANALYTICS;
  for (const page of ["index.html", "404.html", "projects/micromouse/index.html"]) {
    const html = readFileSync(join(dist, page), "utf8");
    const tag = html.match(/<script>(?=[^<]*googletagmanager)([\s\S]*?)<\/script>/)?.[1] ?? "";
    if (gaId) assert.ok(tag.includes(JSON.stringify(gaId)), `${page} carries the GA ID`);
    if (clarityId) assert.ok(tag.includes(JSON.stringify(clarityId)), `${page} carries the Clarity ID`);
    if (gaId || clarityId) assert.match(tag, /addEventListener\("load"/, "third-party scripts wait for the load event");
    else assert.equal(tag, "", "no IDs, no tag");
    assert.doesNotMatch(html, /<script[^>]+src="https?:/, "no blocking third-party script tags");
  }
  const home = readFileSync(join(dist, "index.html"), "utf8");
  if (ANALYTICS.searchConsole) assert.ok(home.includes(`name="google-site-verification" content="${ANALYTICS.searchConsole}"`));
  else assert.doesNotMatch(home, /google-site-verification/);
  assert.equal(build().status, 0, "rebuild without analytics for the other tests");
  assert.doesNotMatch(readFileSync(join(dist, "index.html"), "utf8"), /googletagmanager|clarity\.ms/);
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
  assert.equal(land("#/no-such-page"), "#top", "an unknown old route lands on the first screen");
  assert.equal(land("#/toString"), "#top", "inherited object keys are not sections");
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

test("the footer's Updated date and its datetime name the same day", () => {
  const [, iso, text] = home.match(/<time datetime="([^"]+)">([^<]+)<\/time>/);
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${text} UTC`).toISOString().slice(0, 10), iso);
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
    assert.match(html, new RegExp(`href="${escapeRe(p.url)}"`));
    const glance = textOf(html.match(/<aside[^>]*id="at-a-glance"[\s\S]*?<\/aside>/)[0]);
    assert.deepEqual(p.bullets.filter((b) => !glance.includes(squash(b))), []);
  }
});

test("a project with a write-up keeps its card photo and demo in that one file", () => {
  const home = parse(readFileSync(join(root, "src/content/home.md"), "utf8").split(/^---$/m)[1]);
  for (const slug of writeupSlugs()) {
    assert.deepEqual(Object.keys(home.projects?.[slug] ?? {}).filter((k) => k === "photo" || k === "demo"), [], `home.md: ${slug}`);
    assert.match(readFileSync(join(writeupDir, `${slug}.md`), "utf8"), /^photo:\n  src: \/images\//m, `${slug}.md: photo`);
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
    assert.ok(end.includes(`href="${RESUME_PDF}"`));
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
    assert.match(writeupHtml(slug), new RegExp(`<link rel="canonical" href="${escapeRe(ORIGIN)}/projects/${slug}/"`));
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
const proseText = (s) => textOf(s.replace(/<!--[\s\S]*?-->/g, "")); // tags and attributes are not prose

test("every number in a write-up traces to resume.json or its sources: list", () => {
  const known = new Set(numbersIn(JSON.stringify(resume), true));
  for (const slug of writeupSlugs()) {
    const { prose, sources } = writeupSource(slug);
    const allowed = new Set([...known, ...numbersIn(sources, true)]);
    const untraced = [...new Set(numbersIn(proseText(prose)))].filter((n) => !allowed.has(n));
    assert.deepEqual(untraced, [], `${slug}: numbers missing from sources:`);
  }
});

test("write-ups obey the standing wording rules", () => {
  for (const slug of writeupSlugs()) {
    const text = proseText(writeupSource(slug).prose);
    assert.deepEqual(BANNED.filter(([re]) => re.test(text)).map(([, what]) => what), [], slug);
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

test("a write-up runs 700 to 1,200 words with 2 to 4 figures, by the length gate's rule", () => {
  for (const slug of writeupSlugs()) {
    const html = writeupHtml(slug);
    const words = wordCount(html);
    assert.ok(words >= WORDS.min && words <= WORDS.max, `${slug}: ${words} words`);
    const figures = figureCount(html);
    assert.ok(figures >= FIGURES.min && figures <= FIGURES.max, `${slug}: ${figures} figures, the lead clip or screenshot included`);
    // The rule leaves out the header, At a glance and every figure, and counts the rest.
    const text = writeupText(html);
    assert.ok(text.startsWith(textOf(html.match(/<p class="tldr">([\s\S]*?)<\/p>/)[1]).trim()), `${slug}: counting starts at the summary`);
    for (const left of ["At a glance", squash(resume.projects.find((p) => p.slug === slug).bullets[0])]) assert.ok(!text.includes(left), `${slug}: counts "${left}"`);
    for (const cap of html.match(/<figcaption>[\s\S]*?<\/figcaption>/g)) assert.ok(!text.includes(textOf(cap).trim()), `${slug}: counts a caption`);
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
const pages = () => builtFiles().filter((f) => f.endsWith(".html")).map((file) => ({ file, html: readFileSync(file, "utf8") }));
const indexable = () => pages().filter((p) => !/<meta name="robots" content="noindex"/.test(p.html));
const tags = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const meta = (html, key) => tags(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, "g"));

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
    assert.match(one("og:image"), new RegExp(`^${escapeRe(ORIGIN)}/`), file);
    assert.equal(one("og:image:width"), "1200");
    assert.equal(one("og:image:height"), "630");
    assert.ok(one("og:image:alt").length >= 10, `${file}: og:image:alt`);
    assert.equal(one("twitter:card"), "summary_large_image");
    assert.equal(one("twitter:image"), one("og:image"), `${file}: X gets the same image`);
  }
});

test("the preview image is a 1200×630 PNG of at most 300 KB", () => {
  const url = decode(meta(home, "og:image")[0]);
  const buf = readFileSync(join(dist, new URL(url).pathname));
  assert.ok(buf.length <= 300 * 1024, `${buf.length} bytes`);
  const { type, width, height } = imageSize(buf) ?? {};
  assert.deepEqual({ type, width, height }, { type: "png", width: 1200, height: 630 });
});

test("iMessage gets a square 180×180 touch icon", () => {
  assert.match(home, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  const { type, width, height } = imageSize(readFileSync(join(dist, "apple-touch-icon.png"))) ?? {};
  assert.deepEqual({ type, width, height }, { type: "png", width: 180, height: 180 });
});

test("every page links favicon.ico (16 and 32 px) and a dark-aware icon.svg", () => {
  for (const { file, html } of indexable()) {
    assert.match(html, /<link rel="icon" href="\/favicon\.ico" sizes="32x32"/, file);
    assert.match(html, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml"/, file);
  }
  const svg = readFileSync(join(dist, "icon.svg"), "utf8");
  assert.match(svg, /prefers-color-scheme: dark/, "the SVG icon has a dark-mode style");
  const ico = readFileSync(join(dist, "favicon.ico"));
  assert.deepEqual([ico.readUInt16LE(2), ico[6 + 16]], [1, 32], "favicon.ico is an icon whose second image is 32 px");
});

test("the sitemap lists exactly the indexable pages, and robots.txt points to it", () => {
  const robots = readFileSync(join(dist, "robots.txt"), "utf8");
  const line = robots.match(/^Sitemap: (\S+)$/m);
  assert.ok(line, "robots.txt has a Sitemap: line");
  assert.match(line[1], new RegExp(`^${escapeRe(ORIGIN)}/`));
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

test("the hero shows a grown plant beside the text, hidden from screen readers, animated only when motion is welcome", () => {
  const hero = home.match(/<section class="hero[^"]*"[\s\S]*?<\/section>/)[0];
  const svg = hero.match(/<svg class="plant"[\s\S]*?<\/svg>/)?.[0];
  assert.ok(svg, "the hero carries the plant");
  assert.match(svg, /aria-hidden="true"/);
  // The plant sits in its own figure, never wrapped around the name or the buttons.
  assert.doesNotMatch(svg, /<h1|class="btn/);
  const css = builtFiles().filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("")
    + [...home.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
  const grow = css.match(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{[\s\S]*?\.plant[\s\S]*?animation/);
  assert.ok(grow, "the draw-in lives inside a no-preference motion query");
  const outside = css.replace(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  assert.doesNotMatch(outside, /\.plant[^{]*\{[^}]*animation/, "no plant animation outside that query");
});

test("the first screen names the most recent past role beside the current one", () => {
  const hero = home.match(/<section class="hero[^"]*"[\s\S]*?<\/section>/)[0];
  const past = resume.experience.find((e) => !/Present$/.test(e.dates));
  assert.match(hero, new RegExp(`<dt>Previously</dt>\\s*<dd>${escapeRe(`${past.title}, ${past.company}`)}</dd>`));
});

test("a write-up opens with a way back, its links as buttons, and an On this page list", () => {
  for (const slug of writeupSlugs()) {
    const html = writeupHtml(slug);
    const head = html.match(/<header class="writeup-head"[\s\S]*?<\/header>/)[0];
    assert.match(head, /^<header class="writeup-head"[^>]*>\s*<a[^>]*href="\/#projects"[^>]*>← All projects<\/a>/, `${slug}: back link first`);
    assert.match(head.match(/<p class="links">[\s\S]*?<\/p>/)[0], /<a class="btn[^"]*" href="[^"]+">Code<\/a>/, `${slug}: Code is a button`);
    const toc = html.match(/<nav class="toc"[^>]*>[\s\S]*?<\/nav>/)?.[0];
    assert.ok(toc, `${slug}: On this page`);
    const sections = [...readFileSync(join(writeupDir, `${slug}.md`), "utf8").matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const targets = [...toc.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.equal(targets.length, sections.length, `${slug}: one entry per section`);
    for (const id of targets) assert.match(html, new RegExp(`<h2 id="${escapeRe(id)}"`), `${slug}: #${id} exists`);
  }
});

test("Now lives in the footer, not the top bar", () => {
  for (const page of ["index.html", "404.html", ...writeupSlugs().map((s) => `projects/${s}/index.html`)]) {
    const html = readFileSync(join(dist, page), "utf8");
    assert.doesNotMatch(html.match(/<header class="topbar"[\s\S]*?<\/header>/)[0], /href="\/now\/"/, `${page}: top bar`);
    assert.match(html.match(/<footer class="footer"[\s\S]*?<\/footer>/)[0], /<a href="\/now\/">Now<\/a>/, `${page}: footer`);
  }
});

test("the first screen says what Lisul is open to, first in the facts list", () => {
  const kv = home.match(/<dl class="kv">[\s\S]*?<\/dl>/)[0];
  assert.match(kv, /^<dl class="kv">\s*<dt>Open to<\/dt>\s*<dd>Summer 2027 software engineering internships<\/dd>/);
});

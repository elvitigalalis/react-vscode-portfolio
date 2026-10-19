// The gate suite (`npm run check`) against the real build and against broken copies of it.
// Each gate must pass on the real dist/ and fail on a fixture broken in exactly one way.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { mirror } from "../check/mirror.mjs";
import { routing } from "../check/routing.mjs";
import { lint } from "../check/lint.mjs";
import { tags } from "../check/tags.mjs";
import { html, links, lighthouse } from "../check/tools.mjs";

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

// --- hand-written-text lint -------------------------------------------------

const realContent = join(root, "src/content");
// A content folder holding one write-up, `projects/demo.md`.
function writeup(frontMatter, body) {
  const content = mkdtempSync(join(tmpdir(), "content-"));
  write(content, "projects/demo.md", `---\ntitle: Demo\n${frontMatter}---\n\n${body}\n`);
  return content;
}

test("lint: passes on the real hand-written text", async () => {
  assert.deepEqual(await lint({ content: realContent, resume }), []);
});

test("lint: fails on each kind of banned wording", async () => {
  const cases = [
    "I got a return offer at the end.",
    "The company was acquired by a bigger one.",
    "It was formerly a startup.",
    "I landed 386 commits.",
    "The adapters are deployed at LA Metro.",
    "LA Metro now runs it in production after we deployed it.",
    "I built a robotic arm.",
    "Inference runs on CUDA.",
  ];
  for (const line of cases) {
    const problems = await lint({ content: writeup("", line), resume });
    assert.equal(problems.length, 1, `${line}\n${problems.join("\n")}`);
    assert.match(problems[0], /projects\/demo\.md: banned wording/);
  }
  // Stating the plan the résumé states is not a deployment claim.
  assert.deepEqual(await lint({ content: writeup("", "It was validated ahead of a planned LA Metro rollout."), resume }), []);
});

test("lint: a number must trace to resume.json or the file's sources", async () => {
  const body = "Exploration took 7.25 minutes; the drift fell from 3.4° to 0.62°, and 500+ buses ran in 2026.";
  const problems = await lint({ content: writeup("", body), resume });
  assert.deepEqual(problems.map((p) => p.match(/"([^"]+)"/)[1]).sort(), ["0.62", "3.4", "7.25"]);

  const sourced = writeup("sources:\n  - Lab notebook: drift 3.4° before the fix and 0.62° after\n  - Run log: 7.25 min exploration\n", body);
  assert.deepEqual(await lint({ content: sourced, resume }), []);
});

test("lint: numbers in links, image paths and YAML comments are not prose", async () => {
  const content = writeup("# a 1234 comment\nphoto: /images/robot-360.webp\n", "See ![the board](/images/pcb-720.webp) and [the repo](https://github.com/x/y2024).");
  assert.deepEqual(await lint({ content, resume }), []);
  const front = writeup("summary: It ran 77 laps.\n", "Body.");
  assert.match((await lint({ content: front, resume })).join("\n"), /"77"/);
});

// --- tags -----------------------------------------------------------------

// A real PNG of the given size; `pad` bytes of junk metadata make it heavier.
function png(width, height, pad = 0) {
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, "latin1"); data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)),
    ...(pad ? [chunk("tEXt", Buffer.alloc(pad, 97))] : []), chunk("IEND", Buffer.alloc(0))]);
}

const SITE = "https://www.lisul-elvi.com";
const jsonLd = () => [
  { "@context": "https://schema.org", "@type": "WebSite", name: resume.basics.name, url: `${SITE}/` },
  { "@context": "https://schema.org", "@type": "ProfilePage",
    mainEntity: { "@type": "Person", name: resume.basics.name, url: `${SITE}/`, sameAs: resume.basics.links.map((l) => l.url) } },
];
// What #157 adds: full preview tags on every page, JSON-LD on /, the OG image, a sitemap.
function seo(d, { image = png(1200, 630), ld = JSON.stringify(jsonLd()), drop = null } = {}) {
  write(d, "og.png", image);
  write(d, "sitemap-index.xml", `<?xml version="1.0"?><sitemapindex/>`);
  write(d, "robots.txt", `User-agent: *\nDisallow:\nSitemap: ${SITE}/sitemap-index.xml\n`);
  for (const file of ["index.html", "404.html"]) {
    const html = read(d, file);
    const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
    const m = {
      "og:title": "A title", "og:description": "A description.", "og:url": canonical, "og:type": "website",
      "og:site_name": resume.basics.name, "og:image": `${SITE}/og.png`, "og:image:width": "1200", "og:image:height": "630",
      "og:image:alt": "A micromouse on a maze", "twitter:card": "summary_large_image",
    };
    delete m[drop];
    let head = Object.entries(m).map(([k, v]) => `<meta ${k.startsWith("og:") ? "property" : "name"}="${k}" content="${v}">`).join("");
    if (file === "index.html" && ld !== null) head += `<script type="application/ld+json">${ld}</script>`;
    write(d, file, html.replace("</head>", head + "</head>"));
  }
}

test("tags: passes on the real build", async () => {
  assert.deepEqual(await tags({ dist: realDist, resume }), []);
});

test("tags: every page needs a unique title, a description and an absolute canonical", async () => {
  const cases = [
    [(h) => h.replace(/<meta name="description"[^>]*>/, ""), /index\.html: no meta description/],
    [(h) => h.replace(/<link rel="canonical"[^>]*>/, ""), /index\.html: no canonical/],
    [(h) => h.replace(`href="${SITE}/"`, 'href="/"'), /index\.html: canonical "\/" is not absolute/],
    [(h) => h.replace(/<title>[^<]*<\/title>/, "<title>Page not found · Lisul Elvitigala</title>"), /same title/],
  ];
  for (const [edit, want] of cases) {
    const dist = broken((d) => write(d, "index.html", edit(read(d, "index.html"))));
    assert.match((await tags({ dist, resume })).join("\n"), want);
  }
});

test("tags: once preview tags exist, the full set must be right on every page", async () => {
  assert.deepEqual(await tags({ dist: broken((d) => seo(d)), resume }), [], "the complete fixture passes");

  const partial = broken((d) => write(d, "index.html", read(d, "index.html").replace("</head>", '<meta property="og:title" content="x"></head>')));
  assert.match((await tags({ dist: partial, resume })).join("\n"), /404\.html: no og:image/);

  for (const drop of ["og:description", "og:image:alt", "twitter:card", "og:site_name"]) {
    const dist = broken((d) => seo(d, { drop }));
    assert.match((await tags({ dist, resume })).join("\n"), new RegExp(`no ${drop}`));
  }
});

test("tags: the OG image must be 1200×630 and at most 300 KB", async () => {
  const wrong = broken((d) => seo(d, { image: png(1280, 812) }));
  assert.match((await tags({ dist: wrong, resume })).join("\n"), /og\.png is 1280×812/);
  const heavy = broken((d) => seo(d, { image: png(1200, 630, 310 * 1024) }));
  assert.match((await tags({ dist: heavy, resume })).join("\n"), /og\.png is \d+ KB/);
});

test("tags: the home page's JSON-LD must parse and tie the profiles together", async () => {
  const unparsable = broken((d) => seo(d, { ld: "{not json" }));
  assert.match((await tags({ dist: unparsable, resume })).join("\n"), /JSON-LD does not parse/);
  const missing = broken((d) => seo(d, { ld: null }));
  assert.match((await tags({ dist: missing, resume })).join("\n"), /no WebSite/);
  const ld = jsonLd(); ld[1].mainEntity.sameAs = ld[1].mainEntity.sameAs.slice(0, 1);
  const sameAs = broken((d) => seo(d, { ld: JSON.stringify(ld) }));
  assert.match((await tags({ dist: sameAs, resume })).join("\n"), /sameAs is missing https:\/\/github\.com/);
});

test("tags: robots.txt must point at the sitemap", async () => {
  const dist = broken((d) => { seo(d); write(d, "robots.txt", "User-agent: *\nDisallow:\n"); });
  assert.match((await tags({ dist, resume })).join("\n"), /robots\.txt: no Sitemap/);
});

// --- html-validate --------------------------------------------------------

test("html: passes on the real build", async () => {
  assert.deepEqual(await html({ root, dist: realDist }), []);
});

test("html: fails on invalid markup in any page", async () => {
  const dist = broken((d) => write(d, "projects/demo/index.html", page('<div id="a"></div><p id="a">Two ids <span>unclosed</p>')));
  const problems = (await html({ root, dist })).join("\n");
  assert.match(problems, /projects\/demo\/index\.html/);
  assert.match(problems, /no-dup-id/);
});

// --- lychee ---------------------------------------------------------------

test("links: passes on the real build", async () => {
  assert.deepEqual(await links({ dist: realDist }), []);
});

test("links: fails on a broken internal link or #anchor", async () => {
  const file = broken((d) => write(d, "index.html", read(d, "index.html").replace("</main>", '<a href="/projects/nope/">x</a></main>')));
  assert.match((await links({ dist: file })).join("\n"), /projects\/nope/);
  const anchor = broken((d) => write(d, "404.html", read(d, "404.html").replace("</main>", '<a href="/#nowhere">x</a></main>')));
  assert.match((await links({ dist: anchor })).join("\n"), /#nowhere/);
  // Absolute links on the site's own origin are checked against the build, not the live site.
  const own = broken((d) => write(d, "index.html", read(d, "index.html").replace("</main>", '<a href="https://www.lisul-elvi.com/gone/">x</a></main>')));
  assert.match((await links({ dist: own })).join("\n"), /gone/);
});

// --- Lighthouse CI --------------------------------------------------------

test("lighthouse: passes on the real build", { timeout: 300_000 }, async () => {
  assert.deepEqual(await lighthouse({ root, dist: realDist, runs: 1 }), []);
});

test("lighthouse: fails over the JS budget, and write-ups get 300 KB where / gets 100 KB", { timeout: 300_000 }, async () => {
  const dist = broken((d) => {
    write(d, "big.js", `window.x = "${randomBytes(20 * 1024).toString("base64")}";`); // incompressible
    write(d, "index.html", read(d, "index.html").replace("</body>", '<script src="/big.js"></script></body>'));
    // 150 KB fits a write-up's 300 KB budget; 400 KB does not.
    for (const [slug, kb] of [["light", 150], ["heavy", 400]]) {
      write(d, `projects/${slug}/photo.png`, png(600, 400, kb * 1024));
      write(d, `projects/${slug}/index.html`, page(`<h1>${slug}</h1><img src="photo.png" width="600" height="400" alt="A test photo of nothing">`,
        '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="A fixture page.">'));
    }
  });
  const problems = await lighthouse({ root, dist, runs: 1 });
  const text = problems.join("\n");
  assert.match(text, /^\/index\.html: resource-summary:script:size/m);
  assert.match(text, /^\/projects\/heavy\/index\.html: resource-summary:total:size/m);
  assert.doesNotMatch(text, /^\/projects\/light\/index\.html: resource-summary:total:size/m);
});

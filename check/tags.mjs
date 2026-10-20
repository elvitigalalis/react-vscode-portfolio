// Tag gate: what a crawler or link-preview bot reads in each page's <head>.
// Always: one unique <title>, a meta description, an absolute canonical on the www origin
// (a noindex page, such as the 404, may leave the canonical out).
// Once the site carries any preview or structured-data tag (or a sitemap), all of them are
// required: full Open Graph and twitter:card on every page, a 1200×630 OG image of at most
// 300 KB, WebSite and ProfilePage/Person JSON-LD on / with sameAs from resume.json, and a
// Sitemap: line in robots.txt.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decode, htmlPages, imageSize, ORIGIN } from "./lib.mjs";

const OG = ["og:title", "og:description", "og:url", "og:type", "og:site_name", "og:image", "og:image:width", "og:image:height", "og:image:alt"];
const MAX_IMAGE = 300 * 1024;

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));

function head(html) {
  const meta = {};
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/g)) {
    const a = attrs(tag);
    const key = a.property ?? a.name;
    if (key && a.content !== undefined) meta[key] = decode(a.content);
  }
  return {
    titles: [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)].map((m) => decode(m[1]).trim()),
    canonical: [...html.matchAll(/<link\b[^>]*>/g)].map((m) => attrs(m[0])).find((a) => a.rel === "canonical")?.href,
    meta,
    ld: [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]),
  };
}

// Every node in a JSON-LD document, including @graph members and nested objects.
const nodes = (v) => (Array.isArray(v) ? v.flatMap(nodes) : v && typeof v === "object" ? [v, ...Object.values(v).flatMap(nodes)] : []);
const isType = (n, t) => [n["@type"]].flat().includes(t);

export async function tags({ dist, resume }) {
  const problems = [];
  const pages = htmlPages(dist).map((file) => ({ file, ...head(readFileSync(join(dist, file), "utf8")) }));
  const seo = existsSync(join(dist, "sitemap-index.xml")) ||
    pages.some((p) => p.ld.length || Object.keys(p.meta).some((k) => k.startsWith("og:") || k.startsWith("twitter:")));

  const seen = new Map();
  for (const { file, titles, canonical, meta, ld } of pages) {
    const bad = (msg) => problems.push(`${file}: ${msg}`);
    if (titles.length !== 1 || !titles[0]) bad(`needs exactly one non-empty <title>, has ${titles.length}`);
    else if (seen.has(titles[0])) bad(`same title as ${seen.get(titles[0])}: "${titles[0]}"`);
    else seen.set(titles[0], file);
    if (!meta.description?.trim()) bad("no meta description");
    const noindex = /\bnoindex\b/i.test(meta.robots ?? "");
    if (!canonical) { if (!noindex) bad("no canonical"); }
    else if (!canonical.startsWith(`${ORIGIN}/`)) bad(`canonical "${canonical}" is not absolute on ${ORIGIN}`);

    for (const json of ld) {
      try { JSON.parse(json); } catch { bad("JSON-LD does not parse"); }
    }
    if (!seo) continue;
    for (const k of OG) if (!meta[k]?.trim()) bad(`no ${k}`);
    if (meta["twitter:card"] !== "summary_large_image") bad("no twitter:card summary_large_image");
    if (meta["og:url"] && canonical && meta["og:url"] !== canonical) bad(`og:url ${meta["og:url"]} is not the canonical`);
    if (meta["og:image:width"] && meta["og:image:width"] !== "1200") bad("og:image:width is not 1200");
    if (meta["og:image:height"] && meta["og:image:height"] !== "630") bad("og:image:height is not 630");
  }
  if (!seo) return problems;

  for (const url of new Set(pages.map((p) => p.meta["og:image"]).filter(Boolean))) {
    if (!url.startsWith(`${ORIGIN}/`)) { problems.push(`og:image ${url} is not an absolute URL on ${ORIGIN}`); continue; }
    const path = decodeURIComponent(new URL(url).pathname);
    const file = join(dist, path);
    if (!existsSync(file)) { problems.push(`og:image ${path} is not in the build`); continue; }
    const dims = imageSize(readFileSync(file));
    if (!dims) problems.push(`og:image ${path} is not a PNG or JPEG`);
    else if (dims.width !== 1200 || dims.height !== 630) problems.push(`og:image ${path} is ${dims.width}×${dims.height}, not 1200×630`);
    const kb = statSync(file).size;
    if (kb > MAX_IMAGE) problems.push(`og:image ${path} is ${Math.round(kb / 1024)} KB, over 300 KB`);
  }

  const home = pages.find((p) => p.file === "index.html");
  const graph = nodes(home.ld.flatMap((j) => { try { return [JSON.parse(j)]; } catch { return []; } }));
  const site = graph.find((n) => isType(n, "WebSite"));
  if (!site?.name || !site?.url) problems.push("index.html: no WebSite JSON-LD with name and url");
  const person = graph.find((n) => isType(n, "ProfilePage"))?.mainEntity;
  if (!person || !isType(person, "Person")) problems.push("index.html: no ProfilePage JSON-LD with a Person mainEntity");
  else {
    if (person.name !== resume.basics.name) problems.push(`index.html: JSON-LD Person name is not "${resume.basics.name}"`);
    const sameAs = [person.sameAs ?? []].flat();
    for (const { url } of resume.basics.links) if (!sameAs.includes(url)) problems.push(`index.html: JSON-LD sameAs is missing ${url}`);
  }

  const robots = existsSync(join(dist, "robots.txt")) ? readFileSync(join(dist, "robots.txt"), "utf8") : "";
  if (!existsSync(join(dist, "sitemap-index.xml"))) problems.push("sitemap-index.xml: missing");
  if (!robots.includes(`Sitemap: ${ORIGIN}/sitemap-index.xml`)) problems.push(`robots.txt: no Sitemap: ${ORIGIN}/sitemap-index.xml line`);
  return problems;
}

// Helpers shared by the gates: walking the build and reading its text the way a visitor sees it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative } from "node:path";

export { ORIGIN, RESUME_PDF } from "../src/site.mjs";

// A string as a literal piece of a regular expression.
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Every file under `dir` whose name matches `re`, as paths relative to `dir`.
export function files(dir, re = /./, sub = dir) {
  return readdirSync(sub, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(dir, re, join(sub, d.name)) : re.test(d.name) ? [relative(dir, join(sub, d.name))] : []);
}

export const htmlPages = (dist) => files(dist, /\.html$/).sort();

// HTML entities decoded: numeric ones and the few named ones Astro writes.
export const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The text a reader sees: tags dropped, entities decoded, whitespace collapsed.
export const textOf = (html) => decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ");

export const squash = (s) => s.replace(/\s+/g, " ").trim();

// Width and height of a PNG or JPEG, or null for anything else.
export function imageSize(buf) {
  if (buf.subarray(1, 4).toString() === "PNG") return { type: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length; ) {
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { type: "jpeg", width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

// Serve a built folder on localhost the way GitHub Pages does (dir/ -> dir/index.html,
// misses -> 404.html). Resolves to { url, close }.
export function serve(dir) {
  const types = { html: "text/html; charset=utf-8", css: "text/css", js: "text/javascript", json: "application/json", xml: "application/xml",
    txt: "text/plain", png: "image/png", jpg: "image/jpeg", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon",
    pdf: "application/pdf", mp4: "video/mp4", vtt: "text/vtt" };
  const server = createServer((req, res) => {
    let path = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!path.startsWith(dir)) path = join(dir, "404.html");
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    const found = existsSync(path);
    if (!found) path = join(dir, "404.html");
    res.writeHead(found ? 200 : 404, { "content-type": types[extname(path).slice(1)] ?? "application/octet-stream" });
    res.end(existsSync(path) ? readFileSync(path) : "");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () =>
    ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })));
}

// Helpers shared by the gates: walking the build and reading its text the way a visitor sees it.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

// Every file under `dir` whose name matches `re`, as paths relative to `dir`.
export function files(dir, re = /./, sub = dir) {
  return readdirSync(sub, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(dir, re, join(sub, d.name)) : re.test(d.name) ? [relative(dir, join(sub, d.name))] : []);
}

export const htmlPages = (dist) => files(dist, /\.html$/).sort();

// The text a reader sees: tags dropped, entities decoded, whitespace collapsed.
export function textOf(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

export const squash = (s) => s.replace(/\s+/g, " ").trim();

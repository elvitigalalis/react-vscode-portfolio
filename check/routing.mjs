// Routing gate: old links keep working. /404.html exists with the top bar, the résumé PDF
// keeps its old path, and the inline script sends old #/section hashes to #section (an
// unknown one to #top).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RESUME_PDF } from "./lib.mjs";

const PDF = RESUME_PDF.slice(1);

export async function routing({ dist }) {
  const problems = [];
  const at = (f) => join(dist, f);

  if (!existsSync(at("404.html"))) problems.push("404.html: missing");
  else {
    const page = readFileSync(at("404.html"), "utf8");
    if (!page.includes(`href="/${PDF}"`) || !page.includes('href="/#projects"')) problems.push("404.html: no top bar (résumé and projects links)");
  }

  if (!existsSync(at(PDF))) problems.push(`${PDF}: missing`);
  else if (readFileSync(at(PDF)).subarray(0, 5).toString() !== "%PDF-") problems.push(`${PDF}: not a PDF`);

  const home = readFileSync(at("index.html"), "utf8");
  const scripts = [...home.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const land = (code, hash) => {
    let to = null;
    try { new Function("location", code)({ hash, replace: (h) => { to = h; } }); } catch {}
    return to;
  };
  const cases = { "#/projects": "#projects", "#/experience": "#experience", "#/": "#top", "#/no-such-page": "#top", "#projects": null };
  const code = scripts.find((c) => land(c, "#/projects") !== null);
  if (!code) problems.push("index.html: no hash-rewrite script for old #/section links");
  for (const [from, to] of Object.entries(cases)) {
    const got = code ? land(code, from) : undefined;
    if (code && got !== to) problems.push(`index.html: ${from} lands on ${got}, not ${to}`);
  }
  for (const id of ["top", "projects", "experience", "education", "skills"])
    if (!home.includes(`id="${id}"`)) problems.push(`index.html: no #${id} to land on`);
  return problems;
}

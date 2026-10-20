// Hand-written-text lint over every markdown file in src/content (the home page's expand layer
// and the write-ups). Every number must trace to resume.json or to the file's own `sources:`
// list, and the standing rules' banned wording must not appear.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { files } from "./lib.mjs";

const DEPLOY = String.raw`(?:deploy\w*|launch\w*|rolled out|runs?|running|live|in production|in service)`;
// The standing rules' banned wording, one list for the gate and the tests.
export const BANNED = [
  [/\boffers?\b/i, "an offer tag"],
  [/acquired by/i, '"acquired by"'],
  [/\bformerly\b/i, '"formerly"'],
  [/\b\d[\d,]*\+?\s+commits?\b/i, "a number of commits"],
  [new RegExp(String.raw`\bLA Metro\b[^.]{0,60}\b${DEPLOY}\b|\b${DEPLOY}\b[^.]{0,60}\bLA Metro\b`, "i"), "an LA Metro deployment claim"],
  [/robotic arm/i, '"robotic arm"'],
  [/\bCUDA\b/i, '"CUDA"'],
];

// Numbers as a reader sees them: "2.75°" -> 2.75, "1,200" -> 1200, "87%" -> 87. Digits glued to
// letters (YOLOv8, v3) are names, not numbers.
export const numbersIn = (text, glued = false) =>
  [...text.matchAll(glued ? /\d+(?:[.,]\d+)*/g : /(?<![\p{L}\d_.])\d+(?:[.,]\d+)*(?![\p{L}\d_])/gu)]
    .map((m) => m[0].replace(/,(?=\d{3}\b)/g, ""));

// Every string in a parsed YAML value.
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const isLink = (s) => /^(https?:|mailto:|\/|\.\.?\/)\S*$/.test(s.trim());

// The prose of a markdown body: link targets, image paths, bare URLs, tags and code dropped.
const prose = (md) => md
  .replace(/```[\s\S]*?```|`[^`]*`/g, " ")
  .replace(/\]\([^)]*\)/g, "] ")
  .replace(/<[^>]*>/g, " ")
  .replace(/https?:\/\/\S+/g, " ");

export async function lint({ content, resume }) {
  const known = new Set(numbersIn(strings(resume).join("\n"), true));
  const problems = [];
  for (const file of files(content, /\.mdx?$/).sort()) {
    const src = readFileSync(join(content, file), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
    const data = (fm && parse(fm[1])) || {};
    const { sources = [], ...rest } = data;
    const sourced = new Set(numbersIn(strings(sources).join("\n"), true));
    const said = [...strings(rest).filter((s) => !isLink(s)), prose(fm ? src.slice(fm[0].length) : src)].join("\n");
    const text = [said, ...strings(sources)].join("\n");

    for (const [re, what] of BANNED) {
      const m = re.exec(text);
      if (m) problems.push(`${file}: banned wording, ${what}: "${m[0]}"`);
    }
    for (const n of new Set(numbersIn(said)))
      if (!known.has(n) && !sourced.has(n)) problems.push(`${file}: "${n}" traces to neither resume.json nor this file's sources:`);
  }
  return problems;
}

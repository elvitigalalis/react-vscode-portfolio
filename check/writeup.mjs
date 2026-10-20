// Length gate: each write-up runs 700 to 1,200 words with 2 to 4 figures (spec #152 aims at
// 1,000 words). What counts, one rule for this gate and the tests: every
// word of rendered text in the page's <article>, except its header (title, role, dates, tags,
// links), the "At a glance" box (résumé bullets, mirrored), and every <figure> with its
// caption (the clip or screenshot, diagrams, charts and photos). A word is a run of
// non-space characters holding a letter or digit, so "2.75°" counts and "→" does not.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { textOf } from "./lib.mjs";

export const WORDS = { min: 700, max: 1200 };
export const FIGURES = { min: 2, max: 4 };

const articleOf = (html) => /<article\b[^>]*class="writeup"[^>]*>([\s\S]*?)<\/article>/.exec(html)?.[1] ?? "";

export function writeupText(html) {
  return textOf(articleOf(html)
    .replace(/<header\b[^>]*class="writeup-head"[\s\S]*?<\/header>/, "")
    .replace(/<aside\b[^>]*id="at-a-glance"[\s\S]*?<\/aside>/, "")
    .replace(/<figure\b[\s\S]*?<\/figure>/g, "")
    .replace(/<[^>]+>/g, " ")).trim(); // a tag separates words: "1.01°.</p><h2>The" is two
}

export const wordCount = (html) => writeupText(html).split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// Every figure in the article, the lead clip or screenshot included.
export const figureCount = (html) => (articleOf(html).match(/<figure\b/g) ?? []).length;

export async function length({ dist, resume }) {
  const problems = [];
  for (const { slug } of resume.projects) {
    const file = `projects/${slug}/index.html`;
    if (!existsSync(join(dist, file))) continue; // no write-up yet
    const html = readFileSync(join(dist, file), "utf8");
    const words = wordCount(html);
    const figures = figureCount(html);
    if (words < WORDS.min || words > WORDS.max) problems.push(`${file}: ${words} words, not ${WORDS.min} to ${WORDS.max}`);
    if (figures < FIGURES.min || figures > FIGURES.max) problems.push(`${file}: ${figures} figures, not ${FIGURES.min} to ${FIGURES.max}`);
  }
  return problems;
}

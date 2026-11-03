// icon() in planner.mjs (docs/sheet-glance.md, "The icon set"): one sprite symbol, built with
// createElementNS and hidden from screen readers. A tiny fake document records what it builds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { icon } from "../src/sheet/planner.mjs";

const SVG = "http://www.w3.org/2000/svg";
const node = (ns, tag) => ({
  ns, tag, attrs: {}, kids: [], textContent: "",
  setAttribute(k, v) { this.attrs[k] = String(v); },
  append(...k) { this.kids.push(...k); },
  set innerHTML(_) { throw new Error("innerHTML used"); },
});
globalThis.document = { createElementNS: node, createElement: (t) => node(null, t) };

test("icon: an aria-hidden svg.sheet-icon that uses the sprite's symbol", () => {
  const svg = icon("lock");
  assert.equal(svg.ns, SVG);
  assert.equal(svg.tag, "svg");
  assert.equal(svg.attrs["aria-hidden"], "true");
  assert.equal(svg.attrs.class, "sheet-icon");
  const use = svg.kids.find((k) => k.tag === "use");
  assert.equal(use.ns, SVG);
  assert.equal(use.attrs.href, "#i-lock");
  assert.equal(svg.kids.some((k) => k.tag === "title"), false);
});

test("icon: a label becomes the svg's title, for hover", () => {
  const title = icon("lock", "Only you see this").kids.find((k) => k.tag === "title");
  assert.equal(title.ns, SVG);
  assert.equal(title.textContent, "Only you see this");
});

test("the sprite has a symbol for every icon the contract lists", () => {
  const page = readFileSync(new URL("../src/pages/plan/index.astro", import.meta.url), "utf8");
  const names = ["lock", "clock", "flag", "alert-triangle", "graduation-cap", "ticket", "utensils", "sparkles", "bell",
    "bell-off", "circle-check", "circle-alert", "mail", "check", "more-horizontal", "chevron-left", "chevron-right"];
  for (const n of names) assert.match(page, new RegExp(`<symbol id="i-${n}" viewBox="0 0 24 24">`), n);
  assert.match(page, /<!--[^]*Lucide[^]*ISC[^]*-->/, "the licence notice is kept");
});

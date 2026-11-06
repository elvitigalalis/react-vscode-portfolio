// A rolled task fades only its title, a step per roll (research/plan-improvements.md 7), and the
// faded title keeps WCAG 1.4.3's 4.5:1 on the page and on --chip (a held or picked row), in
// both themes. Contrast per https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rollOpacity } from "../src/sheet/logic.mjs";

const css = readFileSync(new URL("../src/styles/global.css", import.meta.url), "utf8");
const token = (name) => css.match(new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`, "i")).slice(1);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const over = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));

test("rollOpacity: full ink, then a step fainter per roll, stopping at the second", () => {
  assert.equal(rollOpacity(0), 1);
  assert.ok(rollOpacity(1) < 1 && rollOpacity(2) < rollOpacity(1));
  assert.equal(rollOpacity(5), rollOpacity(2));
});

test("rollOpacity: a twice-rolled title keeps 4.5:1 on --bg and --chip in both themes", () => {
  const [fg, bg, chip] = ["fg", "bg", "chip"].map(token);
  for (const mode of [0, 1]) for (const ground of [bg, chip]) {
    const r = ratio(over(rgb(fg[mode]), rgb(ground[mode]), rollOpacity(2)), rgb(ground[mode]));
    assert.ok(r >= 4.5, `${mode ? "dark" : "light"} on ${ground[mode]}: ${r.toFixed(2)}:1`);
  }
});

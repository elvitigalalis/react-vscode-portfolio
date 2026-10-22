// The hero's plant (src/plant/grow.mjs): grown from a seed at build time, as plain SVG text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { growPlant } from "../src/plant/grow.mjs";

test("a seed always grows the same plant, as decorative SVG", () => {
  const svg = growPlant("4f2a9c1");
  assert.equal(growPlant("4f2a9c1"), svg);
  assert.match(svg, /^<svg\b[^>]*\baria-hidden="true"/);
  assert.match(svg, /<\/svg>$/);
});

test("different seeds grow different plants", () => {
  const seeds = Array.from({ length: 20 }, (_, i) => `commit-${i}`);
  assert.equal(new Set(seeds.map(growPlant)).size, 20);
});

test("every plant stays inside its frame, leaves and all", () => {
  // A leaf is at most 26 units long, so its base needs that much room from every edge.
  const LEAF = 26;
  for (let i = 0; i < 300; i++) {
    const svg = growPlant(`seed-${i}`);
    const [, , w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
    for (const [, d] of svg.matchAll(/class="s" d="([^"]+)"/g)) {
      const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
      for (let j = 0; j < nums.length; j += 2) {
        assert.ok(nums[j] >= 0 && nums[j] <= w && nums[j + 1] >= 0 && nums[j + 1] <= h, `seed-${i}: stem point ${nums[j]},${nums[j + 1]} is outside ${w}×${h}`);
      }
    }
    for (const [, x, y] of svg.matchAll(/translate\((-?[\d.]+) (-?[\d.]+)\)/g)) {
      assert.ok(+x >= LEAF && +x <= w - LEAF && +y >= LEAF && +y <= h - LEAF, `seed-${i}: leaf at ${x},${y} pokes out of ${w}×${h}`);
    }
  }
});

test("a plant weighs at most 15 KB and carries no script", () => {
  for (let i = 0; i < 300; i++) {
    const svg = growPlant(`seed-${i}`);
    assert.ok(Buffer.byteLength(svg) <= 15 * 1024, `seed-${i}: ${Buffer.byteLength(svg)} bytes`);
    assert.doesNotMatch(svg, /<script|\bon\w+=/i);
  }
});

test("every plant is full enough to hold the hero: at least 24 leaves", () => {
  for (let i = 0; i < 300; i++) {
    const leaves = growPlant(`seed-${i}`).match(/class="f /g).length;
    assert.ok(leaves >= 24, `seed-${i}: only ${leaves} leaves`);
  }
});

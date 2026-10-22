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
  for (let i = 0; i < 300; i++) {
    const svg = growPlant(`seed-${i}`);
    const [, , w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
    const inside = (x, y, room = 0) => x >= room && x <= w - room && y >= room && y <= h - room;
    for (const [, d] of svg.matchAll(/class="s" d="([^"]+)"/g)) {
      const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
      for (let j = 0; j < nums.length; j += 2) assert.ok(inside(nums[j], nums[j + 1]), `seed-${i}: stem point ${nums[j]},${nums[j + 1]} is outside ${w}×${h}`);
    }
    // A leaf is drawn from its base along +x to its tip at (length, 0), then placed and turned, so
    // its base needs its own length of room on every side, whichever way it points.
    for (const [, d, x, y] of svg.matchAll(/class="f f\d" d="M0 0C[^ ]+ [^ ]+ [^ ]+ [^ ]+ ([\d.]+) 0C[^"]*" transform="translate\((-?[\d.]+) (-?[\d.]+)\)/g)) {
      assert.ok(inside(+x, +y, +d), `seed-${i}: a ${d}-long leaf at ${x},${y} pokes out of ${w}×${h}`);
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

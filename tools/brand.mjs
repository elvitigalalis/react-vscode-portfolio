// Renders the favicon set from one "LE" mark, drawn on a 32-unit grid so every edge lands on
// a whole pixel at 16 and 32 px. Writes into public/; run it after changing the mark.
// Usage: node tools/brand.mjs   (needs rsvg-convert: `brew install librsvg`)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = new URL("../public/", import.meta.url).pathname;
// The site's accent and its ink colours (src/styles/global.css), light then dark.
const LIGHT = { bg: "#9a3412", fg: "#ffffff" };
const DARK = { bg: "#fdba74", fg: "#1c1917" };

// L and E, each 10 wide and 20 tall with 4-unit strokes, inside x 4..28, y 6..26.
const LETTERS = "M4 6h4v16h6v4H4zM18 6h10v4h-6v4h4v4h-4v4h6v4H18z";

// radius: corner of the tile (0 for a full-bleed square); scale: letter size about the centre.
function mark({ radius = 7, scale = 1, colours = LIGHT, dark = false } = {}) {
  const t = scale === 1 ? "" : ` transform="translate(16 16) scale(${scale}) translate(-16 -16)"`;
  const style = dark
    ? `<style>@media (prefers-color-scheme: dark){.bg{fill:${DARK.bg}}.fg{fill:${DARK.fg}}}</style>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${style}` +
    `<rect class="bg" width="32" height="32" rx="${radius}" fill="${colours.bg}"/>` +
    `<path class="fg"${t} fill="${colours.fg}" d="${LETTERS}"/></svg>\n`;
}

const tmp = mkdtempSync(join(tmpdir(), "brand-"));
function png(svg, size, name) {
  const src = join(tmp, `${name}.svg`);
  writeFileSync(src, svg);
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", join(out, name), src]);
  return readFileSync(join(out, name));
}

// An ICO that wraps PNGs (supported by every browser since IE Vista-era).
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size % 256, e);
    head.writeUInt8(size % 256, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(([, d]) => d)]);
}

writeFileSync(join(out, "icon.svg"), mark({ dark: true }));
const p16 = png(mark(), 16, "favicon-16.png");
const p32 = png(mark(), 32, "favicon-32.png");
writeFileSync(join(out, "favicon.ico"), ico([[16, p16], [32, p32]]));
// iOS rounds the corners itself and shows transparency as black, so this one is full-bleed.
// No web manifest: the site is not an installable app, and Lighthouse counts the manifest
// fetch as a render-blocking chain.
png(mark({ radius: 0, scale: 0.8 }), 180, "apple-touch-icon.png");
execFileSync("rm", ["-r", tmp, join(out, "favicon-16.png"), join(out, "favicon-32.png")]);

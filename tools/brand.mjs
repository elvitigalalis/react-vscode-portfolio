// Renders the favicon set from one "LE" mark, drawn on a 32-unit grid so every edge lands on
// a whole pixel at 16 and 32 px. Writes into public/; run it after changing the mark.
// Usage: node tools/brand.mjs   (needs rsvg-convert: `brew install librsvg`)
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = new URL("../public/", import.meta.url).pathname;
// The site's accent and its ink colours (src/styles/global.css), light then dark.
const LIGHT = { bg: "#2346c8", fg: "#fdfbf3" };
const DARK = { bg: "#9db2ff", fg: "#0e1430" };

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
execFileSync("rm", [join(out, "favicon-16.png"), join(out, "favicon-32.png")]);

// The link-preview image, 1200×630: the mark, name, role and one line, in the site's colours
// and system font, drawn by headless Chrome. Everything sits in the middle so a square crop
// (iMessage, WhatsApp) keeps the mark and most of the name.
const og = `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
body { background: #fdfbf3; color: #1b1f33; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
svg { width: 96px; height: 96px; margin-bottom: 40px; }
h1 { margin: 0; font-size: 88px; font-weight: 700; letter-spacing: -0.025em; line-height: 1; }
.role { margin: 22px 0 0; font-size: 40px; font-weight: 600; color: #2346c8; }
.line { margin: 14px 0 0; font-size: 30px; color: #5c5648; }
.site { position: absolute; bottom: 40px; font-size: 22px; color: #5c5648; letter-spacing: 0.02em; }
</style>
${mark()}
<h1>Lisul Elvitigala</h1>
<p class="role">Software Engineer</p>
<p class="line">Computer Science at Stony Brook University</p>
<p class="site">lisul-elvi.com</p>`;
const page = join(tmp, "og.html");
writeFileSync(page, og);
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
execFileSync(chrome, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
  "--window-size=1200,630", `--screenshot=${join(out, "og.png")}`, `file://${page}`], { stdio: "ignore" });
execFileSync("rm", ["-r", tmp]);

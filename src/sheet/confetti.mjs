// The big moment's confetti (celebrate.mjs): about 80 paper bits flung up from the check, falling
// under gravity on one fixed canvas for 1.2 s, which is then removed. Loaded on demand, so /plan's
// first load doesn't carry it. Callers check prefers-reduced-motion first.
import { COLORS } from "./celebrate.mjs";

const LIFE_MS = 1200;
const COUNT = 80;
const GRAVITY = 1500; // px/s²

// The site's colour tokens are light-dark() pairs, which a canvas can't read: resolve each by
// letting the page compute it.
function palette(host) {
  const probe = document.createElement("i");
  host.append(probe);
  const out = COLORS.map((c) => { probe.style.color = `var(${c})`; return getComputedStyle(probe).color; });
  probe.remove();
  return out;
}

export function fling(at, host = document.body) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = innerWidth;
  const h = innerHeight;
  const canvas = document.createElement("canvas");
  canvas.className = "sheet-confetti";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  host.append(canvas);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const colors = palette(host);
  const bits = Array.from({ length: COUNT }, (_, i) => {
    // Upward, in a fan 120° wide, fast enough to clear the row and rain back down.
    const a = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 2 / 3);
    const v = 380 + Math.random() * 520;
    return { x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, w: 5 + Math.random() * 4, h: 3 + Math.random() * 3,
      spin: (Math.random() - 0.5) * 14, turn: Math.random() * Math.PI, color: colors[i % colors.length] };
  });
  const t0 = performance.now();
  let last = t0;
  const frame = (now) => {
    const age = now - t0;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    if (age >= LIFE_MS) return canvas.remove();
    // The last third fades out, so nothing stops dead.
    ctx.globalAlpha = Math.min(1, (LIFE_MS - age) / (LIFE_MS / 3));
    for (const b of bits) {
      b.vy += GRAVITY * dt;
      b.vx *= 0.985;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.turn += b.spin * dt;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.turn);
      // A flat bit turning over: its height swings with the turn.
      ctx.scale(1, Math.cos(b.turn * 1.7));
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

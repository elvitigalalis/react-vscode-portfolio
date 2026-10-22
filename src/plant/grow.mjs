// Grows the hero's plant from a seed, as SVG text, at build time (no DOM, no client JS).
// A stem bends gently and splits into 1-3 shorter stems; leaves sprout along stems and at the
// tips. Each stem and leaf carries --t, the moment it grows, so CSS can draw the plant in the
// order it grew. The same seed always gives the same plant.

const W = 320, H = 380;
const GROUND = H - 8;
const LEAF = 26; // the longest a leaf grows
const STEP = 0.11; // seconds between generations: the whole plant is in by about 1.2 s

// FNV-1a: any seed string (a commit hash, a word) to a 32-bit integer.
function hash(seed) {
  let h = 0x811c9dc5;
  for (const c of String(seed)) h = Math.imul(h ^ c.codePointAt(0), 0x01000193);
  return h >>> 0;
}

// mulberry32: a small, fast PRNG with a 32-bit state.
function prng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// A point on the quadratic curve p0 -> p2 with control c, at t in [0, 1].
const quad = (p0, c, p2, t) => {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y };
};

// Curve length, from 8 straight pieces: plenty for a dash animation.
function curveLength(p0, c, p2) {
  let len = 0, prev = p0;
  for (let i = 1; i <= 8; i++) {
    const p = quad(p0, c, p2, i / 8);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

export function growPlant(seed) {
  const rand = prng(hash(seed));
  const between = (a, b) => a + (b - a) * rand();
  const stems = [], leaves = [];

  function leaf(x, y, angle, size, t) {
    leaves.push({ x, y, angle, L: size, w: size * between(0.28, 0.42), tone: 1 + Math.floor(rand() * 3), t });
  }

  function branch(p0, angle, len, width, depth, gen) {
    const bend = between(-0.35, 0.35);
    const p2 = { x: p0.x + Math.cos(angle) * len, y: p0.y + Math.sin(angle) * len };
    const c = { x: p0.x + Math.cos(angle + bend) * len * 0.55, y: p0.y + Math.sin(angle + bend) * len * 0.55 };
    stems.push({ p0, c, p2, width, t: gen * STEP });

    // Leaves along the stem, alternating sides; none on the thick lower trunk.
    const n = depth > 0 && depth < 4 ? Math.floor(between(1, 3)) : 0;
    for (let i = 0; i < n; i++) {
      const s = between(0.35, 0.9), at = quad(p0, c, p2, s), side = i % 2 ? 1 : -1;
      leaf(at.x, at.y, angle + side * between(0.7, 1.1), between(14, 24) * (1 - depth * 0.08), (gen + s) * STEP + 0.1);
    }
    // Past 48 stems a plant gets crowded (and heavy), so stems stop splitting and end in a leaf.
    if (depth >= 5 || len < 14 || stems.length >= 48) {
      leaf(p2.x, p2.y, angle + between(-0.2, 0.2), between(16, LEAF), (gen + 1) * STEP);
      return;
    }
    // The trunk and its first limbs always fork, so no plant comes out bare.
    const kids = depth < 2 ? 2 : rand() < 0.55 ? 2 : rand() < 0.85 ? 1 : 3;
    for (let k = 0; k < kids; k++) {
      const spread = kids === 1 ? between(-0.25, 0.25) : (k / (kids - 1) - 0.5) * between(0.7, 1.15);
      // A gentle pull back toward vertical keeps the plant upright.
      const next = angle + spread + (-Math.PI / 2 - angle) * 0.15;
      branch(p2, next, len * between(0.68, 0.86), Math.max(0.8, width * 0.7), depth + 1, gen + 1);
    }
  }

  branch({ x: W / 2, y: GROUND }, -Math.PI / 2 + between(-0.12, 0.12), between(70, 88), 4.2, 0, 0);

  // Fit the frame: shrink about the base until every stem point is inside it and every leaf base
  // has a full leaf's length of room, then slide sideways if one side still pokes out.
  const points = stems.flatMap((b) => [b.p0, b.c, b.p2]);
  const fitAt = (scale) => {
    const shrink = (p) => ({ x: W / 2 + (p.x - W / 2) * scale, y: GROUND + (p.y - GROUND) * scale });
    // How far the plant pokes past the left and right edges (negative: room to spare).
    const reach = [...points.map((p) => ({ x: shrink(p).x, room: 0 })), ...leaves.map((lf) => ({ x: shrink(lf).x, room: LEAF }))];
    const overLeft = Math.max(...reach.map((r) => r.room - r.x));
    const overRight = Math.max(...reach.map((r) => r.x + r.room - W));
    const fits = overLeft + overRight <= 0
      && points.every((p) => shrink(p).y >= 0)
      && leaves.every((lf) => shrink(lf).y >= LEAF && shrink(lf).y <= H - LEAF);
    if (!fits) return null;
    const dx = overLeft > 0 ? overLeft : overRight > 0 ? -overRight : 0;
    return { scale, place: (p) => ({ x: shrink(p).x + dx, y: shrink(p).y }) };
  };
  let frame = null;
  for (let scale = 1; !frame; scale *= 0.97) frame = fitAt(scale);

  const stemTags = stems.map(({ p0, c, p2, width, t }) => {
    const [a, b, e] = [p0, c, p2].map(frame.place);
    return `<path class="s" d="M${round1(a.x)} ${round1(a.y)}Q${round1(b.x)} ${round1(b.y)} ${round1(e.x)} ${round1(e.y)}" stroke-width="${round1(width * frame.scale)}" style="--l:${Math.ceil(curveLength(a, b, e))};--t:${round1(t * 100) / 100}s"/>`;
  });
  // A leaf: two curves from base to tip, drawn pointing right, then turned to its angle about the base.
  const leafTags = leaves.map((lf) => {
    const { x, y } = frame.place(lf), L = lf.L * frame.scale, w = lf.w * frame.scale;
    const d = `M0 0C${round1(L * 0.3)} ${round1(-w)} ${round1(L * 0.75)} ${round1(-w * 0.9)} ${round1(L)} 0C${round1(L * 0.75)} ${round1(w * 0.9)} ${round1(L * 0.3)} ${round1(w)} 0 0Z`;
    return `<path class="f f${lf.tone}" d="${d}" transform="translate(${round1(x)} ${round1(y)}) rotate(${Math.round(lf.angle * 180 / Math.PI)})" style="--t:${round1(lf.t * 100) / 100}s"/>`;
  });
  return `<svg class="plant" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false"><g class="stems">${stemTags.join("")}</g><g class="leaves">${leafTags.join("")}</g></svg>`;
}

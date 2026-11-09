// Checking something off on /plan (docs/sheet.md, "Completion"): the row shows done the moment
// it is clicked, while the save runs, and now and then a little more.
// - Every ✓: the check springs and draws itself, the title is struck left to right and settles
//   to the done look. A Someday row then fades out and the rows under it slide up (FLIP).
// - When it means something: a burst of eight specks from the check (shouldBurst) on the day's
//   first ✓, a task carried over three times or more, one a focus session finished inside its
//   estimate, or the third ✓ within ten minutes. Never by chance.
// - Big moments: a course assignment, or the last open task of today. Confetti for 1.2 s (its own
//   module, loaded only then) and a word in the Undo toast.
// - An optional soft tick (Settings, Day, "Completion sound"), off by default.
// Under prefers-reduced-motion only a 150 ms fade to the done look and the toast's words remain.
// The pure helpers on top are tested in test/celebrate.test.mjs; nothing here touches the page
// until a function is called, so planner.mjs stays importable in node.
import { localNow } from "./logic.mjs";

// --- Pure helpers ----------------------------------------------------------------------------

export const STREAK_MS = 10 * 60_000;
export const STUBBORN_ROLLS = 3;

// Whether this ✓ gets the small burst. `history` is the times (ms) of earlier ✓s this visit;
// `first`: nothing else is done today yet; `rolls`: how often the task was carried over;
// `early`: a focus session finished it before its estimate ran out.
export function shouldBurst(history, now, { first = false, rolls = 0, early = false } = {}) {
  const recent = history.filter((t) => now - t < STREAK_MS && t <= now).length;
  return recent + 1 >= 3 || first || rolls >= STUBBORN_ROLLS || early;
}

// No task was finished today yet (by done_at, on the owner's clock).
export const firstToday = (tasks, today, timeZone) =>
  ![...tasks].some((t) => t.done && t.done_at && localNow(new Date(t.done_at), timeZone).day === today);

// A focus session of `minutes` ended the task before its estimate ran out.
export const inside = (task, minutes) => minutes != null && task?.est_min > 0 && minutes < task.est_min;

// A course task from Brightspace: the assignments, quizzes and labs the feed brings in.
export const isAssignment = (task) => task?.source === "brightspace";

// Checking `id` off leaves nothing open on `today` (and it is one of today's tasks): the same
// test as the day's "all done" ✓ in planner.mjs, one task ahead.
export function isDayCleared(tasks, today, id) {
  const list = [...tasks].filter((t) => t.day === today);
  return list.some((t) => t.id === id && !t.done) && list.every((t) => t.id === id || t.done);
}

// The big moment a ✓ earns, if any: clearing the day outranks an assignment.
export function momentOf(task, tasks, today) {
  if (isDayCleared(tasks, today, task.id)) return "day";
  return isAssignment(task) ? "assignment" : null;
}
export const MOMENT_WORDS = { day: "Day cleared.", assignment: "Assignment done." };

// The burst's specks: evenly round the check with a little jitter, 18-36 px out.
export function specks(n, rand = Math.random) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI + (rand() - 0.5) * 0.6;
    const d = 18 + rand() * 18;
    return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, size: 4 + Math.round(rand() * 2), color: i % COLORS.length, ms: 480 + Math.round(rand() * 120) };
  });
}

// A redraw is never held for long: the row's animation counts for at most ANIM_MS and the whole
// ✓ (save included) for at most SAVE_MS. `capped` settles with the work's result, or LATE.
export const ANIM_MS = 1000;
export const SAVE_MS = 4000;
export const LATE = Symbol("late");
export const wait = (ms, value) => new Promise((r) => setTimeout(r, ms, value));
export const capped = (work, ms) => Promise.race([work, wait(ms, LATE)]);

// Runs `fn` for `key` unless a run for that key is still going (a double tap), so one ✓ saves
// once. True when it ran.
export async function once(busy, key, fn) {
  if (busy.has(key)) return false;
  busy.add(key);
  try { await fn(); return true; } finally { busy.delete(key); }
}

// The site's own greens and its amber (global.css), so it reads as part of the page.
export const COLORS = ["--accent", "--leaf-1", "--leaf-2", "--leaf-3", "--warn"];
export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

// --- On the page -------------------------------------------------------------------------------

export const calm = () => matchMedia("(prefers-reduced-motion: no-preference)").matches;
const done = (a) => a.finished.catch(() => {});

// The check's own mark, drawn as one stroke (pathLength 1, so no measuring): Lucide's check.
const SVG = "http://www.w3.org/2000/svg";
function mark() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "sheet-icon");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M20 6 9 17l-5-5");
  path.setAttribute("pathLength", "1");
  svg.append(path);
  return { svg, path };
}

// The old row, at click time: it looks done before the save ends. Resolves when it has settled
// (about 400 ms; 650 ms for a row that leaves). planner.mjs redraws only after this and the save.
export function playRow(li, { leave = false } = {}) {
  if (!calm()) {
    li.classList.add("is-done");
    return done(li.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 150, easing: "ease-out" }));
  }
  li.classList.add("is-checking");
  const check = li.querySelector(".sheet-check");
  const title = li.querySelector(".sheet-title");
  const runs = [];
  if (check) {
    const { svg, path } = mark();
    check.replaceChildren(svg);
    // A spring: up past full size, a little under, then still.
    runs.push(check.animate([{ transform: "scale(1)" }, { transform: "scale(1.18)", offset: 0.3 }, { transform: "scale(0.96)", offset: 0.65 }, { transform: "scale(1)" }],
      { duration: 350, easing: EASE_OUT }));
    runs.push(path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 250, delay: 40, easing: EASE_OUT, fill: "both" }));
  }
  if (title) {
    // The strike is a background line on an inline span, so it runs through a wrapped title line
    // by line, in reading order.
    const words = document.createElement("span");
    words.className = "sheet-strike";
    words.textContent = title.textContent;
    title.replaceChildren(words);
    runs.push(words.animate([{ backgroundSize: "0% 1px" }, { backgroundSize: "100% 1px" }], { duration: 250, delay: 60, easing: EASE_OUT, fill: "both" }));
  }
  const settled = Promise.all(runs.map(done));
  if (!leave) return settled;
  return settled.then(() => done(li.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(0.75rem)" }],
    { duration: 200, delay: 120, easing: EASE_OUT, fill: "forwards" })));
}

// Where each row of a list sits, by id, before the redraw; slide() eases the new rows from there.
export function places(list) {
  return new Map([...(list?.querySelectorAll("[data-id]") ?? [])].map((r) => [r.dataset.id, r.getBoundingClientRect().top]));
}
export function slide(before, rows) {
  if (!calm()) return;
  for (const r of rows) {
    const was = before.get(r.dataset.id);
    const dy = was == null ? 0 : was - r.getBoundingClientRect().top;
    if (Math.abs(dy) > 1) r.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 220, easing: EASE_OUT });
  }
}

// A small pop on something that just changed (the day's ✓, the Log's count).
export function pop(node) {
  if (!node || !calm()) return;
  node.animate([{ transform: "scale(1)" }, { transform: "scale(1.4)", offset: 0.35 }, { transform: "scale(1)" }], { duration: 320, easing: EASE_OUT });
}

// Effects that sit over the page, never in a row render() replaces: in the open dialog when there
// is one (a modal is in the top layer, above anything on <body>), else on <body>.
const hostOf = (from) => from?.closest?.("dialog[open]") ?? document.querySelector("dialog[open]") ?? document.body;
const centre = (from) => {
  const r = from instanceof Element ? from.getBoundingClientRect() : from;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// The small burst. `from` is an element or a rect taken before a redraw.
export function burst(from, host = hostOf(from)) {
  if (!from || !calm()) return;
  const { x, y } = centre(from);
  for (const s of specks(8)) {
    const p = document.createElement("i");
    p.className = "sheet-speck";
    p.setAttribute("aria-hidden", "true");
    p.style.cssText = `left:${x}px;top:${y}px;width:${s.size}px;height:${s.size}px;background:var(${COLORS[s.color]})`;
    host.append(p);
    p.animate([{ transform: "translate(-50%, -50%) scale(1)", opacity: 1 }, { transform: `translate(calc(-50% + ${s.dx}px), calc(-50% + ${s.dy}px)) scale(0.4)`, opacity: 0 }],
      { duration: s.ms, easing: EASE_OUT }).finished.finally(() => p.remove());
  }
}

// The big moment: confetti, loaded the first time it's needed.
export function confetti(from) {
  if (!from || !calm()) return;
  const at = centre(from);
  const host = hostOf(from);
  import("./confetti.mjs").then((m) => m.fling(at, host), console.error);
}

// --- Sound -------------------------------------------------------------------------------------

const SOUND_KEY = "sheet.sound";
export function soundOn() { try { return localStorage.getItem(SOUND_KEY) === "on"; } catch { return false; } }
export function setSound(on) { try { on ? localStorage.setItem(SOUND_KEY, "on") : localStorage.removeItem(SOUND_KEY); } catch {} }

// Two short rising sine notes, quiet; a three-note chord for a big moment. Web Audio follows the
// iPhone's silent switch. The context is made inside the click, as autoplay rules want.
let audio = null;
export function tick(big = false) {
  if (!soundOn()) return;
  try {
    audio ??= new AudioContext();
    // iOS suspends the context when the phone locks; each tick wakes it (inside the tap).
    if (audio.state !== "running") audio.resume().catch(() => {});
    const t0 = audio.currentTime;
    const notes = big ? [[523.25, 0], [659.25, 0.05], [783.99, 0.1]] : [[880, 0], [1318.5, 0.05]];
    for (const [f, at] of notes) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const t = t0 + at;
      const len = big ? 0.22 : 0.07;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(big ? 0.05 : 0.06, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + len + 0.01);
    }
  } catch (e) { console.error(e); }
}

// --- One ✓ ------------------------------------------------------------------------------------

const history = [];

// The extras of one ✓, at click time: confetti for a big moment, else the burst when it means
// something (`why`: shouldBurst's first, rolls, early), and the tick. `quiet` (a key press)
// keeps only the big moment: keys are for going fast.
export function cheer(from, { moment = null, quiet = false, why = {} } = {}) {
  const now = Date.now();
  const burstNow = shouldBurst(history, now, why);
  history.push(now);
  while (history.length && now - history[0] > STREAK_MS) history.shift();
  if (moment) { confetti(from); tick(true); return; }
  if (quiet) return;
  if (burstNow) burst(from);
  tick(false);
}

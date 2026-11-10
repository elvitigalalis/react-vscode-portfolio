// /plan/gym/ (docs/sheet-gym.md): today's session from the program, one card per exercise, sets
// saved on ✓ (to the phone first, gym-sync.mjs), the rest timer, PRs, records and the program
// editor. The decisions live in gym.mjs; this file draws and wires. Text goes in through
// textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { addDays, blockOnComplete, localNow, zonedIso } from "./logic.mjs";
import { lightDismiss } from "./dismiss.mjs";
import { loadAll, send } from "./gym-api.mjs";
import { GYM_HABIT, ringLine } from "./ring.mjs";
import { habitDay } from "./habit-rate.mjs";
import { keyOf, outbox } from "./gym-sync.mjs";
import {
  activeExercise, e1rm, historyFor, nextDay, ordered, parseSlot, plateText, prsFor, range, readNum, records, rxLine, setToSave, strip, suggest, warmups,
} from "./gym.mjs";

const CACHE = "sheet.gym.cache";
const DRAFT = "sheet.gym.draft";
const OPEN_FOR_MS = 6 * 3600e3; // an unfinished session older than this has ended
const RPES = [6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10];
const store = (() => { try { return localStorage; } catch { return { getItem: () => null, setItem() {}, removeItem() {} }; } })();
const readJson = (k) => { try { return JSON.parse(store.getItem(k)); } catch { return null; } };
const writeJson = (k, v) => { try { store.setItem(k, JSON.stringify(v)); } catch {} };
const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const box = outbox(store);
let root;
const $ = (sel) => root.querySelector(sel);
// D: the rows, as the server has them plus every write made here since.
let D = { exercises: [], days: [], rxs: [], baselines: [], swaps: [], sessions: [], sets: [] };
// Oura: the ring's workouts of the last week, length only ("Ring: 1h 12m" on today's session).
let ring = [];
const TABLE = { gym_exercises: "exercises", gym_program_days: "days", gym_prescriptions: "rxs", gym_baselines: "baselines", gym_swaps: "swaps", gym_sessions: "sessions", gym_sets: "sets" };
const S = { view: "today", dayId: null, session: null, extra: {}, removed: {}, rpeFor: null, recordsFor: null, draft: readJson(DRAFT) ?? {} };

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null && k !== false));
  return node;
};
const btn = (text, props = {}) => el("button", { type: "button", textContent: text, ...props });
const byId = (list, id) => list.find((x) => x.id === id);
const exName = (id) => byId(D.exercises, id)?.name ?? "Exercise";
const dayKeys = () => Object.fromEntries(D.days.map((d) => [d.id, d.day_key]));
const dayLabel = (d) => (d ? `Week ${d.week} · ${d.name}` : "");
const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: SHEET.timeZone });
const lb = (w) => (w == null ? "—" : String(Math.round(w * 100) / 100));

// --- Local writes ------------------------------------------------------------------------------

let cacheTimer;
function remember() { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => writeJson(CACHE, D), 300); }
function applyRow(table, row) {
  const key = keyOf(table);
  const list = D[TABLE[table]];
  const i = list.findIndex((r) => r[key] === row[key]);
  if (i < 0) list.push(row); else list[i] = row;
}
// Save a row: into D at once, into the outbox, then to Supabase when it can.
function put(table, row) { applyRow(table, row); box.put(table, row); remember(); sync(); }
function drop(table, id) {
  const key = keyOf(table);
  D[TABLE[table]] = D[TABLE[table]].filter((r) => r[key] !== id);
  box.drop(table, id); remember(); sync();
}

let syncFailed = false;
async function sync() {
  if (!box.pending()) return note();
  syncFailed = !(await box.flush(send));
  note();
}
// The status line says where his sets are: "Saved on phone · will sync" while writes wait (offline,
// a failed send, or a send taking over 2 s), then "Saved" for 3 s once they all went up.
let queuedShown = false;
let queuedTimer = null;
let savedUntil = 0;
function note() {
  const n = $("[data-gym-offline]");
  if (!n) return;
  const show = (text) => { n.textContent = text; n.hidden = false; };
  if (box.pending()) {
    savedUntil = 0;
    if (syncFailed || !navigator.onLine) { queuedShown = true; show("Saved on phone · will sync"); }
    else if (!queuedShown && !queuedTimer) queuedTimer = setTimeout(() => { queuedTimer = null; if (box.pending()) { queuedShown = true; show("Saved on phone · will sync"); } }, 2000);
    return;
  }
  clearTimeout(queuedTimer);
  queuedTimer = null;
  if (queuedShown) {
    queuedShown = false;
    savedUntil = Date.now() + 3000;
    show("Saved");
    setTimeout(note, 3100);
  } else if (Date.now() >= savedUntil) n.hidden = true;
}

// --- Loading -----------------------------------------------------------------------------------

async function load() {
  try {
    [D, ring] = await Promise.all([loadAll(), api.listRingWorkouts(addDays(localNow(new Date(), SHEET.timeZone).day, -7))]);
    writeJson(CACHE, D);
  } catch (e) {
    const cached = readJson(CACHE);
    if (!cached) throw e;
    D = cached;
  }
  // Writes still on the phone are part of what's drawn.
  for (const table of Object.keys(TABLE)) {
    for (const row of box.rows(table)) applyRow(table, row);
    const gone = new Set(box.dropped(table));
    D[TABLE[table]] = D[TABLE[table]].filter((r) => !gone.has(r[keyOf(table)]));
  }
  // A session left open: resumed if recent, else ended at its last set.
  for (const s of D.sessions.filter((x) => !x.finished_at)) {
    if (Date.now() - new Date(s.started_at) < OPEN_FOR_MS) { S.session = s; continue; }
    const last = D.sets.filter((x) => x.session_id === s.id).map((x) => x.done_at).sort().at(-1);
    if (last) put("gym_sessions", { ...s, finished_at: last });
  }
  S.dayId = S.session?.program_day_id ?? nextDay(D.days, D.sessions);
}

// --- Session, wake lock, sound -------------------------------------------------------------------

let lock = null;
let audio = null;
async function wake() {
  if (!S.session || document.visibilityState !== "visible" || lock) return;
  try { lock = await navigator.wakeLock?.request("screen"); lock?.addEventListener("release", () => { lock = null; }); } catch { lock = null; }
}
function ensureSession() {
  if (!S.session) {
    S.session = { id: uuid(), program_day_id: S.dayId, started_at: nowIso(), finished_at: null };
    put("gym_sessions", S.session);
  }
  // A tap is a user gesture: iOS lets audio start and the wake lock be taken from one.
  try { audio ??= new AudioContext(); audio.resume(); } catch {}
  wake();
  return S.session;
}
function beep() {
  if (!audio) return;
  try {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.25, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.3);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.3);
  } catch {}
}

// --- Rest timer ----------------------------------------------------------------------------------

// The end is a timestamp, so a locked phone or a throttled tab never loses time.
let rest = null;
const mmss = (ms) => { const s = Math.round(Math.abs(ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function startRest(seconds) {
  rest = { endsAt: Date.now() + seconds * 1000, rang: false };
  say(`Rest ${mmss(seconds * 1000)}`);
  tick();
}
function tick() {
  const bar = $("[data-gym-rest]");
  bar.hidden = !rest;
  document.body.classList.toggle("gym-resting", Boolean(rest));
  if (!rest) return;
  const left = rest.endsAt - Date.now();
  $("[data-gym-rest-time]").textContent = left > 0 ? mmss(left) : `+${mmss(left)}`;
  bar.classList.toggle("is-over", left <= 0);
  if (left <= 0 && !rest.rang) {
    rest.rang = true;
    beep();
    say("Rest over");
    document.body.classList.add("gym-flash");
    setTimeout(() => document.body.classList.remove("gym-flash"), 700);
  }
}
const say = (text) => { const live = $("[data-gym-live]"); live.textContent = ""; setTimeout(() => { live.textContent = text; }, 50); };

// --- Toasts: Undo and the PR banner ----------------------------------------------------------------

let undoTimer;
function offerUndo(text, undo) {
  const t = $("[data-gym-toast]");
  $("[data-gym-toast-text]").textContent = text;
  t.hidden = false;
  t.querySelector("button").onclick = () => { undo(); t.hidden = true; render(); };
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { t.hidden = true; }, 5000);
}
const PR_WORDS = {
  e1rm: (p) => `e1RM PR: ${lb(p.value)} lb (+${lb(Math.round((p.value - p.was) * 10) / 10)})`,
  weight: (p) => `Heaviest yet: ${lb(p.weight_lb)} lb`,
  reps: (p) => `Rep PR: ${p.reps} at ${lb(p.weight_lb)} lb`,
};
let prTimer;
// Shown at the top and read out through the live region (the banner itself is aria-hidden).
function banner(name, pr) {
  const b = $("[data-gym-pr]");
  b.textContent = `${name}: ${PR_WORDS[pr.type](pr)}`;
  b.hidden = false;
  say(b.textContent);
  clearTimeout(prTimer);
  prTimer = setTimeout(() => { b.hidden = true; }, 4000);
}

// --- Today -----------------------------------------------------------------------------------------

const rxsOf = (dayId) => D.rxs.filter((r) => r.program_day_id === dayId).sort((a, b) => a.position - b.position);
const slotOf = (rxId) => { const r = byId(D.rxs, rxId); return r && `${dayKeys()[r.program_day_id]}|${r.position}|${r.exercise_id}`; };
const baselineOf = (exId) => D.baselines.find((b) => b.exercise_id === exId) ?? null;

// The values shown in a row: the logged set's, else what he typed, else the prefill.
function rowValues(key, logged, prefill) {
  if (logged) return { weight_lb: Number(logged.weight_lb), reps: logged.reps };
  return { ...prefill, ...S.draft[key] };
}
// A blank field (null) leaves the draft, so the row shows its prefill again.
function setDraft(key, patch) {
  const next = { ...S.draft[key], ...patch };
  for (const k of Object.keys(next)) if (next[k] == null) delete next[k];
  S.draft[key] = next;
  writeJson(DRAFT, S.draft);
}

// onSet(value, redraw): a typed value is kept without redrawing, since the change event fires as
// the field blurs, on the very press of ✓, and a redraw then would swallow that tap.
function stepper(id, label, unit, value, step, onSet, numeric) {
  const input = el("input", {
    id, type: "text", inputMode: numeric ? "numeric" : "decimal", enterKeyHint: "done", autocomplete: "off",
    className: "gym-num", value: value == null ? "" : lb(value), ariaLabel: label,
  });
  input.addEventListener("change", () => onSet(readNum(input.value, numeric), false));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { input.blur(); render(); } });
  const minus = btn("−", { id: `${id}-m`, className: "gym-step", ariaLabel: `${label}: ${step} less` });
  const plus = btn("+", { id: `${id}-p`, className: "gym-step", ariaLabel: `${label}: ${step} more` });
  const now = () => readNum(input.value, numeric) ?? value ?? 0;
  minus.addEventListener("click", () => onSet(Math.max(0, now() - step), true));
  plus.addEventListener("click", () => onSet(now() + step, true));
  return el("span", { className: "gym-stepper" }, minus, el("span", { className: "gym-num-wrap" }, input, el("span", { className: "gym-unit", textContent: unit, ariaHidden: "true" })), plus);
}

function card(rx, dayKey) {
  const exId = activeExercise(rx, D.swaps, slotOf, S.session?.id);
  const ex = byId(D.exercises, exId) ?? { id: exId, step_lb: 5 };
  const history = historyFor(exId, D.sessions, D.sets, dayKeys(), S.session?.id);
  const baseline = baselineOf(exId);
  const sug = suggest(rx, ex, history, { dayKey, now: new Date(), baseline });
  const last = history.find((h) => h.day_key === dayKey) ?? history[0];
  const logged = D.sets.filter((s) => S.session && s.session_id === S.session.id && s.prescription_id === rx.id);
  const work = sug.weight_lb ?? (last ? Math.max(...last.sets.map((s) => Number(s.weight_lb))) : baseline?.weight_lb ?? null);
  const name = ex.name ?? "Exercise";

  const swap = btn("⇄", { className: "gym-icon-btn", ariaLabel: `Swap ${name}`, title: "Swap" });
  swap.addEventListener("click", () => openSwap(rx, exId));
  const head = el("h2", { className: "gym-name" }, el("span", { textContent: name }), exId !== rx.exercise_id ? el("span", { className: "gym-tag", textContent: "swapped" }) : null, swap);
  const lastLine = last
    ? `Last: ${last.sets.map((s) => `${lb(s.weight_lb)}×${s.reps}${s.rpe ? ` @${s.rpe}` : ""}`).join(", ")} · ${fmtDate(last.started_at)}`
    : "No sets yet";

  const rows = [];
  const wu = warmups(rx, work, ex);
  const n = rx.working_sets + (S.extra[rx.id] ?? 0);
  const specs = [...wu.map((w, i) => ({ warmup: true, index: i, prefill: w, label: "W" })),
    ...Array.from({ length: n }, (_, i) => ({ warmup: false, index: i + 1, prefill: { weight_lb: work, reps: sug.reps ?? rx.rep_min ?? 8 }, label: String(i + 1) }))];
  for (const spec of specs) {
    const done = logged.find((s) => s.warmup === spec.warmup && s.set_index === spec.index);
    const key = `${rx.id}|${spec.warmup ? "w" : "s"}${spec.index}`;
    if (!done && S.removed[key]) continue;
    const v = rowValues(key, done, spec.prefill);
    const id = key.replace(/[^a-z0-9]/gi, "");
    const what = `${spec.warmup ? "warm-up" : "set"} ${spec.warmup ? spec.index + 1 : spec.index}`;
    const change = (patch, redraw) => {
      // A logged set keeps its numbers when a field is cleared.
      if (done) { if (Object.values(patch).every((x) => x != null)) put("gym_sets", { ...done, ...patch }); }
      else setDraft(key, patch);
      if (redraw) render();
    };
    const prev = spec.warmup ? null : last?.sets[spec.index - 1];
    const check = btn("✓", { id: `${id}-ok`, className: `gym-check${done ? " is-done" : ""}`, ariaLabel: `${done ? "Saved" : "Save"} ${what} of ${name}` });
    check.setAttribute("aria-pressed", String(Boolean(done)));
    // ✓ saves what the fields hold right now, typed or not, in the one tap.
    check.addEventListener("click", () => {
      const [w, r] = row.querySelectorAll(".gym-num");
      const typed = { weight_lb: readNum(w.value), reps: readNum(r.value, true) };
      const values = setToSave(typed, done ? { weight_lb: Number(done.weight_lb), reps: done.reps } : spec.prefill, Boolean(ex.bodyweight));
      if (values.error) return askFor(row, values.error, values.error === "weight" ? w : r);
      logSet({ rx, exId, name, spec, done, values });
    });
    // ✕ drops a planned row, or deletes a logged set; either way with Undo for 5 s.
    const x = btn("✕", { id: `${id}-x`, className: "gym-x", ariaLabel: `${done ? "Delete" : "Remove"} ${what} of ${name}`, title: done ? "Delete set" : "Remove set" });
    x.addEventListener("click", () => removeSet(key, done, what));
    const row = el("div", { className: `gym-set${spec.warmup ? " is-warmup" : ""}${done ? " is-done" : ""}` },
      el("span", { className: "gym-set-n", textContent: spec.label, title: spec.warmup ? "Warm-up: never counted" : "" }),
      el("span", { className: "gym-set-last", textContent: prev ? `${lb(prev.weight_lb)}×${prev.reps}` : "—", ariaLabel: prev ? `Last time ${lb(prev.weight_lb)} by ${prev.reps}` : "No last time" }),
      x, check,
      el("span", { className: "gym-set-inputs" },
        stepper(`${id}-w`, `Weight, ${what}, lb`, "lb", v.weight_lb, Number(ex.step_lb) || 5, (x, redraw) => change({ weight_lb: x }, redraw)),
        stepper(`${id}-r`, `Reps, ${what}`, "reps", v.reps, 1, (x, redraw) => change({ reps: x == null ? x : Math.round(x) }, redraw), true)));
    rows.push(row);
    if (done && S.rpeFor === done.id) rows.push(rpeChips(done, rx));
    if (ex.bar_lb && !spec.warmup && spec.index === 1 && v.weight_lb) rows.push(el("p", { className: "gym-plates", textContent: plateText(v.weight_lb, Number(ex.bar_lb)) }));
  }
  const more = btn("+ Set", { className: "sheet-link gym-more", ariaLabel: `Add a set of ${name}` });
  more.addEventListener("click", () => { S.extra[rx.id] = (S.extra[rx.id] ?? 0) + 1; render(); });

  return el("article", { className: "gym-card", ariaLabel: name },
    head,
    el("p", { className: "gym-rx", textContent: rxLine(rx) }),
    el("p", { className: "gym-last", textContent: lastLine }),
    el("p", { className: "gym-suggest" }, sug.weight_lb != null ? el("strong", { textContent: `Today: ${lb(sug.weight_lb)} × ${sug.reps}` }) : null, el("span", { textContent: sug.reason })),
    sparkline(exId),
    el("div", { className: "gym-sets", role: "group", ariaLabel: `Sets of ${name}` },
      el("div", { className: "gym-set gym-set-head", ariaHidden: "true" }, ...["Set", "Last", "✓", "lb · Reps"].map((t) => el("span", { textContent: t }))), ...rows),
    more);
}

// Removing a row: a planned one is hidden for this session; a logged one is deleted (by id, from the
// outbox or the server), and records, PRs and the summary are worked out again from the sets left.
function removeSet(key, done, what) {
  if (done) {
    drop("gym_sets", done.id);
    if (S.rpeFor === done.id) S.rpeFor = null;
    offerUndo(`Deleted ${what}: ${lb(done.weight_lb)} × ${done.reps}`, () => put("gym_sets", done));
  } else {
    S.removed[key] = true;
    offerUndo(`Removed ${what}`, () => { delete S.removed[key]; });
  }
  render();
}

// A row with nothing to save says so under its fields and focuses the one to fill.
function askFor(row, what, input) {
  let p = row.querySelector(".gym-set-err");
  if (!p) row.append(p = el("p", { className: "gym-set-err", role: "alert" }));
  p.textContent = what === "weight" ? "Enter a weight first (0 only for a bodyweight exercise)." : "Enter the reps first.";
  input.setAttribute("aria-invalid", "true");
  input.focus();
}

function rpeChips(set, rx) {
  const chips = RPES.map((r) => {
    const b = btn(String(r), { className: "gym-chip", ariaLabel: `RPE ${r}` });
    b.setAttribute("aria-pressed", String(Number(set.rpe) === r));
    b.addEventListener("click", () => { put("gym_sets", { ...set, rpe: r }); S.rpeFor = null; render(); });
    return b;
  });
  return el("div", { className: "gym-rpe", role: "group", ariaLabel: `RPE for that set${rx.rpe ? `, target ${range(rx.rpe)}` : ""}` }, ...chips);
}

// ✓: saved to the phone at once, Undo for 5 s, the rest timer, and the best PR it set.
function logSet({ rx, exId, name, spec, done, values }) {
  const session = ensureSession();
  const row = {
    id: done?.id ?? uuid(), session_id: session.id, prescription_id: rx.id, exercise_id: exId, set_index: spec.index, warmup: spec.warmup,
    weight_lb: values.weight_lb, reps: values.reps, rpe: done?.rpe ?? (spec.warmup ? null : rx.rpe_target ?? null), done_at: done?.done_at ?? nowIso(),
  };
  const prs = prsFor(row, D.sets.filter((s) => s.id !== row.id), D.baselines);
  put("gym_sets", row, { fresh: !done });
  delete S.draft[`${rx.id}|${spec.warmup ? "w" : "s"}${spec.index}`];
  writeJson(DRAFT, S.draft);
  if (!done) {
    startRest(spec.warmup ? 60 : rx.rest_min_s ?? 120);
    S.rpeFor = spec.warmup ? null : row.id;
    offerUndo(`Logged ${lb(row.weight_lb)} × ${row.reps}`, () => drop("gym_sets", row.id));
  }
  if (prs.length) banner(name, prs[0]);
  render();
}

// Best e1RM per session, the last 10, as a small line.
function sparkline(exId) {
  const best = historyFor(exId, D.sessions, D.sets, dayKeys()).slice(0, 10).reverse()
    .map((h) => Math.max(...h.sets.map((s) => (s.reps <= 12 ? e1rm(Number(s.weight_lb), s.reps)?.value ?? 0 : 0))))
    .filter((v) => v > 0);
  if (best.length < 2) return null;
  const lo = Math.min(...best);
  const hi = Math.max(...best);
  const pts = best.map((v, i) => `${(i / (best.length - 1)) * 96},${22 - ((v - lo) / (hi - lo || 1)) * 20}`).join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "gym-spark");
  svg.setAttribute("viewBox", "-2 0 100 24");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `e1RM over the last ${best.length} sessions: ${lb(best[0])} to ${lb(best.at(-1))} lb`);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.setAttribute("points", pts);
  svg.append(line);
  return svg;
}

// Today's ring time, matched to today's session (or any lifting workout today), or nothing.
function ringToday() {
  const today = localNow(new Date(), SHEET.timeZone).day;
  const session = [...D.sessions].reverse().find((x) => localNow(new Date(x.started_at), SHEET.timeZone).day === today) ?? null;
  const line = ringLine(ring, today, session);
  return line ? el("p", { className: "gym-last", textContent: line }) : null;
}

function drawToday(main) {
  const day = byId(D.days, S.dayId);
  if (!day) { main.append(el("p", { className: "sheet-status", textContent: "No program yet. Run tools/gym-seed.mjs (docs/sheet-gym.md)." })); return; }
  const loggedAny = S.session && D.sets.some((s) => s.session_id === S.session.id);
  const pick = el("select", { id: "gym-day", className: "gym-select", disabled: Boolean(loggedAny) },
    ...ordered(D.days).map((d) => el("option", { value: d.id, textContent: dayLabel(d), selected: d.id === S.dayId })));
  pick.addEventListener("change", () => {
    S.dayId = pick.value;
    if (S.session) put("gym_sessions", { ...S.session, program_day_id: S.dayId });
    render();
  });
  const rows = strip(D.days, D.sessions, S.dayId);
  const states = { done: "done", today: "today", next: "next" };
  main.append(
    el("p", { className: "gym-day", textContent: dayLabel(day) }),
    ringToday(),
    el("div", { className: "gym-strip", role: "img", ariaLabel: `Program progress: ${rows.flat().filter((d) => d.state === "done").length} of ${rows.flat().length} done this pass` },
      ...rows.map((week) => el("div", { className: "gym-strip-week" }, ...week.map((d) => el("span", { className: `gym-dot${d.state ? ` is-${states[d.state]}` : ""}`, title: dayLabel(d) }))))),
    el("p", { className: "gym-pick" }, el("label", { htmlFor: "gym-day", textContent: loggedAny ? "Today's day (sets logged)" : "Another day" }), pick),
    ...rxsOf(day.id).map((rx) => card(rx, day.day_key)));
  if (S.session) {
    const finish = btn("Finish workout", { className: "sheet-btn primary gym-finish" });
    finish.addEventListener("click", finishSession);
    main.append(finish);
  }
}

// --- Finish ----------------------------------------------------------------------------------------

async function finishSession() {
  const s = { ...S.session, finished_at: nowIso() };
  put("gym_sessions", s);
  const mine = D.sets.filter((x) => x.session_id === s.id && !x.warmup).sort((a, b) => a.done_at.localeCompare(b.done_at));
  const prs = [];
  for (const x of mine) {
    const p = prsFor(x, D.sets.filter((o) => o.done_at < x.done_at && o.id !== x.id), D.baselines)[0];
    if (p) prs.push(`${exName(x.exercise_id)}: ${PR_WORDS[p.type](p)}`);
  }
  const minutes = Math.round((new Date(s.finished_at) - new Date(s.started_at)) / 60000);
  const volume = mine.reduce((a, x) => a + Number(x.weight_lb) * x.reps, 0);
  S.session = null;
  rest = null;
  tick();
  try { await lock?.release(); } catch {}
  lock = null;
  S.dayId = nextDay(D.days, D.sessions);
  S.extra = {};
  S.removed = {};
  const dlg = $("[data-gym-summary]");
  dlg.replaceChildren(
    el("h2", { id: "gym-summary-title", textContent: "Workout done" }),
    el("p", { textContent: `${mine.length} set${mine.length === 1 ? "" : "s"} · ${Math.round(volume).toLocaleString("en-US")} lb · ${minutes} min` }),
    prs.length ? el("ul", { className: "gym-prs" }, ...prs.map((t) => el("li", { textContent: t }))) : el("p", { className: "small", textContent: "No PRs this time." }),
    el("p", { className: "sheet-dialog-end" }, btn("Stay here", { className: "sheet-btn", onclick: () => dlg.close() }), el("a", { className: "sheet-btn primary", href: "/plan/", textContent: "Back to /plan" })));
  dlg.showModal();
  render();
  markHabit();
}

// A Gym habit block today goes the way a done task's block does (blockOnComplete in logic.mjs):
// it ends now if it's under way, or is dropped if it hadn't started. The Gym habit is ticked for
// the habit day too (habit_done, docs/sheet-habits.md), block or not.
async function markHabit() {
  try {
    const day = habitDay(new Date(), SHEET.timeZone);
    const habits = await api.listHabits();
    await Promise.all(habits.filter((h) => GYM_HABIT.test(h.name ?? "")).map((h) => api.markHabitDone(h.id, day)));
  } catch (e) { console.error(e); }
  try {
    const tz = SHEET.timeZone;
    const today = localNow(new Date(), tz).day;
    const blocks = await api.listBlocks(zonedIso(today, 0, tz), zonedIso(addDays(today, 1), 0, tz));
    const b = blocks.find((x) => x.habit_id && !x.proposed && /\b(gym|lift|workout)/i.test(x.habit?.name ?? ""));
    if (!b) return;
    const r = blockOnComplete(b, new Date());
    if (r.action === "shrink") await api.updateBlock(b.id, { ends_at: r.ends_at });
    if (r.action === "delete") await api.deleteBlock(b.id);
  } catch (e) { console.error(e); }
}

// --- Swap ------------------------------------------------------------------------------------------

function openSwap(rx, current) {
  const dlg = $("[data-gym-swap]");
  const choices = [[rx.exercise_id, "Original"], [rx.sub1_exercise_id, "Substitute"], [rx.sub2_exercise_id, "Substitute"]].filter(([id]) => id);
  const radio = (id, tag) => el("label", { className: "gym-radio" },
    el("input", { type: "radio", name: "gym-swap-to", value: id, checked: id === current }), ` ${exName(id)} `, el("span", { className: "gym-tag", textContent: tag }));
  const other = el("select", { id: "gym-swap-any", className: "gym-select" }, el("option", { value: "", textContent: "Any exercise…" }),
    ...[...D.exercises].sort((a, b) => a.name.localeCompare(b.name)).map((e) => el("option", { value: e.id, textContent: e.name })));
  const fresh = el("input", { id: "gym-swap-new", type: "text", className: "gym-text", maxLength: 80, autocomplete: "off", placeholder: "Or a new one: name" });
  const scope = (v, t, on) => el("label", { className: "gym-radio" }, el("input", { type: "radio", name: "gym-swap-scope", value: v, checked: on }), ` ${t}`);
  const go = btn("Swap", { className: "sheet-btn primary" });
  go.addEventListener("click", () => {
    let to = fresh.value.trim() ? null : other.value || dlg.querySelector('[name="gym-swap-to"]:checked')?.value;
    const name = fresh.value.trim();
    if (name) {
      const found = D.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
      if (found) to = found.id;
      else { const ex = { id: uuid(), name, group: null, unit: "lb", step_lb: 5, bar_lb: null }; put("gym_exercises", ex); to = ex.id; }
    }
    if (!to) return dlg.close();
    const today = dlg.querySelector('[name="gym-swap-scope"]:checked').value === "today";
    put("gym_swaps", {
      id: uuid(), program_day_id: today ? S.dayId : null, prescription_id: rx.id, exercise_id: to,
      scope: today ? "today" : "phase", session_id: today ? ensureSession().id : null, created_at: nowIso(),
    });
    dlg.close();
    render();
  });
  dlg.replaceChildren(
    el("h2", { id: "gym-swap-title", textContent: `Swap ${exName(current)}` }),
    el("fieldset", { className: "gym-fieldset" }, el("legend", { textContent: "Do instead" }), ...choices.map(([id, tag]) => radio(id, tag))),
    el("p", {}, el("label", { className: "visually-hidden", htmlFor: "gym-swap-any", textContent: "Any exercise" }), other),
    el("p", {}, el("label", { className: "visually-hidden", htmlFor: "gym-swap-new", textContent: "A new exercise's name" }), fresh),
    el("fieldset", { className: "gym-fieldset" }, el("legend", { textContent: "For" }), scope("today", "Today only", true), scope("phase", "Rest of phase", false)),
    el("p", { className: "small", textContent: "Records stay with the exercise you actually do." }),
    el("p", { className: "sheet-dialog-end" }, btn("Cancel", { className: "sheet-btn", onclick: () => dlg.close() }), go));
  dlg.showModal();
}

// --- Records ---------------------------------------------------------------------------------------

function drawRecords(main) {
  const recs = records(D.sets, D.baselines);
  const ids = [...new Set([...D.sets.map((s) => s.exercise_id), ...D.baselines.map((b) => b.exercise_id)])]
    .filter((id) => byId(D.exercises, id)).sort((a, b) => exName(a).localeCompare(exName(b)));
  if (!ids.length) { main.append(el("p", { className: "sheet-status", textContent: "No records yet: they start with your first logged set." })); return; }
  S.recordsFor = ids.includes(S.recordsFor) ? S.recordsFor : ids[0];
  const pick = el("select", { id: "gym-rec", className: "gym-select" }, ...ids.map((id) => el("option", { value: id, textContent: exName(id), selected: id === S.recordsFor })));
  pick.addEventListener("change", () => { S.recordsFor = pick.value; render(); });
  main.append(el("p", { className: "gym-pick" }, el("label", { htmlFor: "gym-rec", textContent: "Exercise" }), pick));
  const id = S.recordsFor;
  const r = recs.get(id);
  const b = baselineOf(id);
  if (b && b.weight_lb != null) {
    const confirm = b.confirmed ? null : btn("Confirm", { className: "sheet-link", ariaLabel: `Confirm ${lb(b.weight_lb)} lb from your sheet as a record` });
    confirm?.addEventListener("click", () => { put("gym_baselines", { ...b, confirmed: true }); render(); });
    main.append(el("p", { className: "gym-last" }, `From your sheet: ${lb(b.weight_lb)} lb${b.reps ? ` × ${b.reps}` : ""}${b.confirmed ? " (confirmed)" : " (not counted until you confirm it)"}${b.note ? `. ${b.note}` : ""} `, confirm));
  }
  if (r) {
    const est = r.e1rm && e1rm(Number(r.e1rm.set.weight_lb), r.e1rm.set.reps);
    main.append(el("p", { className: "gym-suggest" },
      el("strong", { textContent: r.e1rm ? `e1RM ${est.approx ? "~" : ""}${lb(r.e1rm.value)} lb` : "No e1RM yet" }),
      el("span", { textContent: r.heaviest ? `Heaviest ${lb(r.heaviest.weight_lb)} lb` : "" })));
    main.append(el("table", { className: "gym-table" },
      el("caption", { className: "visually-hidden", textContent: `Best weight at each rep count for ${exName(id)}; faded ones were beaten by a heavier set for more reps` }),
      el("thead", {}, el("tr", {}, ...["Reps", "Best", "When"].map((t) => el("th", { scope: "col", textContent: t })))),
      el("tbody", {}, ...r.byReps.map((x) => el("tr", { className: x.beaten ? "is-beaten" : "" },
        el("td", { textContent: String(x.reps) }), el("td", { textContent: `${lb(x.weight_lb)} lb` }),
        el("td", { textContent: x.set.sheet ? "Sheet" : fmtDate(x.set.done_at) }))))));
  }
  const days = Object.fromEntries(D.days.map((d) => [d.id, d]));
  const hist = historyFor(id, D.sessions, D.sets, dayKeys());
  main.append(el("h2", { className: "gym-h2", textContent: "History" }),
    el("ul", { className: "gym-history" }, ...hist.map((h) => el("li", {},
      el("span", { className: "gym-last", textContent: `${fmtDate(h.started_at)} · ${dayLabel(days[D.sessions.find((x) => x.id === h.id)?.program_day_id]) || "—"}` }),
      ` ${h.sets.map((s) => `${lb(s.weight_lb)}×${s.reps}`).join(", ")}`))));
}

// --- Editing the program ------------------------------------------------------------------------------

// An edit to a slot applies to the same day in every week where that slot holds the same exercise.
const twins = (rx) => {
  const key = dayKeys()[rx.program_day_id];
  return D.rxs.filter((r) => dayKeys()[r.program_day_id] === key && r.position === rx.position && r.exercise_id === rx.exercise_id);
};
// "in every week" only when the program has more than one week.
const everyWeek = () => (new Set(D.days.map((d) => d.week)).size > 1 ? " in every week" : "");
const editRx = (rx, patch) => { for (const r of twins(rx)) put("gym_prescriptions", { ...r, ...patch }); render(); };

function drawEdit(main) {
  const day = byId(D.days, S.dayId);
  if (S.session) { main.append(el("p", { className: "sheet-status", textContent: "Finish today's workout to edit the program: changes apply from the next session." })); return; }
  if (!day) return;
  main.append(el("p", { className: "gym-day", textContent: new Set(D.days.map((d) => d.week)).size > 1 ? `${day.name}, every week` : dayLabel(day) }),
    el("p", { className: "small", textContent: "Changes apply from the next session. Logged sets keep their exercise." }));
  const list = rxsOf(day.id);
  const field = (id, label, value, onChange, props = {}) => {
    const input = el("input", { id, type: "text", className: "gym-text", value: value ?? "", autocomplete: "off", ...props });
    input.addEventListener("change", () => onChange(input.value.trim()));
    return el("label", { className: "gym-field", htmlFor: id }, el("span", { textContent: label }), input);
  };
  list.forEach((rx, i) => {
    const ex = byId(D.exercises, rx.exercise_id);
    const id = `e${rx.id.slice(0, 8)}`;
    const move = (dir) => {
      const other = list[i + dir];
      if (!other) return;
      const a = twins(rx);
      const b = twins(other);
      for (const r of a) put("gym_prescriptions", { ...r, position: other.position });
      for (const r of b) put("gym_prescriptions", { ...r, position: rx.position });
      render();
    };
    const replace = el("select", { id: `${id}-x`, className: "gym-select", ariaLabel: `Replace ${ex?.name ?? "this exercise"} with` }, el("option", { value: "", textContent: "Replace with…" }),
      ...[...D.exercises].sort((a, b) => a.name.localeCompare(b.name)).filter((e) => e.id !== rx.exercise_id).map((e) => el("option", { value: e.id, textContent: e.name })));
    replace.addEventListener("change", () => replace.value && editRx(rx, { exercise_id: replace.value }));
    const up = btn("↑", { className: "gym-icon-btn", ariaLabel: `Move ${ex?.name} up`, disabled: i === 0 });
    const down = btn("↓", { className: "gym-icon-btn", ariaLabel: `Move ${ex?.name} down`, disabled: i === list.length - 1 });
    const remove = btn("Remove", { className: "sheet-link", ariaLabel: `Remove ${ex?.name} from ${day.name}` });
    up.addEventListener("click", () => move(-1));
    down.addEventListener("click", () => move(1));
    remove.addEventListener("click", () => { if (confirm(`Remove ${ex?.name} from ${day.name}${everyWeek()}?`)) { for (const r of twins(rx)) drop("gym_prescriptions", r.id); render(); } });
    main.append(el("section", { className: "gym-card gym-edit", ariaLabel: ex?.name ?? "Exercise" },
      field(`${id}-n`, "Name", ex?.name, (v) => { if (v && ex) { put("gym_exercises", { ...ex, name: v }); render(); } }, { maxLength: 80 }),
      el("div", { className: "gym-fields" },
        field(`${id}-s`, "Sets", rx.working_sets, (v) => { const n = parseInt(v, 10); if (n >= 1 && n <= 10) editRx(rx, { working_sets: n }); }, { inputMode: "numeric" }),
        field(`${id}-r`, "Reps", rx.reps, (v) => { const p = parseSlot({ reps: v }); if (p.rep_min) editRx(rx, { reps: v, rep_min: p.rep_min, rep_max: p.rep_max }); }),
        field(`${id}-p`, "RPE", rx.rpe, (v) => editRx(rx, { rpe: v || null, rpe_target: parseSlot({ rpe: v }).rpe_target })),
        field(`${id}-w`, "Warm-up", rx.warmup_sets, (v) => editRx(rx, { warmup_sets: v || null })),
        field(`${id}-t`, "Rest (min)", rx.rest_min_s == null ? "" : `${rx.rest_min_s / 60}${rx.rest_max_s !== rx.rest_min_s ? `-${rx.rest_max_s / 60}` : ""}`,
          (v) => { const p = parseSlot({ rest: v }); editRx(rx, { rest_min_s: p.rest_min_s, rest_max_s: p.rest_max_s }); })),
      el("p", { className: "gym-edit-row" }, up, down, replace, remove)));
  });
  const add = el("input", { id: "gym-add", type: "text", className: "gym-text", maxLength: 80, autocomplete: "off", placeholder: "Exercise name" });
  const addBtn = btn("Add exercise", { className: "sheet-btn" });
  addBtn.addEventListener("click", () => {
    const name = add.value.trim();
    if (!name) return;
    let ex = D.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!ex) { ex = { id: uuid(), name, group: null, unit: "lb", step_lb: 5, bar_lb: null }; put("gym_exercises", ex); }
    for (const d of D.days.filter((x) => x.day_key === day.day_key && x.phase === day.phase)) {
      const pos = Math.max(0, ...rxsOf(d.id).map((r) => r.position)) + 1;
      put("gym_prescriptions", { id: uuid(), program_day_id: d.id, position: pos, exercise_id: ex.id, warmup_sets: "1", working_sets: 2, reps: "8-10",
        rep_min: 8, rep_max: 10, rpe: "9", rpe_target: 9, rest_min_s: 120, rest_max_s: 180, sub1_exercise_id: null, sub2_exercise_id: null });
    }
    render();
  });
  main.append(el("p", { className: "gym-edit-row" }, el("label", { className: "visually-hidden", htmlFor: "gym-add", textContent: "New exercise's name" }), add, addBtn));
}

// --- Drawing -----------------------------------------------------------------------------------------

function render() {
  const focused = document.activeElement?.id;
  const main = $("[data-gym-main]");
  main.replaceChildren();
  for (const b of root.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === S.view));
  ({ today: drawToday, records: drawRecords, edit: drawEdit })[S.view](main);
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  note();
}

export async function start(node) {
  root = node;
  const status = $("[data-status]");
  if (!api.configured) { status.textContent = "The tracker is not set up yet."; return; }
  api.takeRedirect();
  if (!(await api.signedIn())) {
    const signIn = btn("Sign in with Google", { className: "sheet-btn primary" });
    signIn.addEventListener("click", () => api.signInTo("/plan/gym/"));
    status.replaceChildren("This is Lisul's lift tracker. ", signIn);
    return;
  }
  try {
    // Offline, the owner check can't run; the cached rows say he got in before.
    const owner = await api.settings().then(Boolean, () => Boolean(readJson(CACHE)));
    if (!owner) { status.textContent = "This account cannot open the tracker."; return; }
    await load();
  } catch (e) {
    console.error(e);
    status.textContent = "Couldn't load the program. Check the connection and reload.";
    return;
  }
  status.hidden = true;
  $("[data-gym-tools]").hidden = false;
  lightDismiss($("[data-gym-swap]"));
  lightDismiss($("[data-gym-summary]"));
  for (const b of root.querySelectorAll("[data-view]")) b.addEventListener("click", () => { S.view = b.dataset.view; render(); });
  $('[data-act="rest-minus"]').addEventListener("click", () => { if (rest) { rest.endsAt -= 15000; tick(); } });
  $('[data-act="rest-plus"]').addEventListener("click", () => { if (rest) { rest.endsAt += 15000; rest.rang = rest.endsAt <= Date.now(); tick(); } });
  $('[data-act="rest-skip"]').addEventListener("click", () => { rest = null; tick(); });
  setInterval(tick, 250);
  setInterval(() => box.pending() && sync(), 30_000);
  addEventListener("online", sync);
  addEventListener("offline", note);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { wake(); sync(); tick(); } });
  if (S.session) wake();
  render();
  sync();
}

// Horizon planning (docs/sheet-horizon.md; ADR 0006): every undone task with a due date gets
// planned minutes on the working days from today up to its due date. Plain code, no network:
// the server runs it on each change and Claude only turns today's minutes into timed blocks.
import { addDays, snap } from "./logic.mjs";
import { paceKind } from "./pace.mjs";

// Chunks: at least 30 and at most 90 minutes of one task on one day; a task of 60 minutes or
// less is never split. Minutes move in 15-minute steps.
export const CHUNK_MIN = 30;
export const CHUNK_MAX = 90;
export const WHOLE_UP_TO = 60;
// Programming and writing may stretch to this many minutes a day, but only when a task would not
// fit otherwise: loading the problem has a fixed cost, and spacing helps such work less.
export const STRETCH_MAX = 120;
export const STRETCH_KINDS = ["programming", "writing"];
const STEP = 15;
export const STATES = ["on_track", "tight", "wont_fit"];
// Days after today are filled to at most this share of their free time, leaving slack for the
// overruns a far-off day's estimate hides (Zauberman & Lynch 2005). Today fills whole.
export const FUTURE_FILL = 0.85;

const up = (m) => Math.ceil(m / STEP) * STEP;
const down = (m) => Math.floor(m / STEP) * STEP;
const diff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// The minutes a task needs in all: its estimate (30 without one) times its kind's pace once it has
// one, rounded to 15 and at least 15. Unlike pacedMinutes (one block, at most 4 hours) there is
// no upper limit: a 20-hour project spreads over days.
export function horizonMinutes(task, paces) {
  const pace = paces?.[paceKind(task)]?.pace;
  return Math.max(STEP, snap((task.est_min ?? 30) * (pace ?? 1)));
}

// The kind of work a task is, for the per-day rules: "exam" (study for an exam, quiz, test, midterm
// or final), "programming", "writing", or null. An explicit task.kind wins; GitHub and Jira tasks
// are programming; else the title decides.
const EXAM = /\b(exams?|quiz(zes)?|tests?|midterms?|finals?)\b/i;
const NOT_EXAM = /\bfinal\s+(project|paper|report|essay|presentation|draft)\b/i;
const PROGRAMMING = /\b(programming|program|coding|code|implement\w*|debug\w*)\b/i;
const WRITING = /\b(essays?|papers?|reports?|write-?ups?|drafts?|writing)\b/i;
export function workKind(task) {
  if (task.kind) return task.kind;
  if (task.source === "github" || task.source === "jira") return "programming";
  const title = task.title ?? "";
  if (EXAM.test(title) && !NOT_EXAM.test(title)) return "exam";
  if (PROGRAMMING.test(title)) return "programming";
  if (WRITING.test(title)) return "writing";
  return null;
}

// Minutes of work done on undone tasks that Lisul confirmed: a block answered More time on its
// Finished? check counts from its start to that answer (at most its length). Any other block,
// past or not, counts as not done. feedback rows are { at, item, action, ref: { block_id } }.
export function confirmedDoneMin(blocks, feedback) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const last = new Map();
  for (const f of feedback) {
    if (f.item !== "finished" || f.action !== "more" || !byId.has(f.ref?.block_id)) continue;
    const at = Date.parse(f.at);
    if (!(last.get(f.ref.block_id) >= at)) last.set(f.ref.block_id, at);
  }
  const out = {};
  for (const [id, at] of last) {
    const b = byId.get(id);
    const start = Date.parse(b.starts_at);
    const m = Math.round((Math.min(at, Date.parse(b.ends_at)) - start) / 60_000);
    if (m > 0) out[b.task_id] = (out[b.task_id] ?? 0) + m;
  }
  return out;
}

// A day's free capped minutes for horizon work: the workload cap less the task minutes locked on
// it (past ones too, as checkProposal's cap counts them), and never more than the window's minutes
// left free by busy times (with travel), habits and those locked blocks. 15-minute steps.
export const dayFree = ({ cap, window_free_min, locked_min = 0 }) =>
  down(Math.max(0, Math.min(cap - locked_min, window_free_min)));

// A task's buffer must hold at least this share of its minutes (Buehler 1994: overruns grow
// with size), and never less than one working day.
export const BUFFER_SHARE = 0.2;

// The day a task should be finished by: the last working day before its due day when the due day
// is 2 or more days off, else the due day. An overdue task's due day reads as today. With
// buffer_min and room (day -> minutes it can hold), the target steps back a working day at a
// time until the days after it, up to the due day, hold buffer_min, while a working day remains.
export function targetDay(due, today, working, buffer_min = 0, room = () => 0) {
  const d = due < today ? today : due;
  if (diff(d, today) < 2) return d;
  let tg = null, held = room(d);
  for (let x = addDays(d, -1); x >= today; x = addDays(x, -1)) {
    if (working(x)) { tg = x; if (held >= buffer_min) break; }
    held += room(x);
  }
  return tg ?? d;
}

// The plan. Input (all minutes are whole numbers):
//   today         "YYYY-MM-DD"
//   tasks         [{ id, due, minutes, done_min }]: undone tasks with a due date; minutes is
//                 horizonMinutes, done_min confirmedDoneMin's (0 without)
//   free          { day: minutes }: dayFree for every day from today to the last due date
//   locked        [{ task_id, day, minutes }]: today's locked task blocks, kept exactly
//   frozen_days   [day]: days whose previous allocation is kept and that take nothing new
//   previous      [{ task_id, day, minutes, over_min }]: the last allocation, for stability
// Returns { allocations: [{ task_id, day, minutes, over_min }], tasks: { id: { state, slack_min,
// short_min, finish_day, target_day, remaining_min } }, moved_min }.
export function planHorizon({ today, tasks, free = {}, locked = [], frozen_days = [], previous = [] }) {
  const frozen = new Set(frozen_days);
  const due = (t) => (t.due < today ? today : t.due);
  const need0 = new Map(tasks.map((t) => [t.id, up(Math.max(0, t.minutes - (t.done_min ?? 0)))]));
  const order = [...tasks].sort((a, b) => due(a).localeCompare(due(b)) || need0.get(a.id) - need0.get(b.id) || String(a.id).localeCompare(String(b.id)));
  const rank = new Map(order.map((t, i) => [t.id, i]));
  const known = new Set(tasks.map((t) => t.id));
  // The most minutes a task may hold on a day: 90, or 120 for programming and writing (only
  // reached when it would not fit at 90).
  const maxFor = (t) => (STRETCH_KINDS.includes(t.kind) ? STRETCH_MAX : CHUNK_MAX);
  const room0 = (d) => (frozen.has(d) ? 0 : down(Math.max(0, free[d] ?? 0) * (d === today ? 1 : FUTURE_FILL)));

  // fixed: minutes no re-flow moves (locked blocks, frozen days); kept: the previous plan's
  // minutes still standing; both task -> day -> minutes.
  const fixed = new Map(), kept = new Map(), over = new Map();
  const get = (m, id) => m.get(id) ?? m.set(id, new Map()).get(id);
  const add = (m, id, d, n) => { const x = get(m, id); x.set(d, (x.get(d) ?? 0) + n); if (!x.get(d)) x.delete(d); };
  const total = (m, id) => sum([...(m.get(id)?.values() ?? [])]);
  const at = (id, d) => (fixed.get(id)?.get(d) ?? 0) + (kept.get(id)?.get(d) ?? 0);

  for (const b of locked) if (known.has(b.task_id) && b.minutes > 0) add(fixed, b.task_id, b.day, b.minutes);
  for (const p of previous) {
    if (!known.has(p.task_id) || p.day < today || p.minutes <= 0) continue;
    if (frozen.has(p.day)) add(fixed, p.task_id, p.day, p.minutes);
  }
  const lockedMin = (id, d) => sum(locked.filter((b) => b.task_id === id && b.day === d).map((b) => b.minutes));
  // Frozen minutes never go past what is left to do; the latest go first, locked ones never.
  for (const t of tasks) {
    let extra = total(fixed, t.id) - need0.get(t.id);
    for (const d of [...(fixed.get(t.id)?.keys() ?? [])].sort().reverse()) {
      if (extra <= 0) break;
      const cut = Math.min(extra, (fixed.get(t.id).get(d) ?? 0) - lockedMin(t.id, d));
      if (cut > 0) { add(fixed, t.id, d, -cut); extra -= cut; }
    }
  }
  const need = new Map(tasks.map((t) => [t.id, Math.max(0, need0.get(t.id) - total(fixed, t.id))]));

  // Keep the previous plan where it still holds: within the task's days, its earliest minutes up
  // to what is left, each piece held to the chunk rule.
  for (const t of order) {
    let left = need.get(t.id);
    const mine = previous.filter((p) => p.task_id === t.id && p.day >= today && p.day <= due(t) && !frozen.has(p.day))
      .map((p) => [p.day, down(p.minutes - (p.over_min ?? 0))]).filter(([, m]) => m > 0).sort(([a], [b]) => a.localeCompare(b));
    if (need0.get(t.id) <= WHOLE_UP_TO && (mine.length > 1 || total(fixed, t.id) > 0)) continue;
    for (const [d, m] of mine) {
      const room = maxFor(t) - at(t.id, d);
      let n = Math.min(m, left, Math.max(0, room));
      if (left - n > 0 && left - n < CHUNK_MIN) n = left - CHUNK_MIN;
      if (n < Math.min(CHUNK_MIN, left)) continue;
      add(kept, t.id, d, n);
      left -= n;
    }
  }
  // A day holding more kept minutes than it has room gives them back, latest due first.
  const room = new Map();
  const days = new Set([...order.map(due)]);
  for (const [, m] of kept) for (const d of m.keys()) days.add(d);
  const used = (d) => sum(order.map((t) => kept.get(t.id)?.get(d) ?? 0));
  for (const d of days) {
    let excess = used(d) - room0(d);
    for (const t of [...order].reverse()) {
      if (excess <= 0) break;
      const k = kept.get(t.id)?.get(d) ?? 0;
      if (!k) continue;
      let cut = Math.min(k, excess);
      if (k - cut > 0 && k - cut + (fixed.get(t.id)?.get(d) ?? 0) < CHUNK_MIN) cut = k;
      add(kept, t.id, d, -cut);
      excess -= cut;
    }
  }
  for (const t of order) need.set(t.id, Math.max(0, need.get(t.id) - total(kept, t.id)));
  const free_ = (d) => room0(d) - used(d);

  const working = (d) => room0(d) > 0 || frozen.has(d) || locked.some((b) => b.day === d);
  const target = new Map(order.map((t) => [t.id, targetDay(t.due, today, working, BUFFER_SHARE * t.minutes, room0)]));

  // The largest piece of `left` minutes task t may add on day d, or 0.
  const piece = (t, d, left, lim = CHUNK_MAX) => {
    const has = at(t.id, d);
    const otherDays = [...new Set([...(fixed.get(t.id)?.keys() ?? []), ...(kept.get(t.id)?.keys() ?? [])])].some((x) => x !== d);
    let n = Math.min(left, down(free_(d)), Math.max(0, lim - has));
    if (need0.get(t.id) <= WHOLE_UP_TO && !has) return n === left && !otherDays ? n : 0;
    while (n > 0) {
      const rest = left - n;
      if ((rest === 0 || rest >= CHUNK_MIN) && (has > 0 || n >= Math.min(CHUNK_MIN, left))) return n;
      n -= STEP;
    }
    return 0;
  };
  const fill = (t, from, to, lim = CHUNK_MAX) => {
    for (let d = from; d <= to && need.get(t.id) > 0; d = addDays(d, 1)) {
      const n = piece(t, d, need.get(t.id), lim);
      if (n > 0) { add(kept, t.id, d, n); need.set(t.id, need.get(t.id) - n); }
    }
    // Top-ups: what is left may go in smaller steps onto days the task already has, but only
    // when that places all of it (no stray piece under 30 is ever left).
    const tops = [];
    for (let d = from; d <= to && need.get(t.id) > 0; d = addDays(d, 1)) {
      const has = at(t.id, d);
      const n = has ? Math.min(down(free_(d)), Math.max(0, lim - has)) : 0;
      if (n > 0) tops.push([d, n]);
    }
    if (need.get(t.id) > 0 && sum(tops.map(([, n]) => n)) >= need.get(t.id)) {
      for (const [d, n] of tops) {
        const k = Math.min(n, need.get(t.id));
        if (k > 0) { add(kept, t.id, d, k); need.set(t.id, need.get(t.id) - k); }
      }
    }
  };
  // Make room for t on from..to by taking minutes from tasks due later, fewest minutes moved
  // first and only as many as t still needs, then fill again. What a later task gives up it
  // re-places in its own turn.
  const evict = (t, from, to, lim = CHUNK_MAX) => {
    // The cut from v on day d that would make room for t, or 0 when none is needed.
    const cutAt = (v, d) => {
      const k = kept.get(v.id)?.get(d) ?? 0;
      const want = up(Math.max(Math.min(need.get(t.id), lim - at(t.id, d)) - Math.max(0, down(free_(d))), 0));
      if (!k || want <= 0) return 0;
      const cut = Math.min(k, Math.max(want, at(t.id, d) ? 0 : Math.min(CHUNK_MIN, need.get(t.id))));
      return k - cut > 0 && k - cut + (fixed.get(v.id)?.get(d) ?? 0) < CHUNK_MIN ? k : cut;
    };
    // 1 when v could not take the cut back on its other days by its due day (it would cascade).
    const strands = (v, d) => {
      let room = 0;
      for (let x = today; x <= due(v); x = addDays(x, 1)) {
        if (x === d) continue;
        const f = down(Math.max(0, free_(x))), has = at(v.id, x);
        room += has ? Math.min(f, Math.max(0, maxFor(v) - has)) : f >= CHUNK_MIN ? Math.min(f, CHUNK_MAX) : 0;
      }
      return room >= cutAt(v, d) ? 0 : 1;
    };
    // Candidates: every later task's kept day in range. The fewest minutes moved first, then a
    // cut the task can take back, then latest due, then the latest day.
    const later = order.filter((v) => rank.get(v.id) > rank.get(t.id));
    const key = ([v, d]) => [cutAt(v, d), strands(v, d), -rank.get(v.id)];
    const cands = later.flatMap((v) => [...(kept.get(v.id)?.keys() ?? [])].filter((x) => x >= from && x <= to).map((d) => [v, d]))
      .map((c) => [c, key(c)])
      .sort(([[, a], ka], [[, b], kb]) => ka.reduce((r, x, i) => r || x - kb[i], 0) || b.localeCompare(a))
      .map(([c]) => c);
    for (const [v, d] of cands) {
      if (need.get(t.id) <= 0) break;
      const cut = cutAt(v, d);
      if (cut <= 0) continue;
      const before = need.get(t.id);
      add(kept, v.id, d, -cut);
      fill(t, d, d, lim);
      if (need.get(t.id) === before) add(kept, v.id, d, cut); // it didn't help: put it back
      else need.set(v.id, need.get(v.id) + cut);
    }
  };

  for (const t of order) {
    const tg = target.get(t.id), dd = due(t);
    // Kept minutes past the target come forward when there is room, so the task need not eat its
    // buffer.
    if (tg < dd) {
      const late = [...(kept.get(t.id)?.entries() ?? [])].filter(([d]) => d > tg);
      const back = sum(late.map(([, m]) => m));
      if (back > 0 && sum(Array.from({ length: diff(tg, today) + 1 }, (_, i) => Math.max(0, free_(addDays(today, i))))) > 0) {
        for (const [d] of late) kept.get(t.id).delete(d);
        need.set(t.id, need.get(t.id) + back);
      }
    }
    fill(t, today, tg);
    evict(t, today, tg);
    if (tg < dd) { fill(t, addDays(tg, 1), dd); evict(t, addDays(tg, 1), dd); }
    // Last resort for programming and writing: up to 120 a day from today to the due day.
    if (need.get(t.id) > 0 && maxFor(t) > CHUNK_MAX) { fill(t, today, dd, STRETCH_MAX); evict(t, today, dd, STRETCH_MAX); }
    // Won't fit: what is left goes on the due day past the cap, never dropped.
    const left = need.get(t.id);
    if (left > 0) { add(over, t.id, dd, left); need.set(t.id, 0); }
  }

  const prevAt = new Map(previous.filter((p) => p.day >= today).map((p) => [`${p.task_id} ${p.day}`, p.minutes]));
  const allocations = [];
  for (const t of order) {
    const ds = new Set([...(fixed.get(t.id)?.keys() ?? []), ...(kept.get(t.id)?.keys() ?? []), ...(over.get(t.id)?.keys() ?? [])]);
    for (const d of ds) {
      const o = over.get(t.id)?.get(d) ?? 0;
      allocations.push({ task_id: t.id, day: d, minutes: at(t.id, d) + o, over_min: o });
    }
  }
  allocations.sort((a, b) => a.day.localeCompare(b.day) || rank.get(a.task_id) - rank.get(b.task_id));
  const nowAt = new Map(allocations.map((a) => [`${a.task_id} ${a.day}`, a.minutes]));
  const moved_min = sum([...prevAt].map(([k, m]) => Math.max(0, m - (nowAt.get(k) ?? 0))));

  // States. slack_min is the running-sum margin at the task's due day: the free minutes from today
  // to it, plus the fixed minutes of the tasks due by then, less what those tasks have left.
  const states = {};
  for (const t of order) {
    const byDue = order.filter((u) => due(u) <= due(t));
    const demand = sum(byDue.map((u) => need0.get(u.id)));
    const fixedSoFar = sum(byDue.flatMap((u) => [...(fixed.get(u.id)?.entries() ?? [])].filter(([d]) => d <= due(t)).map(([, m]) => m)));
    const supply = sum(Array.from({ length: diff(due(t), today) + 1 }, (_, i) => room0(addDays(today, i))));
    const slack_min = supply + fixedSoFar - demand;
    const mine = allocations.filter((a) => a.task_id === t.id);
    const short_min = sum(mine.map((a) => a.over_min));
    const finish_day = mine.length ? mine[mine.length - 1].day : null;
    const tg = target.get(t.id);
    const remaining_min = need0.get(t.id);
    const tight = (finish_day && finish_day > tg) || slack_min < Math.min(CHUNK_MAX, remaining_min) || t.due < today;
    states[t.id] = { state: short_min > 0 ? "wont_fit" : tight && remaining_min > 0 ? "tight" : "on_track", slack_min, short_min, finish_day, target_day: tg, remaining_min };
  }
  return { allocations, tasks: states, moved_min };
}

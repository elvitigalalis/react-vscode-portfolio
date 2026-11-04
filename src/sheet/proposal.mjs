// The morning plan's pure side (docs/sheet-morning.md, "proposal.mjs"; ADR 0003): what
// read_planner shows Claude, the checks a submitted proposal must pass before apply_proposal
// writes it, and the lines the brief adds for it. Kept free of the network and of Node APIs so
// node --test covers it; the planner-mcp and telegram Edge Functions import it.
import { localNow, zonedIso, minutesOn, planningDay, atRisk, addDays, formatClock, blockMinutes, plural, proposedOn } from "./logic.mjs";
import { freeFood } from "./campus.mjs";
import { weatherHours } from "./sources.mjs";
import { paceByKind, pacedMinutes, plannedVsDone } from "./pace.mjs";
import { messageKey, neverRule } from "./triage.mjs";
import { dayLabel } from "./logic.mjs";
import { businessDays } from "./mail.mjs";
import { threadLink } from "./morning.mjs";

// --- read_planner ----------------------------------------------------------------------------

// Course tasks due within this many days of the planning day go in the task list.
const COURSE_AHEAD = 7;
// The day's shutdown line when it has none of its own.
const DEFAULT_SHUTDOWN = "17:00";
// v5 D2: the day rules checkProposal holds a plan to (settings.workload_cap_min's default).
const DEFAULT_CAP = 360;
const dayRules = (settings) => ({ workload_cap_min: settings.workload_cap_min ?? DEFAULT_CAP, travel_min: 10, break_after_min: 90, break_min: 10 });

// Whether an ISO span overlaps the local day `day` in `timeZone`.
const onDay = (s, day, timeZone) => minutesOn(s.ends_at, day, timeZone) > 0 && minutesOn(s.starts_at, day, timeZone) < 1440;

// v5 (docs/sheet-v5.md, "proposal.mjs"). The plan window starts at 07:00, or on today at the
// later of that and now rounded up to the quarter hour, so a replan never plans the past.
function windowFrom(now, day, tz) {
  const here = localNow(now, tz);
  if (here.day !== day) return "07:00";
  const m = Math.max(EARLIEST, Math.ceil(Math.floor(here.minutes) / 15) * 15);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// A replan the server started for this run: started, after the newest revision and under 30
// minutes old. Otherwise this is the morning run. The changes since the newest revision go in as
// kinds and counts only.
const REPLAN_FRESH = 30 * 60_000;
const freshReplan = (r, proposal, now) => Boolean(r && r.result === "started"
  && Date.parse(r.at) > (proposal ? Date.parse(proposal.created_at) : -Infinity) && now - Date.parse(r.at) < REPLAN_FRESH);
function runOf(rows, now, day) {
  const r = rows.replan;
  // A replans row is for its own day (one without `day` reads as plan_day's).
  const replan = freshReplan(r, rows.proposal, now) && (r.day == null || r.day === day);
  const changes = {};
  for (const c of list(rows.changes)) changes[c.kind] = (changes[c.kind] ?? 0) + 1;
  return { trigger: replan ? "replan" : "morning", reasons: replan ? [...r.reasons] : [], changes };
}

// Whether a message run may go on as a replan of today: `message` is the newest fired messages
// row ({ fired_at }), fired under 30 minutes ago and after `proposal`, today's newest revision.
// planner-mcp passes it only while replans are on (docs/sheet-morning-task.md, step 2b).
export const messageRunOf = (now, message, proposal) => Boolean(message?.fired_at
  && now - Date.parse(message.fired_at) < REPLAN_FRESH
  && Date.parse(message.fired_at) > (proposal ? Date.parse(proposal.created_at) : -Infinity));

// The day a run plans: today when a replan started this run (`replan`, today's newest replans
// row, fresh and after `proposal`, today's newest revision), or a message run may go on as a
// replan of today (`message`, messageRunOf), since a replan plans the rest of today even from
// 3 pm; otherwise the 3 pm rule's planningDay.
export function planDayOf(now, timeZone, replan, proposal, message = null) {
  const here = localNow(now, timeZone);
  const today = (replan?.day === here.day && freshReplan(replan, proposal, now)) || messageRunOf(now, message, proposal);
  return today ? here.day : planningDay(here);
}

// v5 M1: the reply_state rows by state, oldest first, as { account, thread_id, who, since }.
// Owed rows also carry what a Needs you item needs: message_id, basis, draft (his reply is an
// unsent draft), overdue (2+ business days, worked out now, not at sync) and the thread's link.
function replyStateOf(rows, timeZone, now) {
  const sorted = list(rows).slice().sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const of = (state) => sorted.filter((r) => r.state === state)
    .map((r) => ({ account: r.account, thread_id: r.thread_id, who: r.who, since: r.since }));
  const owed = sorted.filter((r) => r.state === "owed").map((r) => ({
    account: r.account, thread_id: r.thread_id, who: r.who, since: r.since,
    message_id: r.message_id, basis: r.basis ?? null, draft: Boolean(r.draft),
    overdue: businessDays(r.since, now.toISOString(), timeZone) >= 2, link: threadLink(r.account, r.thread_id),
  }));
  return { owed, awaiting: of("awaiting") };
}

// What read_planner returns, from the rows planner-mcp reads:
//   settings   the settings row
//   tasks, blocks, busy, days, campus   table rows
//   proposal   plan_day's proposals row, or null
//   needsOpen  the needs_you rows not done
//   accounts   the mail_accounts rows
//   actuals    v5 P1: the actuals rows (pace)
//   past       v5 P1: the approved blocks of the 14 days before plan_day, each with its task's
//              done as `task: { done }` (paceQueries, proposal-io.mjs)
//   habits     v5 H1: the habits rows
//   academic   v5 SRC3: plan_day's academic_days entries, [{ title, all_day }]
//   replyState v5 M1: the reply_state rows
// The task list is plan_day's undone tasks, then every undone task at risk on plan_day, then
// undone course tasks due within 7 days, each once and in row order within its group.
export function planSnapshot(rows, now) {
  const { settings } = rows;
  const tz = settings.time_zone;
  // A replan run's plan_day comes in as rows.plan_day (planDayOf); otherwise the 3 pm rule.
  const day = rows.plan_day ?? planningDay(localNow(now, tz));
  const line = rows.days.find((d) => d.day === day)?.shutdown_at;
  const risky = (t) => atRisk(t, rows.blocks, day, tz);
  const undone = rows.tasks.filter((t) => !t.done);
  const groups = [
    undone.filter((t) => t.day === day),
    undone.filter(risky),
    undone.filter((t) => t.source && t.due && t.due <= addDays(day, COURSE_AHEAD)),
  ];
  // v5: a task turned down today leaves the list, so the planner doesn't offer it again.
  const turnedDown = list(rows.turnedDown ?? rows.days.find((d) => d.day === day)?.turned_down);
  const seen = new Set(turnedDown);
  // v5 P1: pace per kind, and each task's paced estimate.
  const pace = paceByKind(rows.actuals ?? []);
  // v5 H1: habit blocks aren't tasks, so they stay out of planned versus done.
  const past = (rows.past ?? []).filter((b) => b.task_id);
  const tasks = groups.flat().filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({
    id: t.id, title: t.title, est_min: t.est_min, at_time: t.at_time, due: t.due, tag: t.tag,
    source: t.source, day: t.day, list: t.list, at_risk: risky(t), paced_min: pacedMinutes(t, pace),
  }));
  const shutdown = line ? line.slice(0, 5) : DEFAULT_SHUTDOWN;
  return {
    version: 5,
    now: now.toISOString(),
    // When this snapshot was read: submit_proposal passes it back, so the revision consumes only
    // the changes logged by then (apply_proposal's read_at).
    read_at: now.toISOString(),
    time_zone: tz,
    plan_day: day,
    shutdown,
    run: runOf(rows, now, day),
    window: { from: windowFrom(now, day, tz), to: shutdown },
    turned_down: turnedDown,
    tasks,
    blocks: rows.blocks.filter((b) => localNow(new Date(b.starts_at), tz).day === day)
      .map((b) => ({ task_id: b.task_id, ...(b.habit_id ? { habit_id: b.habit_id } : {}), starts_at: b.starts_at, ends_at: b.ends_at, proposed: b.proposed })),
    busy: rows.busy.filter((b) => onDay(b, day, tz)).map((b) => ({ starts_at: b.starts_at, ends_at: b.ends_at })),
    busy_as_of: settings.busy_as_of ?? null,
    interests: settings.interests ?? null,
    // Never description or url: free text and links from the feed stay out of Claude's way.
    campus: rows.campus.map((e) => ({
      uid: e.uid, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, group_name: e.group_name,
      tags: e.tags, free_food: freeFood(e), rsvp_count: e.rsvp_count ?? null,
    })),
    proposal: rows.proposal
      ? { rev: rows.proposal.rev ?? 1, status: rows.proposal.status, created_at: rows.proposal.created_at, run_trigger: rows.proposal.run_trigger ?? "morning" }
      : null,
    needs_you_open: rows.needsOpen.map((n) => ({ account: n.account, message_id: n.message_id })),
    accounts: rows.accounts.map((a) => a.email),
    day_rules: dayRules(settings),
    // v5 W1: the weather_cache row's hours for plan_day, [] without a cache.
    weather: rows.weather ? weatherHours(rows.weather.periods ?? [], day, tz) : [],
    // v5 L1: the triage rules, which submit_proposal enforces for never.
    triage_rules: list(rows.triage).map((r) => ({ match: r.match, pattern: r.pattern, action: r.action })),
    // v5 M1: Reply owed and Awaiting reply from the mail sync's reply_state rows, oldest first.
    reply_state: replyStateOf(rows.replyState, tz, now),
    // v5 SRC3: plan_day's academic calendar entries (academic_days), [] without them.
    academic: (rows.academic ?? []).map((e) => ({ title: e.title, all_day: e.all_day })),
    // v5 P1.
    pace,
    planned_vs_done: plannedVsDone(past, past.map((b) => ({ id: b.task_id, done: Boolean(b.task?.done) })), day, tz),
    // v5 H1.
    habits: dayHabits(rows.habits, day),
  };
}

// --- v5 H1: habits (docs/sheet-v5.md, "planSnapshot" and "checkProposal") ------------------

// ISO weekday of a "YYYY-MM-DD" date, 1 = Monday.
const isoWeekday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() || 7;

// The habits on `day`'s weekday: firm ones first, then flexible, each by ideal time, then
// position. The morning task places them in this order.
function dayHabits(habits, day) {
  const wd = isoWeekday(day);
  return list(habits).filter((h) => list(h.days).includes(wd))
    .sort((a, b) => (a.defence === "firm" ? 0 : 1) - (b.defence === "firm" ? 0 : 1)
      || a.ideal.localeCompare(b.ideal) || (a.position ?? 0) - (b.position ?? 0))
    .map((h) => ({ id: h.id, name: h.name, ideal: h.ideal.slice(0, 5), minutes: h.minutes, flex_min: h.flex_min, defence: h.defence }));
}

// --- submit_proposal -------------------------------------------------------------------------

export const MAX_BLOCKS = 12;
export const MAX_NEEDS = 15;
export const MAX_PICKS = 5;
export const NEEDS_KINDS = ["reply", "deadline", "meeting", "admin"];
// No block starts before 7:00 am.
const EARLIEST = 7 * 60;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HEX_ID = /^[0-9a-f]{6,32}$/;
// Anything Telegram or a browser could turn into a link or a command: a scheme ("https://",
// "tg://"), "www.", a bare domain ("evil.com", "t.me"), an @mention or email, or a /command.
const URLISH = /[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b|@\w|(?:^|\s)\/[a-z]/i;
export const linkish = (s) => URLISH.test(String(s ?? ""));
// Line breaks and other control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const list = (v) => (v == null ? [] : v);

// "2:00–3:20 pm", "11:00 am–12:00 pm": the half of the day once when both ends share it.
export function clockSpan(start, end) {
  const [a, b] = [formatClock(((start % 1440) + 1440) % 1440), formatClock(((end % 1440) + 1440) % 1440)];
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

// One free-text field: text, one line, no link, at most `max` characters once runs of spaces
// are collapsed. Returns the collapsed text, or pushes an error naming `name` and returns null.
function text(value, name, max, errors) {
  if (typeof value !== "string") return errors.push(`${name}: must be text`), null;
  if (CONTROL.test(value)) return errors.push(`${name}: must be one line, with no line breaks or control characters`), null;
  if (URLISH.test(value)) return errors.push(`${name}: must not hold a link or web address`), null;
  const t = value.replace(/\s+/g, " ").trim();
  if (t.length > max) return errors.push(`${name}: at most ${max} characters, got ${t.length}`), null;
  return t;
}

// --- v5 D2: a realistic day (docs/sheet-v5.md, "checkProposal") -------------------------------

// "6h00", "6h30": a workload in hours and minutes.
const hoursLabel = (m) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;

// The day rules on a proposal's spans ({ name, start, end }, minutes on the day), pushing an
// error for each: the travel gap, the break rule and the workload cap. The day's approved blocks count; the
// pending revision's proposed blocks don't, since the new revision replaces them.
function dayRuleErrors(spans, snapshot, errors) {
  const rules = snapshot.day_rules;
  const approved = snapshot.blocks.filter((b) => !b.proposed);
  const at = (iso) => minutesOn(iso, snapshot.plan_day, snapshot.time_zone);

  // The travel gap around busy times (not approved blocks). A span over the busy time itself
  // already has v4's overlap error.
  const gap = rules.travel_min;
  for (const s of spans) {
    for (const b of snapshot.busy) {
      const [from, to] = [at(b.starts_at), at(b.ends_at)];
      if (s.start < to && from < s.end) continue;
      if (s.start < to + gap && from - gap < s.end) {
        errors.push(`${s.name}: needs ${gap} minutes of travel time around the busy time ${clockSpan(from, to)}`);
      }
    }
  }

  // The break rule: blocks less than break_min apart are one run, and a run holding a proposed
  // block spans at most break_after_min. A single long block is fine; one error per run.
  const all = [...approved.map((b) => ({ start: at(b.starts_at), end: at(b.ends_at) })), ...spans].sort((a, b) => a.start - b.start);
  const runs = [];
  for (const s of all) {
    const run = runs.at(-1);
    if (run && s.start - run.end < rules.break_min) run.items.push(s), (run.end = Math.max(run.end, s.end));
    else runs.push({ start: s.start, end: s.end, items: [s] });
  }
  for (const run of runs) {
    if (run.end - run.start <= rules.break_after_min || run.items.length < 2) continue;
    const mine = run.items.filter((s) => s.name);
    if (!mine.length) continue;
    // The first block to carry the run past the limit, or, when that one is approved, the
    // run's latest proposed block.
    const over = run.items.find((s) => s.end - run.start > rules.break_after_min);
    const named = over?.name ? over : mine.at(-1);
    errors.push(`${named.name}: makes ${run.end - run.start} minutes of blocks in a row; leave a ${rules.break_min}-minute break after every ${rules.break_after_min}`);
  }

  // The cap is for work: habit blocks (approved ones, and spans named habits[i]) stay out of it.
  const planned = approved.filter((b) => !b.habit_id).reduce((n, b) => n + blockMinutes(b), 0)
    + spans.filter((s) => !s.name.startsWith("habits[")).reduce((n, s) => n + s.end - s.start, 0);
  if (planned > rules.workload_cap_min) {
    errors.push(`blocks: ${hoursLabel(planned)} planned, over the ${hoursLabel(rules.workload_cap_min)} workload cap`);
  }
}

// The habit blocks of a proposal ({ habit_id, start: "HH:MM" }): each one of the day's habits, at
// most once, starting within ideal ± flex_min (both ends included) and running the habit's
// minutes inside the plan window, over no busy time, approved block, block or other habit block.
// Returns apply_proposal's habit_blocks and the spans (named habits[i]) for the day rules.
function habitBlockRows(input, snapshot, placed, errors) {
  const out = { rows: [], spans: [] };
  const given = list(input?.habits);
  if (!Array.isArray(given)) return errors.push("habits: must be a list"), out;
  if (given.length > MAX_BLOCKS) return errors.push(`habits: at most ${MAX_BLOCKS}, got ${given.length}`), out;
  const { plan_day: day, time_zone: tz, window } = snapshot;
  const habits = new Map(list(snapshot.habits).map((h) => [h.id, h]));
  const at = (iso) => minutesOn(iso, day, tz);
  const fixed = [
    ...snapshot.busy.map((s) => ({ start: at(s.starts_at), end: at(s.ends_at), label: "a busy time" })),
    ...snapshot.blocks.filter((b) => !b.proposed).map((s) => ({ start: at(s.starts_at), end: at(s.ends_at), label: "an approved block" })),
  ];
  const seen = new Set();
  given.forEach((g, i) => {
    const name = `habits[${i}]`;
    const before = errors.length;
    const h = habits.get(g?.habit_id);
    if (!h) return errors.push(`${name}: habit_id is not one of the habits read_planner gave`);
    if (seen.has(h.id)) return errors.push(`${name}: this habit is placed already; place it at most once`);
    seen.add(h.id);
    if (typeof g.start !== "string" || !HHMM.test(g.start)) return errors.push(`${name}: start must be "HH:MM", 24-hour`);
    const from = toMinutes(g.start);
    const to = from + h.minutes;
    const ideal = toMinutes(h.ideal);
    if (Math.abs(from - ideal) > h.flex_min) {
      errors.push(`${name}: must start between ${formatClock(Math.max(0, ideal - h.flex_min))} and ${formatClock(Math.min(1439, ideal + h.flex_min))}, ${h.name}'s ideal time ± ${h.flex_min} minutes`);
    }
    if (from < toMinutes(window.from)) errors.push(`${name}: starts before ${window.from}, the start of the plan window`);
    else if (to > toMinutes(window.to)) errors.push(`${name}: ends after ${window.to}, the end of the plan window`);
    const hit = fixed.find((s) => from < s.end && s.start < to);
    if (hit) errors.push(`${name}: overlaps ${hit.label} ${clockSpan(hit.start, hit.end)}`);
    const block = placed.find((p) => from < p.end && p.start < to);
    if (block) errors.push(`${name}: overlaps blocks[${block.i}]`);
    const twin = out.spans.find((p) => from < p.end && p.start < to);
    if (twin) errors.push(`${name}: overlaps ${twin.name}`);
    out.spans.push({ name, start: from, end: to });
    if (errors.length === before) out.rows.push({ habit_id: h.id, starts_at: zonedIso(day, from, tz), ends_at: zonedIso(day, to, tz) });
  });
  return out;
}

export const MAX_COULDNT_FIT = 12;

// The tasks Claude couldn't fit: ids from the task list, each once, none also given a block.
function couldntFitIds(input, snapshot, errors) {
  const ids = list(input?.couldnt_fit);
  if (!Array.isArray(ids)) return errors.push("couldnt_fit: must be a list"), [];
  if (ids.length > MAX_COULDNT_FIT) return errors.push(`couldnt_fit: at most ${MAX_COULDNT_FIT}, got ${ids.length}`), [];
  const tasks = new Set(snapshot.tasks.map((t) => t.id));
  const placed = new Set(Array.isArray(input?.blocks) ? input.blocks.map((b) => b?.task_id) : []);
  ids.forEach((id, i) => {
    const name = `couldnt_fit[${i}]`;
    if (!tasks.has(id)) errors.push(`${name}: not one of the tasks read_planner gave`);
    else if (ids.indexOf(id) < i) errors.push(`${name}: given twice`);
    else if (placed.has(id)) errors.push(`${name}: this task has a block, so it fit`);
  });
  return ids;
}

// --- v5 A1: suggested tasks (docs/sheet-v5.md, "checkProposal") -------------------------------

export const MAX_SUGGESTED = 5;
export const SUGGESTED_KINDS = ["assessment", "interview"];

// The tasks Claude suggests from assessment and interview mail: each for one of this submit's
// needs_you items (an item open from an earlier run isn't enough), at most one per item.
function suggestedTasks(input, errors) {
  const items = list(input?.suggested);
  if (!Array.isArray(items)) return errors.push("suggested: must be a list"), [];
  if (items.length > MAX_SUGGESTED) return errors.push(`suggested: at most ${MAX_SUGGESTED}, got ${items.length}`), [];
  const needs = Array.isArray(input?.needs_you) ? input.needs_you : [];
  const key = (x) => `${x?.account} ${x?.message_id}`;
  const mine = new Set(needs.map(key));
  const out = [];
  const used = new Set();
  items.forEach((t, i) => {
    const name = `suggested[${i}]`;
    const before = errors.length;
    if (!mine.has(key(t))) errors.push(`${name}: account and message_id must match one of this submit's needs_you items`);
    else if (used.has(key(t))) errors.push(`${name}: that item already has a suggested task`);
    used.add(key(t));
    if (!isDate(t?.due)) errors.push(`${name}.due: required, a date "YYYY-MM-DD"`);
    if (!SUGGESTED_KINDS.includes(t?.kind)) errors.push(`${name}.kind: must be one of ${SUGGESTED_KINDS.join(", ")}`);
    const title = text(t?.title, `${name}.title`, 80, errors);
    if (errors.length === before) out.push({ account: t.account, message_id: t.message_id, title, due: t.due, kind: t.kind });
  });
  return out;
}

// The checks submit_proposal runs on `input` ({ day, blocks: [{ task_id, start: "HH:MM",
// minutes }], needs_you: [{ account, message_id, link, sender, subject, why, kind, due? }],
// picks: [{ uid, why }], note }) against a fresh planSnapshot. Every problem is its own error,
// a sentence starting with the field it names, so Claude can fix them all and submit again.
// When there is none, `rows` holds apply_proposal's arguments: { d, blocks: [{ task_id,
// starts_at, ends_at }], needs, picks, note }, times in UTC.
//
// v5 (docs/sheet-v5.md, "proposal.mjs"): with `snapshot.version` 5, `input` also names the
// revision it `replaces` (null for the day's first), and blocks must sit inside the plan window
// and not be for a task turned down today. A replan may follow an approved revision. `rows`
// gains apply_proposal's v5 arguments, and the result gains `dropped`.
//
// v5 L1: `senders` maps "<account> <message_id>" to the message's sender hashes, { address,
// domains } (planner-mcp reads message_senders), and `hashOf(pattern)` hashes a rule's pattern
// the same way (fix: no From address in plain text). A Needs you item from a sender a never-show
// rule covers is dropped, not refused, and each row carries its sender_hash (null when unknown).
export function checkProposal(input, snapshot, senders = {}, hashOf = () => null) {
  const errors = [];
  const tz = snapshot.time_zone;
  const day = snapshot.plan_day;
  const v5 = snapshot.version === 5;
  const status = snapshot.proposal?.status;
  if (input?.day !== day) errors.push(`day: must be ${day}, the day being planned`);
  else if (status && status !== "pending" && !(v5 && status === "approved")) {
    errors.push(`day: the proposal for ${day} is already ${status}`);
  }
  const newest = snapshot.proposal?.rev ?? null;
  const replaces = input?.replaces ?? null;
  if (v5 && replaces !== newest) {
    errors.push(newest == null
      ? `replaces: must be null, since ${day} has no revision yet`
      : `replaces: must be ${newest}, the newest revision for ${day}`);
  }

  // Blocks.
  const blocks = [];
  const placed = [];
  const inBlocks = list(input?.blocks);
  if (!Array.isArray(inBlocks)) errors.push("blocks: must be a list");
  else if (inBlocks.length > MAX_BLOCKS) errors.push(`blocks: at most ${MAX_BLOCKS}, got ${inBlocks.length}`);
  else {
    const tasks = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const shutdown = toMinutes(snapshot.shutdown);
    const turnedDown = new Set(v5 ? list(snapshot.turned_down) : []);
    const win = v5 ? { from: toMinutes(snapshot.window.from), to: toMinutes(snapshot.window.to) } : null;
    const taken = (spans, label) => spans.map((s) => ({ start: minutesOn(s.starts_at, day, tz), end: minutesOn(s.ends_at, day, tz), label }));
    const fixed = [
      ...taken(snapshot.busy, "a busy time"),
      ...taken(snapshot.blocks.filter((b) => !b.proposed), "an approved block"),
    ];
    inBlocks.forEach((b, i) => {
      const name = `blocks[${i}]`;
      const before = errors.length;
      const task = tasks.get(b?.task_id);
      if (turnedDown.has(b?.task_id)) errors.push(`${name}: turned down today, so it can't be planned again today`);
      else if (!task) errors.push(`${name}: task_id is not one of the tasks read_planner gave`);
      const { minutes, start } = b ?? {};
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240 || minutes % 5) {
        errors.push(`${name}: minutes must be 15 to 240, a multiple of 5`);
      }
      if (typeof start !== "string" || !HHMM.test(start)) return errors.push(`${name}: start must be "HH:MM", 24-hour`);
      const from = toMinutes(start);
      if (win && from < win.from) errors.push(`${name}: starts before ${snapshot.window.from}, the start of the plan window`);
      else if (!win && from < EARLIEST) errors.push(`${name}: starts before 07:00`);
      // v5 P1: a block runs the task's paced estimate.
      if (snapshot.version === 5 && task && Number.isInteger(minutes) && minutes !== task.paced_min) {
        errors.push(`${name}: minutes must be ${task.paced_min}, the task's paced estimate`);
      }
      if (task?.at_time && task.at_time.slice(0, 5) !== start) errors.push(`${name}: this task is fixed at ${task.at_time.slice(0, 5)}, so it must start then`);
      if (errors.length > before && !Number.isInteger(minutes)) return;
      const to = from + minutes;
      if (win && to > win.to) errors.push(`${name}: ends after ${snapshot.window.to}, the end of the plan window`);
      else if (!win && to > shutdown) errors.push(`${name}: ends after the ${snapshot.shutdown} shutdown line`);
      // A block may end exactly when the next one starts.
      const hit = fixed.find((s) => from < s.end && s.start < to);
      if (hit) errors.push(`${name}: overlaps ${hit.label} ${clockSpan(hit.start, hit.end)}`);
      const twin = placed.find((p) => from < p.end && p.start < to);
      if (twin) errors.push(`${name}: overlaps blocks[${twin.i}]`);
      placed.push({ i, start: from, end: to });
      if (errors.length === before) {
        blocks.push({ task_id: b.task_id, starts_at: zonedIso(day, from, tz), ends_at: zonedIso(day, to, tz) });
      }
    });
  }
  // v5 H1: habit blocks, checked against the same window, busy times and blocks.
  const habitBlocks = v5 ? habitBlockRows(input, snapshot, placed, errors) : { rows: [], spans: [] };
  if (v5) dayRuleErrors([...placed.map((p) => ({ ...p, name: `blocks[${p.i}]` })), ...habitBlocks.spans], snapshot, errors);

  // Needs you.
  const needs = [];
  const inNeeds = list(input?.needs_you);
  if (!Array.isArray(inNeeds)) errors.push("needs_you: must be a list");
  else if (inNeeds.length > MAX_NEEDS) errors.push(`needs_you: at most ${MAX_NEEDS}, got ${inNeeds.length}`);
  else {
    inNeeds.forEach((n, i) => {
      const name = `needs_you[${i}]`;
      const before = errors.length;
      const { account, message_id, link, kind, due } = n ?? {};
      const connected = snapshot.accounts.includes(account);
      if (!connected) errors.push(`${name}.account: not a connected mail account`);
      if (typeof message_id !== "string" || !HEX_ID.test(message_id)) errors.push(`${name}.message_id: must be the hex id search_mail gave`);
      // Exactly the link search_mail builds (mail.mjs, messageSummary): Gmail, signed in as this
      // account, at a hex thread id.
      const prefix = `https://mail.google.com/mail/?authuser=${encodeURIComponent(String(account))}#all/`;
      if (typeof link !== "string" || !link.startsWith(prefix) || !HEX_ID.test(link.slice(prefix.length))) {
        errors.push(`${name}.link: must be the link search_mail gave for this account's message`);
      }
      if (!NEEDS_KINDS.includes(kind)) errors.push(`${name}.kind: must be one of ${NEEDS_KINDS.join(", ")}`);
      if (due != null && !isDate(due)) errors.push(`${name}.due: must be a date, "YYYY-MM-DD"`);
      const sender = text(n?.sender, `${name}.sender`, 80, errors);
      const subject = text(n?.subject, `${name}.subject`, 140, errors);
      const why = text(n?.why, `${name}.why`, 140, errors);
      if (errors.length === before) needs.push({ account, message_id, link, sender, subject, why, kind, due: due ?? null });
    });
  }

  // Campus picks.
  const picks = [];
  const inPicks = list(input?.picks);
  if (!Array.isArray(inPicks)) errors.push("picks: must be a list");
  else if (inPicks.length > MAX_PICKS) errors.push(`picks: at most ${MAX_PICKS}, got ${inPicks.length}`);
  else {
    const uids = new Set(snapshot.campus.map((e) => e.uid));
    inPicks.forEach((p, i) => {
      const name = `picks[${i}]`;
      const before = errors.length;
      if (!uids.has(p?.uid)) errors.push(`${name}.uid: not one of the campus events read_planner gave`);
      const why = text(p?.why, `${name}.why`, 140, errors);
      if (errors.length === before) picks.push({ uid: p.uid, why });
    });
  }

  const note = input?.note == null ? null : text(input.note, "note", 280, errors);
  const couldntFit = v5 ? couldntFitIds(input, snapshot, errors) : null;
  const suggested = v5 ? suggestedTasks(input, errors) : null;
  const readAt = v5 ? readAtOf(input, snapshot, errors) : null;

  if (!v5) return errors.length ? { ok: false, errors, rows: null } : { ok: true, errors: [], rows: { d: day, blocks, needs, picks, note } };
  if (errors.length) return { ok: false, errors, rows: null, dropped: [] };
  const { trigger: run_trigger, reasons } = snapshot.run;
  const kept = dropNeverShown(needs, suggested, snapshot, senders, hashOf);
  return {
    ok: true, errors: [],
    rows: { d: day, replaces, blocks, habit_blocks: habitBlocks.rows, needs: kept.needs, picks, note, couldnt_fit: couldntFit, suggested: kept.suggested, run_trigger, reasons, ...(readAt ? { read_at: readAt } : {}) },
    dropped: kept.dropped,
  };
}

// read_at, the read_planner snapshot's time the run submits against: optional (without it
// apply_proposal uses its own clock), and never after this submit's fresh snapshot.
function readAtOf(input, snapshot, errors) {
  if (input?.read_at == null) return null;
  const at = typeof input.read_at === "string" ? Date.parse(input.read_at) : NaN;
  if (Number.isNaN(at) || at > Date.parse(snapshot.now)) return errors.push("read_at: must be the read_at read_planner gave"), null;
  return new Date(at).toISOString();
}

// v5 L1, never-show rules: the needs rows (all valid, so in input order) gain sender_hash, and
// those whose sender a `never` rule in snapshot.triage_rules covers go, with their suggestion.
// `dropped` is [{ index, message_id, pattern }], index into the input's needs_you.
function dropNeverShown(needs, suggested, snapshot, senders, hashOf) {
  const rules = list(snapshot.triage_rules);
  const dropped = [];
  const kept = [];
  needs.forEach((n, index) => {
    const sender = senders?.[messageKey(n.account, n.message_id)] ?? null;
    const rule = sender && neverRule(rules, sender, hashOf);
    if (rule) dropped.push({ index, message_id: n.message_id, pattern: rule.pattern });
    else kept.push({ ...n, sender_hash: sender?.address ?? null });
  });
  const gone = new Set(dropped.map((d) => messageKey(needs[d.index].account, d.message_id)));
  return { needs: kept, suggested: suggested.filter((x) => !gone.has(messageKey(x.account, x.message_id))), dropped };
}

// --- The brief -------------------------------------------------------------------------------

// Block lines the brief shows before "+N more", and campus picks it names.
const SHOWN_BLOCKS = 6;
const SHOWN_PICKS = 2;

// "Campus pick: Art Club - Oil Pastels (7:00 pm, 22 going)", for the brief and for /plan.
export function pickLine(e, tz) {
  const going = Number.isInteger(e.rsvp_count) ? `, ${e.rsvp_count} going` : "";
  return `Campus pick: ${e.title} (${formatClock(localNow(new Date(e.starts_at), tz).minutes)}${going})`;
}

// The campus events a proposal's picks name, in pick order; a pick whose event is gone drops.
export const pickedEvents = (picks, campus) => (picks ?? []).map((p) => campus.find((e) => e.uid === p.uid)).filter(Boolean);

// Couldn't-fit titles the line names before "+N more", and the characters kept of each.
const SHOWN_COULDNT_FIT = 3;
const COULDNT_FIT_CHARS = 30;

// "Couldn't fit: Lab 4, HW3 +1 more.", for the brief, the plan and replan messages and /plan,
// or null for none. `ids` are task ids; a task that's gone drops, and a title that could become a
// link reads "A task".
export function couldntFitLine(ids, tasks) {
  const titles = (ids ?? []).map((id) => tasks.find((t) => t.id === id)?.title).filter(Boolean)
    .map((t) => (linkish(t) ? "A task" : String(t).replace(/\s+/g, " ").trim().slice(0, COULDNT_FIT_CHARS).trim()));
  if (!titles.length) return null;
  const more = titles.length > SHOWN_COULDNT_FIT ? ` +${titles.length - SHOWN_COULDNT_FIT} more` : "";
  return `Couldn't fit: ${titles.slice(0, SHOWN_COULDNT_FIT).join(", ")}${more}.`;
}

// "Task to add: HackerRank assessment (due Nov 7)", for the brief and /plan. Titles passed
// checkProposal; one that could become a link reads "A task" anyway.
export const suggestedLine = (t) => `Task to add: ${linkish(t.title) ? "A task" : t.title} (due ${dayLabel(t.due).date})`;

// The lines a pending proposal adds to the brief, or sends as the `proposal` message: a summary,
// up to 6 blocks, what didn't fit, up to 2 campus picks and the open Needs you count. `blocks`
// may hold any blocks; only the proposal day's proposed ones count. `picks` is [{ uid, why }],
// `campus` the events they name, `needsOpen` the needs_you rows not done.
export function proposalLines(proposal, blocks, tasks, needsOpen, picks, campus, tz) {
  const day = proposal.day;
  const mine = proposedOn(blocks, day, tz);
  const at = (iso) => minutesOn(iso, day, tz);
  const lines = [mine.length
    ? `Morning plan: ${plural(mine.length, "block")}, ${clockSpan(at(mine[0].starts_at), at(mine.at(-1).ends_at))}.`
    : "Morning plan: no blocks."];
  for (const b of mine.slice(0, SHOWN_BLOCKS)) {
    // v5 H1: a habit block has no task; the brief doesn't read habits, so it says "Habit".
    const title = b.habit_id ? "Habit" : tasks.find((t) => t.id === b.task_id)?.title ?? "A task";
    lines.push(`${formatClock(at(b.starts_at))} · ${title} (${blockMinutes(b)} min)`);
  }
  if (mine.length > SHOWN_BLOCKS) lines.push(`+${mine.length - SHOWN_BLOCKS} more`);
  if (proposal.note) lines.push(`Didn't fit: ${proposal.note}`);
  const unfit = couldntFitLine(proposal.couldnt_fit, tasks);
  if (unfit) lines.push(unfit);
  // v5 A1: one line per suggested task. Titles passed checkProposal; one that could become a link
  // reads "A task" anyway.
  for (const t of proposal.suggested ?? []) lines.push(suggestedLine(t));
  const events = pickedEvents(picks ?? proposal.picks, campus);
  // Event titles come from the campus feed, not through checkProposal; one that could become a
  // link stays off Telegram (it still shows in /plan, as text).
  for (const e of events.filter((x) => !linkish(x.title)).slice(0, SHOWN_PICKS)) lines.push(pickLine(e, tz));
  const open = needsOpen.filter((n) => !n.done).length;
  if (open) lines.push(`Mail: ${open} ${open === 1 ? "needs" : "need"} you.`);
  return lines;
}

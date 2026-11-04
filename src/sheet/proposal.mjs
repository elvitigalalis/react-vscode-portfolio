// The morning plan's pure side (docs/sheet-morning.md, "proposal.mjs"; ADR 0003): what
// read_planner shows Claude, the checks a submitted proposal must pass before apply_proposal
// writes it, and the lines the brief adds for it. Kept free of the network and of Node APIs so
// node --test covers it; the planner-mcp and telegram Edge Functions import it.
import { localNow, zonedIso, minutesOn, planningDay, atRisk, addDays, formatClock, blockMinutes, plural, proposedOn } from "./logic.mjs";
import { freeFood } from "./campus.mjs";
import { weatherHours } from "./sources.mjs";

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
function runOf(rows, now) {
  const r = rows.replan;
  const after = rows.proposal ? Date.parse(rows.proposal.created_at) : -Infinity;
  const replan = r && r.result === "started" && Date.parse(r.at) > after && now - Date.parse(r.at) < REPLAN_FRESH;
  const changes = {};
  for (const c of list(rows.changes)) changes[c.kind] = (changes[c.kind] ?? 0) + 1;
  return { trigger: replan ? "replan" : "morning", reasons: replan ? [...r.reasons] : [], changes };
}

// What read_planner returns, from the rows planner-mcp reads:
//   settings   the settings row
//   tasks, blocks, busy, days, campus   table rows
//   proposal   plan_day's proposals row, or null
//   needsOpen  the needs_you rows not done
//   accounts   the mail_accounts rows
// The task list is plan_day's undone tasks, then every undone task at risk on plan_day, then
// undone course tasks due within 7 days, each once and in row order within its group.
export function planSnapshot(rows, now) {
  const { settings } = rows;
  const tz = settings.time_zone;
  const day = planningDay(localNow(now, tz));
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
  const tasks = groups.flat().filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({
    id: t.id, title: t.title, est_min: t.est_min, at_time: t.at_time, due: t.due, tag: t.tag,
    source: t.source, day: t.day, list: t.list, at_risk: risky(t),
  }));
  const shutdown = line ? line.slice(0, 5) : DEFAULT_SHUTDOWN;
  return {
    version: 5,
    now: now.toISOString(),
    time_zone: tz,
    plan_day: day,
    shutdown,
    run: runOf(rows, now),
    window: { from: windowFrom(now, day, tz), to: shutdown },
    turned_down: turnedDown,
    tasks,
    blocks: rows.blocks.filter((b) => localNow(new Date(b.starts_at), tz).day === day)
      .map((b) => ({ task_id: b.task_id, starts_at: b.starts_at, ends_at: b.ends_at, proposed: b.proposed })),
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
  };
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
function clockSpan(start, end) {
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

  const planned = approved.reduce((n, b) => n + blockMinutes(b), 0) + spans.reduce((n, s) => n + s.end - s.start, 0);
  if (planned > rules.workload_cap_min) {
    errors.push(`blocks: ${hoursLabel(planned)} planned, over the ${hoursLabel(rules.workload_cap_min)} workload cap`);
  }
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
export function checkProposal(input, snapshot) {
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
    const placed = [];
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
    if (v5) dayRuleErrors(placed.map((p) => ({ ...p, name: `blocks[${p.i}]` })), snapshot, errors);
  }

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

  if (!v5) return errors.length ? { ok: false, errors, rows: null } : { ok: true, errors: [], rows: { d: day, blocks, needs, picks, note } };
  if (errors.length) return { ok: false, errors, rows: null, dropped: [] };
  // Habit blocks (H1) and suggested tasks (A1) come with their tickets.
  const { trigger: run_trigger, reasons } = snapshot.run;
  return {
    ok: true, errors: [],
    rows: { d: day, replaces, blocks, habit_blocks: [], needs, picks, note, couldnt_fit: couldntFit, suggested: [], run_trigger, reasons },
    dropped: [],
  };
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
    const title = tasks.find((t) => t.id === b.task_id)?.title ?? "A task";
    lines.push(`${formatClock(at(b.starts_at))} · ${title} (${blockMinutes(b)} min)`);
  }
  if (mine.length > SHOWN_BLOCKS) lines.push(`+${mine.length - SHOWN_BLOCKS} more`);
  if (proposal.note) lines.push(`Didn't fit: ${proposal.note}`);
  const unfit = couldntFitLine(proposal.couldnt_fit, tasks);
  if (unfit) lines.push(unfit);
  const events = pickedEvents(picks ?? proposal.picks, campus);
  // Event titles come from the campus feed, not through checkProposal; one that could become a
  // link stays off Telegram (it still shows in /plan, as text).
  for (const e of events.filter((x) => !linkish(x.title)).slice(0, SHOWN_PICKS)) lines.push(pickLine(e, tz));
  const open = needsOpen.filter((n) => !n.done).length;
  if (open) lines.push(`Mail: ${open} ${open === 1 ? "needs" : "need"} you.`);
  return lines;
}

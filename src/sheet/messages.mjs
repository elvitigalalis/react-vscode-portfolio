// Messages to Claude (docs/sheet-messages.md): plain lines Lisul types into /plan ("dentist Thu
// 3pm"), which the morning task reads and answers with tasks and events. This is their pure
// side: when the message function fires the task, what answer_messages may write, and what
// read_planner adds for them. Kept free of the network and of Node APIs so node --test covers
// it; the message and planner-mcp Edge Functions import it.
import { addDays, dayLabel, formatClock, formatSpan, localNow, minutesOn, plural, weekdayName, zonedIso } from "./logic.mjs";
import { linkish } from "./proposal.mjs";

// --- Sending (the message function) ----------------------------------------------------------

// A message fired this recently and still pending has a run on its way, which reads every
// pending message, so a new one waits for it rather than starting a second run.
export const FIRE_GAP_MS = 3 * 60_000;

// Whether to fire the task for a new message, from the pending messages ({ fired_at }) and now.
export const shouldFire = (pending, now) =>
  !pending.some((m) => m.fired_at && now.getTime() - Date.parse(m.fired_at) < FIRE_GAP_MS);

// What the message function writes on a message it fired, from fireRoutine's answer: when, the
// run's claude.ai link (/plan's "Open the run"; only Lisul can open it, signed in) and the first
// step, so /plan shows the run has started.
const claudeLink = (url) => (typeof url === "string" && url.startsWith("https://claude.ai/") ? url : null);
export const startedPatch = (out, now) => ({
  fired_at: now.toISOString(),
  session_url: claudeLink(out?.session_url),
  steps: [{ at: now.toISOString(), kind: "started", text: "Started Claude" }],
});

// A message batched onto a run fired under 3 minutes ago gets that run's link: { session_url },
// or null when there is none to give.
export function batchedPatch(pending, now) {
  const run = pending.find((m) => m.fired_at && now.getTime() - Date.parse(m.fired_at) < FIRE_GAP_MS && claudeLink(m.session_url));
  return run ? { session_url: run.session_url } : null;
}

// A message as typed or pasted ("Project 2 is due Nov 14 11:59pm, quiz on ch. 5 next Tuesday…"):
// 1 to 8000 characters, or null. Line breaks stay, since a pasted announcement's lines help
// tell its items apart; on each line runs of spaces and other control characters become one
// space, and more than one blank line in a row becomes one. It reaches only the morning task, as
// data.
export const MAX_TEXT = 8000;
export function messageText(value) {
  if (typeof value !== "string") return null;
  const t = value
    .replace(/\r\n?|[\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t && t.length <= MAX_TEXT ? t : null;
}

// --- Answering (planner-mcp's answer_messages) -----------------------------------------------

export const MAX_ANSWERS = 10;
// A pasted announcement can list a term's worth of deadlines.
export const MAX_TASKS = 20;
export const MAX_EVENTS = 10;
// Room to say what was added and what was skipped, and why.
export const MAX_REPLY = 500;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const list = (v) => (v == null ? [] : v);
// Line breaks and other control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// One free-text field, as proposal.mjs checks its own: text, one line, no link, 1 to `max`
// characters once runs of spaces are collapsed. Titles and replies reach Telegram and /plan.
function text(value, name, max, errors) {
  if (typeof value !== "string") return errors.push(`${name}: must be text`), null;
  if (CONTROL.test(value)) return errors.push(`${name}: must be one line, with no line breaks or control characters`), null;
  if (linkish(value)) return errors.push(`${name}: must not hold a link or web address`), null;
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return errors.push(`${name}: must not be empty`), null;
  if (t.length > max) return errors.push(`${name}: at most ${max} characters, got ${t.length}`), null;
  return t;
}

// An item's optional why, Claude's note for Lisul on how it placed it (/plan's How Claude decided):
// { why } when given, {} when not, checked as a title is.
const whyOf = (item, name, errors) => {
  if (item?.why == null) return {};
  const why = text(item.why, `${name}.why`, 140, errors);
  return why ? { why } : {};
};

// One task: the tasks row it becomes ({ title, day, list, due, at_time, est_min }), or null with
// errors pushed. No day puts it on the Inbox Someday list; a fixed time needs a day and a length.
function taskRow(t, name, errors) {
  const before = errors.length;
  const title = text(t?.title, `${name}.title`, 120, errors);
  const day = t?.day ?? null, due = t?.due ?? null, at = t?.at_time ?? null, est = t?.est_min ?? null;
  if (day !== null && !isDate(day)) errors.push(`${name}.day: must be a date "YYYY-MM-DD" or null`);
  if (due !== null && !isDate(due)) errors.push(`${name}.due: must be a date "YYYY-MM-DD" or null`);
  if (at !== null && (typeof at !== "string" || !HHMM.test(at))) errors.push(`${name}.at_time: must be "HH:MM", 24-hour, or null`);
  else if (at !== null && day === null) errors.push(`${name}.at_time: a fixed time needs a day`);
  if (est !== null && (!Number.isInteger(est) || est < 15 || est > 480)) errors.push(`${name}.est_min: must be 15 to 480 minutes, or null`);
  // A timed task shows its end on the day list ("7–7:20 pm"), so it always has a length.
  else if (est === null && typeof at === "string" && HHMM.test(at) && day !== null) errors.push(`${name}.est_min: a task with at_time needs est_min (15 to 480): estimate a reasonable length if none was given`);
  const why = whyOf(t, name, errors);
  if (errors.length > before) return null;
  return { title, day, list: day ? null : "Inbox", due, at_time: at, est_min: est, ...why };
}

// One event: { title, starts_at, ends_at } (ISO, UTC), or null with errors pushed. start is local
// "YYYY-MM-DDTHH:MM" in `timeZone`; the end is `minutes` later in real time, so an event across a
// daylight-saving change keeps its length. A start the clocks skip is refused.
const LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
function eventRow(e, name, timeZone, errors) {
  const before = errors.length;
  const title = text(e?.title, `${name}.title`, 120, errors);
  const m = LOCAL.exec(typeof e?.start === "string" ? e.start : "");
  let starts = null;
  if (!m || !isDate(m[1]) || !HHMM.test(m[2])) errors.push(`${name}.start: must be local "YYYY-MM-DDTHH:MM", 24-hour`);
  else {
    starts = zonedIso(m[1], toMinutes(m[2]), timeZone);
    const back = localNow(new Date(starts), timeZone);
    if (back.day !== m[1] || back.minutes !== toMinutes(m[2])) {
      errors.push(`${name}.start: ${m[2]} doesn't happen on ${m[1]} in ${timeZone} (the clocks skip it)`);
    }
  }
  const { minutes } = e ?? {};
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720) errors.push(`${name}.minutes: must be 15 to 720`);
  const why = whyOf(e, name, errors);
  if (errors.length > before) return null;
  return { title, starts_at: starts, ends_at: new Date(Date.parse(starts) + minutes * 60_000).toISOString(), ...why };
}

// A list field of at most `max` items, or [] with an error pushed.
function many(value, name, max, errors) {
  const items = list(value);
  if (!Array.isArray(items)) return errors.push(`${name}: must be a list`), [];
  if (items.length > max) return errors.push(`${name}: at most ${max}, got ${items.length}`), [];
  return items;
}

// The checks answer_messages runs on `input` ({ answers: [{ id, tasks, events, reply }] })
// against the pending messages ({ id }), with local times in `timeZone`. Each problem is its own
// error, naming its field, and makes only its own answer fail: `answers` holds the others,
// shaped for answer_message (supabase/schema.sql), with events as { title, starts_at, ends_at }.
export function checkAnswers(input, pending, timeZone) {
  const errors = [];
  const answers = [];
  const items = list(input?.answers);
  if (!Array.isArray(items)) return { errors: ["answers: must be a list"], answers };
  if (items.length > MAX_ANSWERS) return { errors: [`answers: at most ${MAX_ANSWERS}, got ${items.length}`], answers };
  const open = new Set(pending.map((m) => m.id));
  const seen = new Set();
  items.forEach((a, i) => {
    const name = `answers[${i}]`;
    const before = errors.length;
    if (!open.has(a?.id)) errors.push(`${name}.id: not a pending message (already answered, or not one read_planner gave)`);
    else if (seen.has(a.id)) errors.push(`${name}.id: that message is already answered above`);
    seen.add(a?.id);
    const tasks = many(a?.tasks, `${name}.tasks`, MAX_TASKS, errors).map((t, j) => taskRow(t, `${name}.tasks[${j}]`, errors));
    const events = many(a?.events, `${name}.events`, MAX_EVENTS, errors).map((e, j) => eventRow(e, `${name}.events[${j}]`, timeZone, errors));
    const reply = text(a?.reply, `${name}.reply`, MAX_REPLY, errors);
    if (errors.length === before) answers.push({ id: a.id, tasks, events, reply });
  });
  return { errors, answers };
}

// --- Steps (planner-mcp's report_step) -------------------------------------------------------

// What /plan shows while Claude works on a message: steps the server logs itself (started,
// reading, saving) and up to a few the run reports. Each message keeps at most 12
// (add_message_step in supabase/schema.sql).
export const STEP_KINDS = ["reading", "checking", "searching", "adding", "done"];
export const MAX_STEPS = 12;

// A reported step ({ kind, text }): { step } or { error }. text is one line, no link, at most 120.
export function checkStep(input) {
  if (!STEP_KINDS.includes(input?.kind)) return { error: `kind: must be ${STEP_KINDS.slice(0, -1).join(", ")} or ${STEP_KINDS.at(-1)}` };
  const errors = [];
  const t = text(input?.text, "text", 120, errors);
  return errors.length ? { error: errors[0] } : { step: { kind: input.kind, text: t } };
}

// The ids of the messages a step is for: the named ones still pending, or every pending one.
export const stepTargets = (pending, ids) =>
  ids == null ? pending.map((m) => m.id) : ids.filter((id) => pending.some((m) => m.id === id));

// --- Reading (planner-mcp's read_planner) ----------------------------------------------------

export const MAX_READ = 10;
// The most message text one read gives, so a few long pastes don't swamp the run. Past it the
// oldest wait for the next run (by then the newer ones are answered); one is always given.
export const READ_BUDGET = 20_000;
// A run starts within seconds of its fire; a fired message older than this that is still pending
// was missed (or rate limited), and the next run of any kind answers it.
const MESSAGE_FRESH = 10 * 60_000;

// What read_planner adds to planSnapshot for messages, from the pending messages rows ({ id, at,
// text, fired_at }) and the settings row: today (Lisul's date, which plan_day is not after 3 pm),
// replans_on, and the pending messages, oldest first and at most 10, as { id, at, text }, within
// READ_BUDGET characters, with messages_held, how many pending ones wait for a later run. A
// message fired under 10 minutes ago and still pending makes a morning run a "message" run; a
// replan stays a replan.
export function withMessages(snapshot, rows, settings, now) {
  const pending = list(rows).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const fresh = pending.some((m) => m.fired_at && now.getTime() - Date.parse(m.fired_at) < MESSAGE_FRESH);
  const messages = pending.slice(0, MAX_READ).map((m) => ({ id: m.id, at: m.at, text: m.text }));
  let size = messages.reduce((n, m) => n + m.text.length, 0);
  while (messages.length > 1 && size > READ_BUDGET) size -= messages.shift().text.length;
  const run = fresh && snapshot.run?.trigger === "morning" ? { ...snapshot.run, trigger: "message" } : snapshot.run;
  return {
    ...snapshot,
    run,
    today: localNow(now, snapshot.time_zone).day,
    replans_on: Boolean(settings?.replans_on),
    messages,
    messages_held: pending.length - messages.length,
  };
}

// The run_trigger a revision is recorded with: proposals hold morning or replan, and a revision
// a message run goes on to submit is a replan of today.
export const proposalTrigger = (trigger) => (trigger === "message" ? "replan" : trigger);

// --- /plan -------------------------------------------------------------------------------------

// "Added: 2 tasks, 1 event" under an answered message's reply; "Nothing added" for a failed one,
// and "All undone" for one whose items were all undone.
export function addedLine(m) {
  if (m.status === "failed") return "Nothing added";
  if (m.status !== "done") return "";
  const parts = [m.tasks_added && plural(m.tasks_added, "task"), list(m.events).length && plural(m.events.length, "event")].filter(Boolean);
  return parts.length ? `Added: ${parts.join(", ")}` : "All undone";
}

// Where a message stands, from its row, the other rows /plan has (a batched message rides on
// another's run) and now: { key, words }. Sending is /plan's own, before there is a row.
export function messageState(m, rows, now) {
  if (m.status === "done") return { key: "added", words: addedLine(m) };
  if (m.status === "failed") return { key: "unparsed", words: "Couldn't parse it: nothing added" };
  const fresh = (r) => r.status === "pending" && r.fired_at && now.getTime() - Date.parse(r.fired_at) < MESSAGE_FRESH;
  if (fresh(m) || list(rows).some(fresh)) return { key: "reading", words: "Claude is reading…" };
  return { key: "queued", words: "Queued: Claude is busy, so this runs with the next plan." };
}

// "Tue Nov 10".
const shortDay = (day) => `${weekdayName(day)} ${dayLabel(day).date}`;

// What an answered message added, one line each, to-dos first: { id, kind, title, when }, with
// a to-do's day (or Inbox), fixed time and due date, and an event's day and times. id is what
// undo_message_item takes; an event from before events had ids has none.
export function itemLines(m, timeZone) {
  const tasks = list(m.tasks).map((t) => ({
    id: t.id, kind: "task", title: t.title, why: t.why ?? null,
    when: [
      t.day ? `${shortDay(t.day)}${t.at_time ? `, ${formatClock(Number(t.at_time.slice(0, 2)) * 60 + Number(t.at_time.slice(3, 5)))}` : ""}` : (t.list ?? "Inbox"),
      t.due && `due ${shortDay(t.due)}`,
    ].filter(Boolean).join(" · "),
  }));
  const events = list(m.events).map((e) => {
    const day = localNow(new Date(e.starts_at), timeZone).day;
    return { id: e.id ?? null, kind: "event", title: e.title, why: e.why ?? null, when: `${shortDay(day)}, ${formatSpan(minutesOn(e.starts_at, day, timeZone), minutesOn(e.ends_at, day, timeZone))}` };
  });
  return [...tasks, ...events];
}

// --- Claude's progress (/plan) ---------------------------------------------------------------

const SHOWN_STEPS = 5;
const NOT_STARTED_MS = 45_000;
const QUIET_MS = 90_000;
const seconds = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const took = (s) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`);

// The run's steps on message m ({ status, fired_at, answered_at, steps: [{ at, kind, text }] }), at
// now. While pending: { running: true, elapsed ("0:34" since the fire, or null for a message
// riding on another's run), the last 5 steps with the newest current, note } where note says the
// run hasn't started after 45 s, has been quiet for 90 s, or is another message's. Once answered:
// { running: false, summary: "4 steps · 52 s", steps }, or null with no steps.
export function progress(m, now) {
  const steps = list(m.steps);
  if (m.status !== "pending") {
    if (!steps.length) return null;
    const end = m.answered_at ?? steps.at(-1).at;
    return {
      running: false,
      summary: `${plural(steps.length, "step")}${m.fired_at ? ` · ${took(seconds(m.fired_at, end))}` : ""}`,
      steps: steps.map((x) => ({ text: x.text, done: true })),
    };
  }
  const nowIso = now.toISOString();
  const last = steps.at(-1);
  let note = null;
  if (!m.fired_at && !steps.length) note = "Waiting for the run that's already going…";
  else if (steps.every((x) => x.kind === "started") && m.fired_at && seconds(m.fired_at, nowIso) * 1000 >= NOT_STARTED_MS) {
    note = "Claude hasn't started yet. Cloud runs can take a minute to start.";
  } else if (last && last.kind !== "started" && seconds(last.at, nowIso) * 1000 >= QUIET_MS) note = `Still working on \u201c${last.text}\u201d…`;
  return {
    running: true,
    elapsed: m.fired_at ? clock(seconds(m.fired_at, nowIso)) : null,
    note,
    steps: steps.slice(-SHOWN_STEPS).map((x, i, all) => ({ text: x.text, done: i < all.length - 1 })),
  };
}

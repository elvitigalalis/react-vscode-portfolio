// The Telegram messages (docs/sheet-nudges.md, "Messages"): which are due at a given minute, and
// what a Done or Snooze tap on one changes.
// Kept free of the network so node --test covers it; the `telegram` Edge Function
// (supabase/functions/telegram) imports it, so the rules live only here.
//
// Nothing is booked ahead: each run works the messages out again from a snapshot of the day,
// and the nudges log is what stops one going out twice.
import { ORIGIN, SHEET } from "../site.mjs";
import { couldntFitLine, linkish, proposalLines } from "./proposal.mjs";
import { weatherLine } from "./sources.mjs";
import { addDays, localNow, zonedIso, minutesOn, atRisk, dueLabel, formatClock, telegramOn, blockOnComplete, blockMinutes, plural, proposedOn } from "./logic.mjs";
import { paceKind } from "./pace.mjs";
import { reasonWords } from "./replan.mjs";

// Quiet hours run from 11 pm to 8 am; the brief opens the day.
export const QUIET_FROM = 23 * 60;
export const BRIEF_AT = 8 * 60;
// The latest a check-in goes out, for a shutdown line at 11 pm or later.
export const CHECKIN_LATEST = QUIET_FROM - 5;
// The nudge budget: nudges, repeats and snoozes a day, not counting the brief or the check-in.
export const BUDGET = 6;
// The repeat follows a nudge Lisul hasn't acted on by this long after.
export const REPEAT_AFTER = 10 * 60_000;
// A Snooze tap logs the nudge again for this long after the tap, unsent: { block_id,
// kind: "snooze", day, send_at, sent_at: null }. That row is all whatToSend needs to send it.
export const SNOOZE_FOR = 10 * 60_000;
// v5: a late run still sends a Finished? check this long after its block's end (docs/sheet-v5.md).
export const FINISHED_LATE = 30 * 60_000;
// More time adds this much to a block.
export const MORE_TIME = 30 * 60_000;
// v5 R1: replan messages a day, outside the budget, and the + and − lines each shows.
export const REPLANS_SENT_MAX = 4;
const REPLAN_LINES = 6;

const PLAN_URL = `${ORIGIN}/plan/`;

// A snapshot of the day, as the Edge Function reads it:
//   settings  the settings row (time_zone, telegram_chat_id, nudges_on, morning_on)
//   day       today's days row, or null
//   tasks     today's tasks, plus every undone task with a due date
//   blocks    today's blocks (proposed ones too), plus every block of those tasks
//   log       today's rows of the nudges log, including snoozes logged by taps and not yet sent
//   proposal  today's proposals row, or null (for a plan tap, the tapped day's)
//   needsOpen the needs_you rows not done
//   campus    the campus_events rows today's proposal picks
// The last three came with the morning plan (docs/sheet-morning.md); a snapshot without them
// reads as none.
// v5 R1: previous   the revision before `proposal` that day ({ status, blocks }), or null
//         replanSent how many replan messages went out today
// Returns the messages due at `now`: { kind, block_id, day, send_at, text, buttons }, where
// send_at is the minute the message belongs to (it may be earlier than `now` if a run was late)
// and a button has either a url or callback data ("done:<block id>", "snooze:<block id>").
export function whatToSend(snapshot, now) {
  if (!telegramOn(snapshot.settings)) return [];
  const day = dayOf(snapshot, now);
  if (day.minutes < BRIEF_AT || day.minutes >= QUIET_FROM) return [];
  // Each kind of message is one rule over the same day.
  const due = [brief(day), ...planMessage(day), ...replanMessage(day), ...starts(day), ...repeats(day), ...snoozes(day), ...finishedChecks(day), ...checkin(day)]
    .filter((m) => Date.parse(m.send_at) <= now.getTime() && !logged(snapshot.log, m))
    .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  // The brief and check-in are outside the budget, and a snooze took its slot when it was tapped.
  let { kept, used, held } = budget(day);
  return due.filter((m) => {
    if (!BUDGETED.includes(m.kind) || m.kind === "snooze") return true;
    if (m.kind === "start" && kept.has(m.block_id)) held--;
    if (used + held >= BUDGET) return false;
    used++;
    return true;
  });
}

// The day as the rules see it. Proposed blocks aren't part of the plan until approved: they
// count for nothing here.
function dayOf(snapshot, now) {
  const tz = snapshot.settings.time_zone;
  const { day: today, minutes } = localNow(now, tz);
  // A snapshot from before the morning plan has none of its fields: no proposal, no open mail.
  // They do count for the morning plan, while today's proposal is pending.
  const needsOpen = (snapshot.needsOpen ?? []).filter((n) => !n.done);
  const p = snapshot.proposal;
  const plan = p?.day === today && p.status === "pending"
    ? proposalLines(p, proposedOn(snapshot.blocks, today, tz), snapshot.tasks, needsOpen, p.picks ?? [], snapshot.campus ?? [], tz)
    : null;
  return { ...snapshot, blocks: snapshot.blocks.filter((b) => !b.proposed), needsOpen, plan, today, minutes, tz, now: now.getTime() };
}

const BUDGETED = ["start", "repeat", "snooze", "finished"];

// The budget, kept predictable: the nudges at the start of the day's first six blocks that can
// be nudged are kept for them, and repeats, snoozes and later blocks' nudges get only the slots
// left. Returns the blocks whose nudges are kept, the slots used (sent, or a snooze waiting) and
// the slots held for kept nudges still to go out.
function budget(day) {
  const kept = new Set(live(day).slice(0, BUDGET).map(({ b }) => b.id));
  const used = day.log.filter((n) => BUDGETED.includes(n.kind)).length;
  const held = running(day).filter(({ b }) => kept.has(b.id) && !startSent(day.log, b)).length;
  return { kept, used, held };
}
const freeSlots = (day) => { const { used, held } = budget(day); return BUDGET - used - held; };

// A snooze logged by a tap and not yet sent (see SNOOZE_FOR).
const pending = (n) => n.kind === "snooze" && !n.sent_at;

// One message per block, kind, day and send-at minute: the log's unique key.
const logged = (log, m) => log.some((n) => !pending(n) && n.block_id === m.block_id && n.kind === m.kind && n.day === m.day
  && Date.parse(n.send_at) === Date.parse(m.send_at));

// The morning brief: what today holds, at 8:00. Private tasks show their real titles: the
// messages go only to Lisul.
// "Nudging the first 6" counts only the blocks that can be nudged.
// With today's proposal pending, the brief carries it and its buttons; with the morning task set
// up and no proposal for today, it says the run didn't come in.
function brief(day) {
  const { tasks, blocks, today, tz, plan } = day;
  const todays = tasks.filter((t) => t.day === today);
  const blocksToday = blocks.filter((b) => { const m = minutesOn(b.starts_at, today, tz); return m >= 0 && m < 1440; });
  const risky = tasks.filter((t) => atRisk(t, blocks, today, tz)).sort((a, b) => a.due.localeCompare(b.due));
  const n = blocksToday.length;
  const lines = [`Today: ${plural(todays.length, "task")}, ${plural(n, "block")}${live(day).length > BUDGET ? `, nudging the first ${BUDGET}` : ""}.`];
  if (risky.length) lines.push(`At risk: ${risky.map((t) => `${t.title} (${dueLabel(t.due, today)})`).join(", ")}.`);
  // v5 W1: the weather line, when the cache has a forecast (snapshot.weather, the weather_cache row).
  const wx = day.weather?.periods?.length ? weatherLine(day.weather.periods, day.weather.alerts ?? [], today, tz) : null;
  if (wx) lines.push(wx);
  // v5 SRC3: today's academic calendar entries (snapshot.academic, from academicEntries), at most 3.
  const cal = academicLine(day.academic);
  if (cal) lines.push(cal);
  const send_at = zonedIso(today, BRIEF_AT, tz);
  // v5 M1: who he's waiting on, after the plan's lines.
  const waiting = awaitingLine(day.awaiting);
  if (plan) return { kind: "brief", block_id: null, day: today, send_at, text: [...lines, ...plan, waiting].filter(Boolean).join("\n"), buttons: planButtons(today, day.proposal?.rev) };
  const missed = day.settings.morning_on && day.proposal?.day !== today;
  const empty = 'No morning plan came in today: say "plan my day" to Claude.';
  if (!n) lines.push(missed ? empty : 'Nothing planned yet: say "plan my day" to Claude.');
  const text = (todays.length || n || risky.length ? [...lines, waiting]
    : ["Nothing on today.", wx, cal, missed && empty, waiting]).filter(Boolean).join("\n");
  return { kind: "brief", block_id: null, day: today, send_at, text, buttons: [{ text: "Open /plan", url: PLAN_URL }] };
}

// "Calendar: No classes, Last day to withdraw.", or null with no entries. The titles were cut and
// checked by academicEntries; linkish runs again, as for any outside text bound for Telegram.
const MAX_ACADEMIC = 3;
function academicLine(entries) {
  const titles = (entries ?? []).map((e) => String(e.title ?? "").replace(/\s+/g, " ").trim())
    .filter((t) => t && !linkish(t)).slice(0, MAX_ACADEMIC);
  return titles.length ? `Calendar: ${titles.join(", ")}.` : null;
}

// v5 M1: "Awaiting reply: 2 (Ana Ruiz, Prof. Kim).", or null with none. rows are the reply_state
// rows with state awaiting; every one counts, and at most 3 names show, each cut to 30. `who` is a
// display name from a mail header, so linkish runs on it, and a name it refuses is left out.
const MAX_AWAITING = 3;
function awaitingLine(rows) {
  if (!rows?.length) return null;
  const names = rows.map((r) => String(r.who ?? "").replace(/\s+/g, " ").trim().slice(0, 30).trim())
    .filter((w) => w && !w.includes("@") && !linkish(w)).slice(0, MAX_AWAITING);
  return `Awaiting reply: ${rows.length}${names.length ? ` (${names.join(", ")})` : ""}.`;
}

// Approve all and Skip carry the plan's day, and its revision when it has one (v5,
// docs/sheet-v5.md), so a tap acts on the plan it showed; the webhook reads them back on a tap.
const planButtons = (d, rev) => {
  const r = rev == null ? "" : `:${rev}`;
  return [{ text: "Approve all", callback_data: `pa:${d}${r}` }, { text: "Open /plan", url: PLAN_URL }, { text: "Skip", callback_data: `ps:${d}${r}` }];
};

// The plan on its own, when today's proposal is pending and the brief went out before it was
// made: once per created_at (a resubmission is sent again). Outside the budget, like the brief.
// v5: only for a morning revision; a replan revision gets the replan message.
function planMessage({ plan, proposal, log, today }) {
  if (!plan || proposal.run_trigger === "replan") return [];
  const made = Date.parse(proposal.created_at);
  const briefOut = log.some((n) => n.kind === "brief" && n.day === today && n.sent_at && Date.parse(n.sent_at) < made);
  if (!briefOut) return [];
  return [{ kind: "proposal", block_id: null, day: today, send_at: new Date(made).toISOString(), text: plan.join("\n"), buttons: planButtons(today, proposal.rev) }];
}

// --- The replan message (v5 R1, docs/sheet-v5.md "The replan message") ----------------------
// For a pending replan revision whose proposed blocks differ from what Lisul last saw: the
// previous revision's when it was still pending (superseded by now), or none when it was
// approved (its blocks are locked on his timeline) or there is none. Once per revision, at
// most REPLANS_SENT_MAX a day (snapshot.replanSent), outside the budget.
const spanKey = (b) => `${b.task_id ?? ""}|${b.habit_id ?? ""}|${Date.parse(b.starts_at)}|${Date.parse(b.ends_at)}`;
function replanMessage(day) {
  const p = day.proposal;
  if (p?.day !== day.today || p.status !== "pending" || p.run_trigger !== "replan") return [];
  if ((day.replanSent ?? 0) >= REPLANS_SENT_MAX) return [];
  const before = day.previous?.status === "superseded" ? day.previous.blocks ?? [] : [];
  const now = p.blocks ?? [];
  const minus = (a, b) => { const keys = new Set(b.map(spanKey)); return a.filter((x) => !keys.has(spanKey(x))); };
  const earliest = (list) => [...list].sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)).slice(0, REPLAN_LINES);
  const added = earliest(minus(now, before)), gone = earliest(minus(before, now));
  if (!added.length && !gone.length) return [];
  const title = (b) => day.tasks.find((t) => t.id === b.task_id)?.title ?? (day.habits ?? []).find((h) => h.id === b.habit_id)?.name ?? "A task";
  const at = (b) => formatClock(minutesOn(b.starts_at, day.today, day.tz));
  const words = reasonWords(p.reasons ?? []);
  const lines = [
    words ? `Replan: ${words}.` : "Replan: the plan changed.",
    ...added.map((b) => `+ ${at(b)} · ${title(b)} (${blockMinutes(b)} min)`),
    ...gone.map((b) => `− ${at(b)} · ${title(b)}`),
  ];
  const unfit = couldntFitLine(p.couldnt_fit, day.tasks);
  if (unfit) lines.push(unfit);
  return [{ kind: "replan", block_id: null, day: day.today, send_at: new Date(p.created_at).toISOString(), text: lines.join("\n"), buttons: planButtons(day.today, p.rev) }];
}

// Done and Snooze carry the block they belong to; the webhook reads them back on a tap.
const tapButtons = (id) => [{ text: "Done", callback_data: `done:${id}` }, { text: "Snooze 10 min", callback_data: `snooze:${id}` }];

// "▶ 2:00 pm · OS homework (45 min)"
const nudgeText = (b, task, { today, tz }) =>
  `▶ ${formatClock(minutesOn(b.starts_at, today, tz))} · ${task.title} (${blockMinutes(b)} min)`;

// The blocks that can still be nudged, with their tasks: today's, starting outside quiet hours
// (so a block before 8 am never gets one), whose task isn't done; earliest first.
const live = ({ blocks, tasks, today, tz }) => [...blocks].sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at)).flatMap((b) => {
  const start = minutesOn(b.starts_at, today, tz);
  const task = tasks.find((t) => t.id === b.task_id);
  return start >= BRIEF_AT && start < QUIET_FROM && task && !task.done ? [{ b, task }] : [];
});

// A late run still sends a block's nudge or repeat while the block is on; once it's over, they
// are no use.
const running = (day) => live(day).filter(({ b }) => day.now < Date.parse(b.ends_at));

// A nudge at the start of each of today's blocks.
function starts(day) {
  return running(day).map(({ b, task }) => {
    return { kind: "start", block_id: b.id, day: day.today, send_at: new Date(b.starts_at).toISOString(), text: nudgeText(b, task, day), buttons: tapButtons(b.id) };
  });
}

// Whether the nudge at a block's start (at its current start) is in the log.
const startSent = (log, b) => log.some((n) => n.block_id === b.id && n.kind === "start" && Date.parse(n.send_at) === Date.parse(b.starts_at));

// One repeat per nudge that went out, ten minutes after it.
function repeats(day) {
  return running(day).flatMap(({ b, task }) => {
    if (!startSent(day.log, b)) return [];
    // A snooze takes the repeat's place.
    if (day.log.some((n) => n.block_id === b.id && n.kind === "snooze")) return [];
    return [{ kind: "repeat", block_id: b.id, day: day.today, send_at: new Date(Date.parse(b.starts_at) + REPEAT_AFTER).toISOString(), text: `Still on: ${task.title}`, buttons: tapButtons(b.id) }];
  });
}

// The snoozed nudges, as their taps logged them: the nudge again, in the repeat's place.
function snoozes(day) {
  return live(day).flatMap(({ b, task }) => day.log.filter((n) => n.block_id === b.id && pending(n))
    .map((n) => ({ kind: "snooze", block_id: b.id, day: day.today, send_at: new Date(n.send_at).toISOString(), text: nudgeText(b, task, day), buttons: tapButtons(b.id) })));
}

// --- Finished? (v5, docs/sheet-v5.md "The Finished? check") ----------------------------------

const finishedButtons = (id) => [
  { text: "Finished", callback_data: `finished:${id}` },
  { text: "More time", callback_data: `more:${id}` },
  { text: "Didn't start", callback_data: `nostart:${id}` },
  { text: "Tomorrow", callback_data: `tomorrow:${id}` },
];

// At the end of each of today's blocks that was nudged, asking how it went: while its task is
// open, the day isn't shut down and the end is before quiet hours. Up to FINISHED_LATE late, once
// per end (More time moves the end, so it asks again). It takes a budget slot, like a repeat.
function finishedChecks(day) {
  if (day.day?.shutdown) return [];
  return day.blocks.flatMap((b) => {
    const start = minutesOn(b.starts_at, day.today, day.tz);
    const end = Date.parse(b.ends_at);
    const task = day.tasks.find((t) => t.id === b.task_id);
    if (start < 0 || start >= 1440 || !task || task.done || !startSent(day.log, b)) return [];
    if (minutesOn(b.ends_at, day.today, day.tz) >= QUIET_FROM || day.now >= end + FINISHED_LATE) return [];
    return [{ kind: "finished", block_id: b.id, day: day.today, send_at: new Date(end).toISOString(), text: `Finished? · ${task.title}`, buttons: finishedButtons(b.id) }];
  });
}

// The check-in: at the day's shutdown line (the default unless he moved it), asking for the
// shutdown. Once the day is shut down, or on a day with no tasks, there's nothing to ask.
// It also says what's due tomorrow and how many Needs you rows, mail and Slack, are
// still open (docs/sheet-morning.md).
function checkin({ tasks, day: row, today, tz, needsOpen }) {
  const todays = tasks.filter((t) => t.day === today);
  if (row?.shutdown || !todays.length) return [];
  const [h, m] = (row?.shutdown_at ?? SHEET.shutdownAt).split(":").map(Number);
  // A shutdown line in quiet hours still gets its check-in, just before them.
  const at = Math.min(h * 60 + m, CHECKIN_LATEST);
  const done = todays.filter((t) => t.done).length;
  const lines = [`Shutdown time. ${done} done, ${todays.length - done} left.`];
  const tomorrow = tasks.filter((t) => !t.done && t.due === addDays(today, 1));
  if (tomorrow.length) lines.push(`Tomorrow: ${tomorrow.length} due (${tomorrow.slice(0, 3).map((t) => t.title.slice(0, 30).trim()).join(", ")}).`);
  if (needsOpen.length) lines.push(`Needs you: ${needsOpen.length}.`);
  return [{ kind: "checkin", block_id: null, day: today, send_at: zonedIso(today, at, tz), text: lines.join("\n"), buttons: [{ text: "Open /plan", url: PLAN_URL }] }];
}

// --- Taps ----------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A Telegram update, read as a tap on a nudge's Done or Snooze:
//   { action: "done" | "snooze", block_id, query_id, chat_id, message_id }
// or on a Finished? check's four buttons, the same with action "finished" | "more" | "nostart" |
// "tomorrow" (v5)
// or on a plan's Approve all or Skip ("pa:<day>:<rev>", or v4's "pa:<day>" with no rev):
//   { action: "pa" | "ps", day, rev?, query_id, chat_id, message_id }
// or null for anything else, which the webhook ignores without a word: any other update, a chat
// that isn't Lisul's, or callback data that isn't "done:" or "snooze:" and a block's UUID, or
// "pa:" or "ps:" and a plain date.
export function readTap(update, settings) {
  const q = update.callback_query;
  if (!q?.message || String(q.message.chat.id) !== String(settings.telegram_chat_id)) return null;
  const from = { query_id: q.id, chat_id: q.message.chat.id, message_id: q.message.message_id };
  // v5: an optional revision after the day, 1-999 with no leading zeros.
  const [, plan, day, rev] = /^(pa|ps):([^:]+)(?::([1-9]\d{0,2}))?$/.exec(q.data ?? "") ?? [];
  if (plan) return DATE.test(day) ? { action: plan, day, ...(rev ? { rev: Number(rev) } : {}), ...from } : null;
  const [, action, block_id] = /^(done|snooze|finished|more|nostart|tomorrow):(.+)$/.exec(q.data ?? "") ?? [];
  if (!action || !UUID.test(block_id)) return null;
  return { action, block_id, ...from };
}

// A plan tap names its day, not a block.
export const planTap = (tap) => tap.action === "pa" || tap.action === "ps";

// A nudge from an earlier day can name a block outside today's snapshot. The webhook then adds
// that block, its task's other blocks and its task before handleTap runs.
export const needsTappedBlock = (snapshot, tap) => !planTap(tap) && !snapshot.blocks.some((b) => b.id === tap.block_id);

const DONE = "✓ Done";
const GONE = "That block is no longer on the plan.";

// A tap on a nudge's Done or Snooze, { action: "done" | "snooze", block_id }, at `now`, against
// the same snapshot whatToSend takes. Returns the changes for the Edge Function to make and the
// tapped message's new text:
//   { table, insert: row } | { table, id, update: fields } | { table, id, delete: true }
//   | { rpc, args }   (v5: a database function, called through PostgREST)
// Telegram can't edit Google Calendar, so a block whose event changes leaves a gcal_pending row
// ({ gcal_id, ends_at }, ends_at null for a deleted event) for /plan to apply when it opens.
//
// Approve all and Skip ({ action: "pa" | "ps", day }) act on that day's proposal, which the
// snapshot's `proposal` is for a plan tap (see planDecision).
export function handleTap(tap, snapshot, now) {
  if (planTap(tap)) return planDecision(tap, snapshot);
  const b = snapshot.blocks.find((x) => x.id === tap.block_id);
  const task = b && snapshot.tasks.find((t) => t.id === b.task_id);
  // A block deleted or moved off the plan since its nudge went out: nothing left to act on.
  if (!task) return { changes: [], text: GONE };
  if (task.done) return { changes: [], text: DONE };
  if (FINISHED_ANSWERS[tap.action]) return FINISHED_ANSWERS[tap.action](b, task, snapshot, now);
  return tap.action === "snooze" ? snooze(b, task, snapshot, now) : done(task, snapshot, now);
}

// Snooze logs the nudge again, unsent, for ten minutes on (from the tap's minute, so a repeated
// tap meets the log's unique key); whatToSend sends it in the repeat's place. It takes a budget
// slot now, so with none free it is refused, and the message says so; so is one that would come
// back in quiet hours, when it could never be sent.
function snooze(b, task, snapshot, now) {
  const day = dayOf(snapshot, now);
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const send_at = new Date(minute + SNOOZE_FOR).toISOString();
  if (minutesOn(send_at, day.today, day.tz) >= QUIET_FROM) return { changes: [], text: `Too close to quiet hours · ${task.title}` };
  if (freeSlots(day) <= 0) return { changes: [], text: `No nudges left today · ${task.title}` };
  const row = { block_id: b.id, kind: "snooze", day: day.today, send_at, sent_at: null };
  return { changes: [{ table: "nudges", insert: row }], text: `Snoozed until ${formatClock(minutesOn(send_at, day.today, day.tz))} · ${task.title}` };
}

// Done marks the task done and applies the block rules to each of its blocks, as /plan does.
function done(task, { blocks }, now) {
  const changes = blocks.filter((b) => b.task_id === task.id).flatMap((b) => {
    const r = blockOnComplete(b, now);
    if (r.action === "keep") return [];
    const ends_at = r.action === "shrink" ? r.ends_at : null;
    const pending = b.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: b.gcal_id, ends_at } }] : [];
    return [r.action === "shrink" ? { table: "blocks", id: b.id, update: { ends_at } } : { table: "blocks", id: b.id, delete: true }, ...pending];
  });
  return { changes: [...changes, { table: "tasks", id: task.id, update: { done: true } }], text: DONE };
}

// Approve all clears `proposed` on the day's blocks still proposed, and Skip deletes them; either
// way the proposal is decided. Blocks approved or turned down in /plan since are left as they
// are. Approved blocks get their Google events when /plan next opens (googleStep). A proposal
// already decided, lapsed or gone changes nothing.
// v5 (docs/sheet-v5.md): a proposal with a `rev` is the day's newest revision. A tap on an older
// one (a v4 button counts as revision 1) changes nothing, and the current one is decided by
// approve_proposal or skip_proposal, which refuse it again if it moved on in the meantime.
function planDecision(tap, { proposal, blocks, settings }) {
  if (proposal?.day !== tap.day || proposal.status === "lapsed") return { changes: [], text: "That plan has lapsed" };
  if (proposal.rev != null && (tap.rev ?? 1) < proposal.rev) return { changes: [], text: "A newer plan is out" };
  if (proposal.status !== "pending") return { changes: [], text: `Already ${proposal.status}` };
  const left = proposedOn(blocks, tap.day, settings.time_zone);
  const approve = tap.action === "pa";
  if (proposal.rev != null) {
    const args = { d: tap.day, rev: proposal.rev };
    return approve
      ? { changes: [{ rpc: "approve_proposal", args }], text: `✓ Approved ${plural(left.length, "block")}` }
      : { changes: [{ rpc: "skip_proposal", args }], text: "Skipped. Plan in /plan when you're ready." };
  }
  const changes = left.map((b) => (approve ? { table: "blocks", id: b.id, update: { proposed: false } } : { table: "blocks", id: b.id, delete: true }));
  changes.push({ table: "proposals", id: tap.day, update: { status: approve ? "approved" : "skipped" } });
  return { changes, text: approve ? `✓ Approved ${plural(left.length, "block")}` : "Skipped. Plan in /plan when you're ready." };
}

// --- The Finished? answers (v5, docs/sheet-v5.md "The Finished? answers") ------------------
// Only Finished writes actuals, which is what pace learns from (src/sheet/pace.mjs).

const FINISHED_ANSWERS = {
  // Done, plus the minutes it took: every approved block of the task that started before now,
  // up to the earlier of its end and now.
  finished(b, task, snapshot, now) {
    const t = now.getTime();
    const ms = snapshot.blocks.filter((x) => x.task_id === task.id && !x.proposed && Date.parse(x.starts_at) < t)
      .reduce((sum, x) => sum + Math.min(Date.parse(x.ends_at), t) - Date.parse(x.starts_at), 0);
    // actuals holds 1–960 minutes; a tap before any time passed records none.
    const minutes = Math.min(Math.round(ms / 60_000), 960);
    const { changes } = done(task, snapshot, now);
    if (minutes < 1) return { changes, text: DONE };
    const row = { day: localNow(now, snapshot.settings.time_zone).day, task_id: task.id, block_id: b.id, kind: paceKind(task), est_min: task.est_min ?? null, minutes };
    return { changes: [...changes, { table: "actuals", insert: row }], text: `✓ Done in ${minutes} min · ${task.title}` };
  },
  // Thirty minutes more, when nothing approved or busy takes them and they end by quiet hours.
  // Proposed blocks don't count as taken. The next Finished? follows at the new end.
  more(b, task, snapshot) {
    const tz = snapshot.settings.time_zone;
    const from = Date.parse(b.ends_at);
    const to = from + MORE_TIME;
    const ends_at = new Date(to).toISOString();
    const on = localNow(new Date(b.starts_at), tz).day;
    if (minutesOn(ends_at, on, tz) > QUIET_FROM) return { changes: [], text: `Too close to quiet hours · ${task.title}` };
    const taken = [...(snapshot.busy ?? []), ...snapshot.blocks.filter((x) => x.id !== b.id && !x.proposed)]
      .some((x) => Date.parse(x.starts_at) < to && Date.parse(x.ends_at) > from);
    if (taken) return { changes: [], text: `The next 30 min aren't free · ${task.title}` };
    const pending = b.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: b.gcal_id, ends_at } }] : [];
    return { changes: [{ table: "blocks", id: b.id, update: { ends_at } }, ...pending], text: `More time: until ${formatClock(minutesOn(ends_at, on, tz))} · ${task.title}` };
  },
  nostart: (b, task) => ({ changes: [], text: `Left open · ${task.title}` }),
  // The task's blocks today that haven't started go (proposed ones too). A task on a day with no
  // set time rolls, as the nightly roll would; any other task moves onto tomorrow.
  tomorrow(b, task, snapshot, now) {
    const tz = snapshot.settings.time_zone;
    const { day: today } = localNow(now, tz);
    const tomorrow = addDays(today, 1);
    const changes = snapshot.blocks.filter((x) => x.task_id === task.id && Date.parse(x.starts_at) > now.getTime()
      && localNow(new Date(x.starts_at), tz).day === today).flatMap((x) => [
      { table: "blocks", id: x.id, delete: true },
      ...(x.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: x.gcal_id, ends_at: null } }] : []),
    ]);
    changes.push(task.day && !task.at_time
      ? { rpc: "roll_tasks", args: { ids: [task.id], target: tomorrow } }
      : { table: "tasks", id: task.id, update: { day: tomorrow, list: null } });
    return { changes, text: `Moved to tomorrow · ${task.title}` };
  },
};

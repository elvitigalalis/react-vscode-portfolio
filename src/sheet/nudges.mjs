// The Telegram messages (docs/sheet-nudges.md, "Messages"): which are due at a given minute, and
// what a Done or Snooze tap on one changes.
// Kept free of the network so node --test covers it; the `telegram` Edge Function
// (supabase/functions/telegram) imports it, so the rules live only here.
//
// Nothing is booked ahead: each run works the messages out again from a snapshot of the day,
// and the nudges log is what stops one going out twice.
import { ORIGIN } from "../site.mjs";
import { clockSpan, couldntFitLine, linkish, proposalLines } from "./proposal.mjs";
import { weatherLine } from "./sources.mjs";
import { addDays, localNow, weekdayName, zonedIso, minutesOn, atRisk, dueLabel, formatClock, formatMinutes, telegramOn, blockOnComplete, blockMinutes, plural, proposedOn } from "./logic.mjs";
import { paceKind } from "./pace.mjs";
import { REASON_WORDS } from "./replan.mjs";
import { dayCap, isWeekend, wakeProfile } from "./sleep.mjs";
import { bedtimeFor, nightAt, shutdownFor, tonight } from "./bedtime.mjs";
import { lateNap } from "./oura-day.mjs";
import { pickTips, tipContext } from "./tips.mjs";
import { GYM_HABIT } from "./ring.mjs";
import { healthLine } from "./health.mjs";
import { nextRoutine, prs, workoutText } from "./hevy.mjs";

// Quiet hours run from 11 pm to 8 am; the brief opens the day.
export const QUIET_FROM = 23 * 60;
export const BRIEF_AT = 8 * 60;
// The latest a check-in goes out, for a shutdown line at 11 pm or later.
export const CHECKIN_LATEST = QUIET_FROM - 5;
// The nudge budget: nudges, repeats and snoozes a day, not counting the brief or the check-in.
export const BUDGET = 6;
// Finished? checks a day, a budget of their own (fix): start nudges using up theirs never starve
// them, so every nudged block's end gets one.
export const FINISHED_BUDGET = 8;
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
// research/plan-improvements.md U16: a link can open one of /plan's views on load (plan,
// shutdown or needs), which /plan reads and strips from the address.
const planUrl = (view) => `${PLAN_URL}?open=${view}`;

// Which messages arrive without a sound (research/plan-phone.md P2). sendMessage's
// disable_notification "Sends the message silently. Users will receive a notification with no
// sound." (core.telegram.org/bots/api#sendmessage, Bot API 10.3). What asks him to act now rings:
// the brief, the plan, a block's start, its repeat and snooze, wind-down, bedtime and a health
// alert. What only reports, or can wait for his next look, is silent: Finished?, the check-in,
// replan and horizon messages, Hevy's Nice lift (and, in the telegram function, receipts). They
// still show in the chat and badge the app.
const SILENT_KINDS = new Set(["finished", "checkin", "replan", "horizon", "workout"]);
// A Finished? carrying the next block's start (P3, `also`) asks him to start something: it rings.
export const silent = (m) => SILENT_KINDS.has(m.kind) && !m.also?.length;

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
  // Wind-down's two messages go through quiet hours, on a budget of their own.
  const night = windDownMessages(snapshot, now);
  const day = dayOf(snapshot, now);
  if (day.minutes < day.openAt || day.minutes >= QUIET_FROM) return night;
  // Each kind of message is one rule over the same day. Oura: the brief's time can move once his
  // wake syncs, so it goes once a day, whenever it went.
  const briefOut = day.log.some((n) => n.kind === "brief" && n.day === day.today && !pending(n));
  const due = [...(briefOut ? [] : [brief(day)]), ...(briefOut ? horizonMessage(day) : []), ...planMessage(day), ...replanMessage(day), ...starts(day), ...repeats(day), ...snoozes(day), ...finishedChecks(day), ...checkin(day), ...(briefOut ? healthMessage(day) : []), ...(briefOut ? workoutMessages(day) : [])]
    .filter((m) => Date.parse(m.send_at) <= now.getTime() && !logged(snapshot.log, m))
    .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  // The brief and check-in are outside the budget, and a snooze took its slot when it was tapped.
  let { kept, used, held } = budget(day);
  let checks = day.log.filter((n) => n.kind === "finished").length;
  return [...atBoundary(due.filter((m) => {
    if (m.kind === "finished") return checks++ < FINISHED_BUDGET;
    if (!BUDGETED.includes(m.kind) || m.kind === "snooze") return true;
    if (m.kind === "start" && kept.has(m.block_id)) held--;
    if (used + held >= BUDGET) return false;
    used++;
    return true;
  })), ...night];
}

// --- One message at a block boundary (research/plan-phone.md P3) ------------------------------
// A Finished? check and the next block's start nudge due within BOUNDARY of each other go as one
// message: the Finished? line, then "Next: " and the nudge, with the four answers in one row and
// Done/Snooze for the next block in a second (inline_keyboard is an Array of Array of
// InlineKeyboardButton: core.telegram.org/bots/api#inlinekeyboardmarkup). The start rides in
// `also`, so the telegram function still claims and logs its own row: the budget, the repeat ten
// minutes on and the Finished? at its end all work as before. Both have passed the budget here.
export const BOUNDARY = 5 * 60_000;
function atBoundary(list) {
  const out = [...list];
  for (const f of list.filter((m) => m.kind === "finished")) {
    const s = out.find((m) => m.kind === "start" && Math.abs(Date.parse(m.send_at) - Date.parse(f.send_at)) <= BOUNDARY);
    if (!s) continue;
    out.splice(out.indexOf(s), 1);
    out[out.indexOf(f)] = {
      ...f,
      text: `${f.text}\nNext: ${s.text}`,
      keyboard: [f.buttons, s.buttons],
      also: [{ kind: s.kind, block_id: s.block_id, day: s.day, send_at: s.send_at }],
    };
  }
  return out;
}

// --- Dead buttons (research/plan-phone.md P5) -------------------------------------------------
// The Telegram message ids (nudges.tg_message_id) whose buttons go once message m is out for the
// same block: every earlier start, repeat, snooze and Finished? for it, so only the newest
// message for a block has live buttons. For a tap, m is { block_id } and `keep` the tapped
// message, which its own edit answers. A row sent before tg_message_id was stored has none.
const BUTTON_KINDS = ["start", "repeat", "snooze", "finished"];
export function deadButtons(m, log, keep = null) {
  if (!m.block_id) return [];
  const same = (n) => n.kind === m.kind && Date.parse(n.send_at) === Date.parse(m.send_at);
  return (log ?? []).filter((n) => n.block_id === m.block_id && BUTTON_KINDS.includes(n.kind) && n.sent_at && n.tg_message_id != null
    && n.tg_message_id !== keep && !same(n)).map((n) => n.tg_message_id);
}

// --- Wind-down (docs/sheet-v5.md, "Wind-down") -----------------------------------------------

// At most two a night, Wind down and Bedtime, outside the nudge budget. A late run sends Wind
// down until bedtime and Bedtime until 30 minutes after it.
export const WIND_DOWN_BUDGET = 2;
const BEDTIME_LATE = 30 * 60_000;
const NIGHT_KINDS = ["wind_down", "bedtime"];

// Tonight's (bedtime.mjs): "Wind down" at bedtime - 60 and "Bedtime" at bedtime, each once a
// night, by kind and the night's day in snapshot.nightLog (the nudges rows of those kinds since
// yesterday). None once a synced Oura sleep began after wind-down started, and none without a
// bedtime (wind-down off, or no target and no Oura window). Plain text, no buttons.
function windDownMessages(snapshot, now) {
  const tz = snapshot.settings.time_zone;
  const n = tonight(now, tz);
  const bed = bedtimeFor(n, { settings: snapshot.settings, sleep: snapshot.sleep ?? [], sleepTimes: snapshot.sleepTimes ?? [], tz });
  if (!bed) return [];
  const t = now.getTime();
  const windAt = nightAt(n, bed.wind_down, tz), bedAt = nightAt(n, bed.minutes, tz);
  if ((snapshot.sleep ?? []).some((r) => r.type !== "deleted" && Date.parse(r.bedtime_start) <= t && Date.parse(r.bedtime_end) > Date.parse(windAt))) return [];
  const sent = (snapshot.nightLog ?? []).filter((r) => NIGHT_KINDS.includes(r.kind) && r.day === n);
  const msg = (kind, send_at, text) => ({ kind, block_id: null, day: n, send_at, text, buttons: [] });
  const out = [];
  const lightsOut = formatClock(bed.minutes % 1440);
  if (t >= Date.parse(windAt) && t < Date.parse(bedAt) && !sent.some((r) => r.kind === "wind_down")) {
    // Oura, composed here: after a late nap today, a low ring battery at the last sync (within
    // 30 minutes), and today's first evening tip on a line of its own.
    const nap = lateNap(snapshot.sleep, n, tz) ? " After a late nap, keep to your bedtime." : "";
    const ring = snapshot.ringLow?.ring_low && t - Date.parse(snapshot.ringLow.ring_checked_at ?? 0) < 30 * 60_000 ? " Charge your ring." : "";
    const tip = tipsFor(snapshot, n).find((x) => x.evening);
    out.push(msg("wind_down", windAt, [`Wind down: lights out at ${lightsOut}. Wrap up and put the screens away.${nap}${ring}`, tip && `Tip: ${tip.text}`].filter(Boolean).join("\n")));
  }
  if (t >= Date.parse(bedAt) && t < Date.parse(bedAt) + BEDTIME_LATE && !sent.some((r) => r.kind === "bedtime")) {
    out.push(msg("bedtime", bedAt, "Bedtime: lights out now. Sleep well."));
  }
  return out.slice(0, Math.max(0, WIND_DOWN_BUDGET - sent.length));
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
  return { ...snapshot, blocks: snapshot.blocks.filter((b) => !b.proposed), needsOpen, plan, today, minutes, tz, now: now.getTime(), ...wakeTimes(snapshot, now, today, tz) };
}

// Oura (docs/sheet-v5.md, "Oura"): with his sleep_nights rows (snapshot.sleep), quiet lasts until
// he's up, today's actual wake or else his typical wake for the day, and the brief waits until 15
// minutes after the actual wake, or 90 after the typical one while the ring hasn't synced. Never
// before 8:00; without rows, 8:00 as before.
function wakeTimes(snapshot, now, today, tz) {
  if (!snapshot.sleep?.length) return { openAt: BRIEF_AT, briefAt: BRIEF_AT, wokeAt: null };
  const p = wakeProfile(snapshot.sleep, now, tz);
  const typical = isWeekend(today) ? p.weekend : p.weekday;
  const up = p.woke_at ?? typical ?? BRIEF_AT;
  const brief = p.woke_at != null ? p.woke_at + 15 : typical != null ? typical + 90 : BRIEF_AT;
  return { openAt: Math.max(BRIEF_AT, up), briefAt: Math.max(BRIEF_AT, brief), wokeAt: p.woke_at };
}

// Oura: "Readiness 64, slept 5h40: cap 4h45.", when today's numbers (snapshot.sleepDay, a
// sleep_days row) changed the workload cap; otherwise null.
function capLine({ settings, sleepDay, today }) {
  if (sleepDay?.day !== today) return null;
  const { workload_cap_min, cap_reason } = dayCap(settings.workload_cap_min ?? 360, sleepDay);
  if (!cap_reason) return null;
  const why = cap_reason.split(":")[0];
  return `${why[0].toUpperCase()}${why.slice(1)}: cap ${formatMinutes(workload_cap_min)}.`;
}

// Oura: "Sleep score 82, good.", from today's sleep_days row, by Oura's bands (85+ optimal,
// 70-84 good, under 70 pay attention). Composed here, never by the routine (docs/adr/0005).
function scoreLine({ sleepDay, today }) {
  const s = sleepDay?.day === today ? sleepDay.sleep_score : null;
  return s == null ? null : `Sleep score ${s}, ${s >= 85 ? "optimal" : s >= 70 ? "good" : "pay attention"}.`;
}

// Tips (tips.mjs) for `day`, from snapshot.tipDays (sleep_days { day, contributors } of the last
// two weeks), with tonight's bedtime and the Gym habit's time in the words.
function tipsFor(snapshot, day) {
  if (!snapshot.tipDays?.length) return [];
  const tz = snapshot.settings.time_zone;
  const bed = bedtimeFor(day, { settings: snapshot.settings, sleep: snapshot.sleep ?? [], sleepTimes: snapshot.sleepTimes ?? [], tz });
  const gym = (snapshot.gymHabits ?? []).find((h) => GYM_HABIT.test(h.name ?? ""));
  return pickTips(snapshot.tipDays, day, tipContext(bed, gym?.ideal ?? null));
}

const BUDGETED = ["start", "repeat", "snooze", "horizon"];

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

// When the ring has seen him up today (wokeAt), the brief opens as a good morning: "Good
// morning! Up at 8:50 am. First up: OS homework at 7:15 pm." The first block is the next one
// not yet over. Without a seen wake (typical wake, or no ring) there is no greeting line.
function greeting(day, blocksToday) {
  if (day.wokeAt == null) return null;
  const next = blocksToday.filter((b) => Date.parse(b.ends_at) > day.now).sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
  const title = next && day.tasks.find((t) => t.id === next.task_id)?.title;
  const first = title ? ` First up: ${title} at ${formatClock(minutesOn(next.starts_at, day.today, day.tz))}.` : "";
  return `Good morning! Up at ${formatClock(day.wokeAt)}.${first}`;
}

// The morning brief: what today holds, at 8:00. Private tasks show their real titles: the
// messages go only to Lisul.
// "Nudging the first 6" counts only the blocks that can be nudged.
// With today's proposal pending, the brief carries it and its buttons; with the morning task set
// up and no proposal for today, it says the run didn't come in.
function brief(day) {
  const { tasks, blocks, today, tz, plan } = day;
  const todays = tasks.filter((t) => t.day === today);
  const blocksToday = blocks.filter((b) => { const m = minutesOn(b.starts_at, today, tz); return m >= 0 && m < 1440; });
  // Horizon planning: a task with a horizon state is at risk while tight; won't fit has its own line.
  const hz = horizonStates(day);
  const risky = tasks.filter((t) => atRisk(t, blocks, today, tz, hz.get(t.id))).sort((a, b) => a.due.localeCompare(b.due));
  const wont = risky.filter((t) => hz.get(t.id)?.state === "wont_fit");
  const n = blocksToday.length;
  const lines = [greeting(day, blocksToday), `Today: ${plural(todays.length, "task")}, ${plural(n, "block")}${live(day).length > BUDGET ? `, nudging the first ${BUDGET}` : ""}.`];
  const gym = gymLine(day);
  if (gym) lines.push(gym);
  const tight = risky.filter((t) => !wont.includes(t));
  if (tight.length) lines.push(`At risk: ${tight.map((t) => `${t.title} (${dueLabel(t.due, today)})`).join(", ")}.`);
  if (wont.length) lines.push(`Won't fit: ${wont.map((t) => `${t.title}, ${formatMinutes(hz.get(t.id).short_min)} short (${dueLabel(t.due, today)})`).join("; ")}. ${FIXES}`);
  // What the brief told him of, which telegram marks told (horizon_state.notified).
  const told = [...wont, ...tight].filter((t) => hz.has(t.id)).map((t) => ({ task_id: t.id, state: hz.get(t.id).state }));
  const marks = told.length ? { horizon: told } : {};
  const week = lastWeekLine(day, hz);
  if (week) lines.push(week);
  // The tail: context he can read later, folded (see folded). Oura's score, a tip and the cap;
  // v5 W1's weather line, when the cache has a forecast (snapshot.weather, the weather_cache
  // row); v5 SRC3's academic calendar entries (snapshot.academic, at most 3); v5 M1's Awaiting
  // reply.
  const [tip] = tipsFor(day, today);
  const wx = day.weather?.periods?.length ? weatherLine(day.weather.periods, day.weather.alerts ?? [], today, tz) : null;
  const cal = academicLine(day.academic);
  // The Sheet's health (health.mjs), when the snapshot has it: folded when all green, in view
  // with its issues, which then count as told (`health`, the keys; no alert repeats them).
  const h = day.health;
  const sick = h && !h.green ? healthLine(h) : null;
  const tail = [scoreLine(day), tip && `Tip: ${tip.text}`, capLine(day), wx, cal, awaitingLine(day.awaiting), h?.green ? healthLine(h) : null];
  const send_at = zonedIso(today, day.briefAt, tz);
  const sickKeys = sick ? { health: h.issues.map((i) => i.key) } : {};
  const brief = (head, buttons) => ({ kind: "brief", block_id: null, day: today, send_at, ...folded([...head, sick], tail), buttons, ...marks, ...sickKeys });
  if (plan) return brief([...lines, ...plan], planButtons(today, day.proposal?.rev));
  const missed = day.settings.morning_on && day.proposal?.day !== today;
  const empty = 'No morning plan came in today: say "plan my day" to Claude.';
  // A missed morning plan is said even with blocks on today (carried over, or approved last
  // night): they don't mean today was planned (research/plan-reliability.md R2).
  if (missed) lines.push(empty);
  else if (!n) lines.push('Nothing planned yet: say "plan my day" to Claude.');
  // With no plan to carry it, the brief counts the open Needs you rows, and its link opens them.
  const needs = day.needsOpen.length ? `Needs you: ${day.needsOpen.length}.` : null;
  const head = todays.length || n || risky.length ? [...lines, needs] : [lines[0], "Nothing on today.", missed && empty, needs];
  return brief(head, [{ text: "Open /plan", url: needs ? planUrl("needs") : PLAN_URL }]);
}

// --- Health alerts (docs/sheet-nudges.md, "Health") ------------------------------------------
// One message when something breaks that he hasn't been told of (settings.health_told, the keys
// told and still open): sent after the brief (which lists what is broken by then), only while
// messages go out at all (from his wake, never before 8 am, until 11 pm), at most HEALTH_BUDGET
// a day. Beside the nudge budget, like the brief: it takes none of its six slots, and has a cap
// of its own. A key stays told while the issue lasts, so each incident is told once.
export const HEALTH_BUDGET = 2;
function healthMessage(day) {
  const h = day.health;
  if (!h || h.green) return [];
  const told = new Set(day.settings.health_told ?? []);
  const fresh = h.issues.filter((i) => !told.has(i.key));
  if (!fresh.length || day.log.filter((n) => n.kind === "health").length >= HEALTH_BUDGET) return [];
  const send_at = new Date(Math.floor(day.now / 60_000) * 60_000).toISOString();
  return [{ kind: "health", block_id: null, day: day.today, send_at, text: healthLine(h, fresh), buttons: [{ text: "Open /plan", url: PLAN_URL }], health: fresh.map((i) => i.key) }];
}

// --- Hevy (docs/sheet-nudges.md, "Hevy"; docs/sheet-hevy.md) --------------------------------
// snapshot.hevy, which the telegram function reads (absent or account null: Hevy isn't connected):
//   account  the hevy_account row { connected_at, synced_at, last_error, weight_unit }
//   recent   hevy_workouts rows that ended in the last WORKOUT_FRESH
//   history  every hevy_workouts row { id, routine_id, title, starts_at }
//   sets     hevy_sets of the recent workouts, and every set of their exercise templates
//   sent     the nudges rows of kind 'workout' since yesterday { day, send_at }

// "Nice lift": one message per workout hevy-sync brings in, at most WORKOUT_FRESH after it ended,
// keyed by its end (send_at) on the day it ended. Only workouts that ended after Hevy was
// connected: the first full sync (or a new key's) reads his whole history, and none of it is
// news. After the brief, beside the nudge budget like it, and silent (it only reports). PRs are
// worked out against the sets of workouts that started before this one (hevy.mjs, prs).
export const WORKOUT_FRESH = 12 * 60 * 60_000;
function workoutMessages(day) {
  const h = day.hevy;
  if (!h?.account) return [];
  const since = Date.parse(h.account.connected_at ?? "");
  const startOf = new Map((h.history ?? []).map((w) => [w.id, Date.parse(w.starts_at)]));
  const unit = h.account.weight_unit === "kg" ? "kg" : "lbs";
  const sets = h.sets ?? [];
  return (h.recent ?? []).flatMap((w) => {
    const end = Date.parse(w.ends_at);
    if (!(end > since) || end > day.now || day.now - end > WORKOUT_FRESH) return [];
    if ((h.sent ?? []).some((n) => Date.parse(n.send_at) === end)) return [];
    const mine = sets.filter((s) => s.workout_id === w.id);
    const before = sets.filter((s) => startOf.get(s.workout_id) < Date.parse(w.starts_at));
    return [{
      kind: "workout", block_id: null, day: localNow(new Date(end), day.tz).day, send_at: new Date(end).toISOString(),
      text: workoutText(w, mine, prs(w, mine, before, unit), unit), buttons: [{ text: "Open /plan", url: PLAN_URL }],
    }];
  });
}

// Today's Gym habit blocks (a habit whose name GYM_HABIT matches; snapshot.habits), earliest
// first, each with its habit's name.
function gymBlocks({ blocks, habits, today, tz }) {
  const gym = new Map((habits ?? []).filter((h) => GYM_HABIT.test(h.name ?? "")).map((h) => [h.id, h.name]));
  return blocks.filter((b) => gym.has(b.habit_id)).map((b) => ({ b, name: gym.get(b.habit_id), start: minutesOn(b.starts_at, today, tz) }))
    .filter(({ start }) => start >= 0 && start < 1440).sort((x, y) => x.start - y.start);
}

// The brief's "Gym 5:30 pm: Push #2 next.", when today has a Gym habit block and Hevy's history
// says which routine comes next (hevy.mjs, nextRoutine); otherwise no line.
function gymLine(day) {
  const [g] = gymBlocks(day);
  const next = g && nextRoutine(day.hevy?.history);
  return next ? `${g.name} ${formatClock(g.start)}: ${next.title} next.` : null;
}

// --- Monday's Last week line (research/plan-insights.md I9) -------------------------------------
// "Last week: 18h30 done of 24h planned. Course tasks ran 1.4× estimate. Due this week: Essay
// (tight), OS project (on track)." On Mondays only, from snapshot.lastWeek, which the telegram
// function reads on Mondays: { blocks: last Mon-Sun's approved task blocks { task_id, starts_at,
// ends_at }, done: the ids of their tasks now done, actuals: last week's actuals { kind, est_min,
// minutes } }. Planned is every block's minutes and done the minutes of blocks whose task is done.
// The pace part names the kind whose median actual/estimate is furthest from 1, with 3 or more
// samples and at least 20% off; due this week lists up to 3 open tasks due today to Sunday with
// their horizon state. No sleep numbers (docs/adr/0005). Null with fewer than 3 planned days.
const PACE_WORDS = { course: "Course tasks", campus: "Campus events", github: "GitHub items", jira: "Jira tickets", other: "Other tasks" };
const median = (xs) => { const v = [...xs].sort((a, b) => a - b); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
function lastWeekLine({ lastWeek, today, tz, tasks }, hz) {
  if (!lastWeek || new Date(`${today}T12:00:00Z`).getUTCDay() !== 1) return null;
  const from = addDays(today, -7);
  const mins = (b) => Math.max(0, Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000));
  const blocks = (lastWeek.blocks ?? []).filter((b) => { const d = localNow(new Date(b.starts_at), tz).day; return d >= from && d < today; });
  if (new Set(blocks.map((b) => localNow(new Date(b.starts_at), tz).day)).size < 3) return null;
  const done = new Set(lastWeek.done ?? []);
  const planned = blocks.reduce((n, b) => n + mins(b), 0);
  const did = blocks.filter((b) => done.has(b.task_id)).reduce((n, b) => n + mins(b), 0);
  const parts = [`Last week: ${formatMinutes(did)} done of ${formatMinutes(planned)} planned.`];
  const ratios = {};
  for (const a of lastWeek.actuals ?? []) if (a.est_min > 0 && PACE_WORDS[a.kind]) (ratios[a.kind] ??= []).push(a.minutes / a.est_min);
  const [kind, pace] = Object.entries(ratios).filter(([, r]) => r.length >= 3).map(([k, r]) => [k, median(r)])
    .filter(([, m]) => m >= 1.2 || m <= 0.8).sort((a, b) => Math.abs(Math.log(b[1])) - Math.abs(Math.log(a[1])))[0] ?? [];
  if (kind) parts.push(`${PACE_WORDS[kind]} ran ${pace.toFixed(1)}× estimate.`);
  const words = { on_track: "on track", tight: "tight", wont_fit: "won't fit" };
  const due = tasks.filter((t) => !t.done && t.due && t.due >= today && t.due <= addDays(today, 6))
    .sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3)
    .map((t) => { const st = words[hz.get(t.id)?.state]; const name = String(t.title).slice(0, 30).trim(); return st ? `${name} (${st})` : name; });
  if (due.length) parts.push(`Due this week: ${due.join(", ")}.`);
  return parts.join(" ");
}

// research/plan-phone.md P7: the lines to act on stay in view, and the tail folds into one
// expandable_blockquote ("collapsed-by-default block quotation"), sent as an entity with no
// parse_mode, so the text stays plain. An entity's offset and length are "in UTF-16 code units"
// (core.telegram.org/bots/api#messageentity), which is what a JS string's length counts.
// Returns { text } or { text, entities }; null lines are dropped.
function folded(head, tail) {
  const top = head.filter(Boolean).join("\n");
  const rest = tail.filter(Boolean).join("\n");
  if (!rest) return { text: top };
  return { text: `${top}\n${rest}`, entities: [{ type: "expandable_blockquote", offset: top.length + 1, length: rest.length }] };
}

// --- Horizon planning (docs/sheet-horizon.md, "Part 2", 7) ------------------------------------

// What fixes a task that won't fit (R7).
const FIXES = "Move the due date, cut the estimate or raise a day's cap in /plan.";
// snapshot.horizon: the horizon_state rows, with notified, the last state he was told of.
const horizonStates = (day) => new Map((day.horizon ?? []).map((h) => [h.task_id, h]));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
// News: tight he hasn't been told of, or won't fit he hasn't been told of as such.
const news = (h) => (h.state === "wont_fit" && h.notified !== "wont_fit") || (h.state === "tight" && !h.notified);

// After the brief, one message (at this minute) when tasks turned tight or won't fit, inside
// the nudge budget. Moved minutes alone never send one. It carries `horizon`, the states told.
function horizonMessage(day) {
  const hz = horizonStates(day);
  const tasks = day.tasks.filter((t) => !t.done && hz.has(t.id) && news(hz.get(t.id)))
    .sort((a, b) => (hz.get(a.id).state === "wont_fit" ? 0 : 1) - (hz.get(b.id).state === "wont_fit" ? 0 : 1) || a.due.localeCompare(b.due));
  if (!tasks.length) return [];
  const lines = tasks.map((t) => {
    const h = hz.get(t.id);
    if (h.state === "wont_fit") return `${t.title} won't fit: ${formatMinutes(h.short_min)} short by ${weekdayName(t.due)}. ${FIXES}`;
    const spare = h.finish_day ? daysBetween(h.finish_day, t.due) : 0;
    return `${t.title} is tight: done ${weekdayName(h.finish_day ?? t.due)}, ${spare > 0 ? `${plural(spare, "day")} spare` : "no day spare"}.`;
  });
  const send_at = new Date(Math.floor(day.now / 60_000) * 60_000).toISOString();
  return [{ kind: "horizon", block_id: null, day: day.today, send_at, text: lines.join("\n"), buttons: [{ text: "Open /plan", url: PLAN_URL }], horizon: tasks.map((t) => ({ task_id: t.id, state: hz.get(t.id).state })) }];
}

// What a message's `horizon` (the states it tells) writes to horizon_state.notified, as groups
// { ids, notified }: `mark` before it is sent, as the claim, so a failed save sends nothing rather
// than the same message every minute (its send_at is the minute, so the log's key can't stop it);
// `restore`, each task's notified as `rows` had it, if Telegram then refuses the message.
export function horizonMarks(m, rows) {
  const told = m.horizon ?? [];
  const before = new Map((rows ?? []).map((h) => [h.task_id, h.notified ?? null]));
  const groups = (pairs) => [...pairs.reduce((g, [id, v]) => g.set(v, [...(g.get(v) ?? []), id]), new Map())].map(([notified, ids]) => ({ ids, notified }));
  const mark = ["tight", "wont_fit"].map((st) => ({ ids: told.filter((h) => h.state === st).map((h) => h.task_id), notified: st })).filter((g) => g.ids.length);
  return { mark, restore: groups(told.map((h) => [h.task_id, before.get(h.task_id) ?? null])) };
}

// What telegram writes back to horizon_state.notified without a message: back on track forgets
// what was told, and won't fit eased to tight remembers tight (so won't fit again is news).
export const horizonResets = (states) => (states ?? []).flatMap((h) =>
  h.state === "on_track" && h.notified ? [{ task_id: h.task_id, notified: null }]
  : h.state === "tight" && h.notified === "wont_fit" ? [{ task_id: h.task_id, notified: "tight" }] : []);

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
  return [{ text: "Approve all", callback_data: `pa:${d}${r}` }, { text: "Open /plan", url: planUrl("plan") }, { text: "Skip", callback_data: `ps:${d}${r}` }];
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
  const words = replanWords(p.reasons ?? [], day);
  const lines = [
    words ? `Replan: ${words}.` : "Replan: the plan changed.",
    ...added.map((b) => `+ ${at(b)} · ${title(b)} (${blockMinutes(b)} min)`),
    ...gone.map((b) => `− ${at(b)} · ${title(b)}`),
  ];
  const unfit = couldntFitLine(p.couldnt_fit, day.tasks);
  if (unfit) lines.push(unfit);
  return [{ kind: "replan", block_id: null, day: day.today, send_at: new Date(p.created_at).toISOString(), text: lines.join("\n"), buttons: planButtons(day.today, p.rev) }];
}

// The replan message's reasons (fix): a few specific words where the stored rows allow, from
// day.replanChanges (the { reason, ref } rows the revision consumed), and the fixed words for the
// rest, in the revision's order. Only titles The Sheet already stores are used, never mail:
// - busy_overlap (ref "<starts_at>/<ends_at>"): "Busy 2:00–3:00 pm now overlaps Gym", naming the
//   earliest approved or previous-revision block it overlaps, or "Busy 2:00–3:00 pm now";
// - *_due_soon (ref the task's source_uid): "HW3 due Thu".
// A title that could become a link, or a ref with nothing stored, gets the fixed words. At most
// SPECIFIC_MAX specific phrases; each reason's fixed words go when one of its phrases is said.
const SPECIFIC_MAX = 3;
const TITLE_CHARS = 30;
function replanWords(reasons, day) {
  const said = new Map();
  const title = (t) => (t && !linkish(t.title) ? String(t.title).replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS).trim() : null);
  let n = 0;
  for (const c of day.replanChanges ?? []) {
    if (n >= SPECIFIC_MAX || !reasons.includes(c.reason) || !c.ref) continue;
    let phrase = null;
    if (c.reason === "busy_overlap") {
      const [from, to] = String(c.ref).split("/").map(Date.parse);
      if (Number.isNaN(from) || Number.isNaN(to)) continue;
      const span = clockSpan(minutesOn(new Date(from).toISOString(), day.today, day.tz), minutesOn(new Date(to).toISOString(), day.today, day.tz));
      const hit = [...day.blocks, ...(day.previous?.blocks ?? [])]
        .filter((b) => Date.parse(b.starts_at) < to && from < Date.parse(b.ends_at))
        .sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at))
        .map((b) => title(day.tasks.find((t) => t.id === b.task_id)) ?? (day.habits ?? []).find((h) => h.id === b.habit_id)?.name)
        .find(Boolean);
      phrase = hit && !linkish(hit) ? `Busy ${span} now overlaps ${hit}` : `Busy ${span} now`;
    } else if (c.reason === "woke_late") {
      // Oura: ref is the wake's bedtime_end.
      if (!Number.isNaN(Date.parse(c.ref))) phrase = `you woke up at ${formatClock(minutesOn(new Date(Date.parse(c.ref)).toISOString(), day.today, day.tz))}`;
    } else if (/_due_soon$/.test(c.reason)) {
      const t = day.tasks.find((x) => x.source_uid === c.ref && x.due);
      const name = title(t);
      if (name) phrase = `${name} ${dueLabel(t.due, day.today)}`;
    }
    if (!phrase) continue;
    if (!said.has(c.reason)) said.set(c.reason, []);
    if (!said.get(c.reason).includes(phrase)) { said.get(c.reason).push(phrase); n++; }
  }
  return reasons.flatMap((r) => said.get(r) ?? (REASON_WORDS[r] ? [REASON_WORDS[r]] : [])).join(", ");
}

// Done and Snooze carry the block they belong to; the webhook reads them back on a tap.
const tapButtons = (id) => [{ text: "Done", callback_data: `done:${id}` }, { text: "Snooze 10 min", callback_data: `snooze:${id}` }];
// A task with a page (tasks.link: a Brightspace assignment, a GitHub issue, a Jira ticket) gets an
// Open button beside them on its start and repeat nudges, so starting is one tap. A url button
// (core.telegram.org/bots/api#inlinekeyboardbutton) opens the page and sends the bot nothing.
const startButtons = (b, task) => [...tapButtons(b.id), ...(/^https:\/\//.test(task?.link ?? "") ? [{ text: "Open", url: task.link }] : [])];

// "▶ 2:00 pm · OS homework (45 min)"
// With a first step (docs/sheet-v5.md, "Day rules and first steps") it leads with it.
const nudgeText = (b, task, { today, tz }) => (b.first_step
  ? `Now: ${task.title} — first: ${b.first_step} (${formatClock(minutesOn(b.starts_at, today, tz))}, ${blockMinutes(b)} min)`
  : `▶ ${formatClock(minutesOn(b.starts_at, today, tz))} · ${task.title} (${blockMinutes(b)} min)`);

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
    return { kind: "start", block_id: b.id, day: day.today, send_at: new Date(b.starts_at).toISOString(), text: nudgeText(b, task, day), buttons: startButtons(b, task) };
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
    return [{ kind: "repeat", block_id: b.id, day: day.today, send_at: new Date(Date.parse(b.starts_at) + REPEAT_AFTER).toISOString(), text: `Still on: ${task.title}`, buttons: startButtons(b, task) }];
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
// per end (More time moves the end, so it asks again). Up to FINISHED_BUDGET a day, outside the
// nudge budget.
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

// The check-in: at the day's shutdown line (his, else when wind-down starts: shutdownFor),
// asking for the shutdown. Once the day is shut down, or on a day with no tasks, there's nothing
// to ask. It also says what's due tomorrow and how many Needs you rows, mail and Slack, are
// still open (docs/sheet-morning.md).
function checkin({ tasks, day: row, today, tz, needsOpen, settings, sleep, sleepTimes }) {
  const todays = tasks.filter((t) => t.day === today);
  if (row?.shutdown || !todays.length) return [];
  const [h, m] = shutdownFor(today, { line: row?.shutdown_at, settings, sleep, sleepTimes, tz }).split(":").map(Number);
  // A shutdown line in quiet hours still gets its check-in, just before them.
  const at = Math.min(h * 60 + m, CHECKIN_LATEST);
  const done = todays.filter((t) => t.done).length;
  const lines = [`Shutdown time. ${done} done, ${todays.length - done} left.`];
  const tomorrow = tasks.filter((t) => !t.done && t.due === addDays(today, 1));
  if (tomorrow.length) lines.push(`Tomorrow: ${tomorrow.length} due (${tomorrow.slice(0, 3).map((t) => t.title.slice(0, 30).trim()).join(", ")}).`);
  if (needsOpen.length) lines.push(`Needs you: ${needsOpen.length}.`);
  return [{ kind: "checkin", block_id: null, day: today, send_at: zonedIso(today, at, tz), text: lines.join("\n"), buttons: [{ text: "Open /plan", url: planUrl("shutdown") }] }];
}

// --- The pinned Now message (docs/sheet-nudges.md, "The pinned Now message") ---------------

// One line for the top of the chat, from the approved blocks (proposed ones aren't on the plan):
// "Now: OS homework until 3:40 pm · Next: Gym at 4:00 pm", "Next: Gym at 4:00 pm" between blocks,
// "Next: Gym tomorrow at 8:00 am" when the next is on a later day, or "Nothing scheduled". A
// block is named by its task, or its habit (snapshot.habits, { id, name }).
export function nowText(snapshot, now) {
  const tz = snapshot.settings.time_zone;
  const t = now.getTime();
  const { day: today } = localNow(now, tz);
  const name = (b) => (b.task_id ? snapshot.tasks.find((x) => x.id === b.task_id)?.title
    : (snapshot.habits ?? []).find((h) => h.id === b.habit_id)?.name) ?? "A block";
  const blocks = snapshot.blocks.filter((b) => !b.proposed).sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at));
  const on = blocks.find((b) => Date.parse(b.starts_at) <= t && t < Date.parse(b.ends_at));
  const next = blocks.find((b) => Date.parse(b.starts_at) > t);
  const clock = (iso) => { const l = localNow(new Date(iso), tz); return { day: l.day, at: formatClock(l.minutes) }; };
  const parts = [];
  if (on) parts.push(`Now: ${name(on)} until ${clock(on.ends_at).at}`);
  if (next) {
    const { day, at } = clock(next.starts_at);
    const when = day === today ? "" : day === addDays(today, 1) ? "tomorrow " : `${weekdayName(day)} `;
    parts.push(`Next: ${name(next)} ${when}at ${at}`);
  }
  return parts.join(" · ") || "Nothing scheduled";
}

// What the minute tick does with the pinned message (its id and words in settings.now_message_id
// and now_text): { action: "create", text } to send and pin it, made only while he's up (not in
// quiet hours or before his wake, as the brief); { action: "edit", message_id, text } once the
// words change, at any hour, since an edit makes no notification; or null. Nothing while
// Telegram is off, or while another tick's claim to make it holds (PIN_CLAIM).
// How long a claim to make the pinned message holds: a tick that sent it but failed to save its
// id leaves the claim, and only after this can another one be made.
export const PIN_CLAIM = 15 * 60_000;
export function pinStep(snapshot, now) {
  if (!telegramOn(snapshot.settings)) return null;
  const text = nowText(snapshot, now);
  const { now_message_id: id, now_text } = snapshot.settings;
  if (id != null) return text === now_text ? null : { action: "edit", message_id: id, text };
  // Another tick claimed making it (settings.now_claimed_at) and hasn't saved its id yet.
  const claimed = snapshot.settings.now_claimed_at;
  if (claimed && now.getTime() - Date.parse(claimed) < PIN_CLAIM) return null;
  const day = dayOf(snapshot, now);
  return day.minutes >= day.openAt && day.minutes < QUIET_FROM ? { action: "create", text } : null;
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
  // Didn't start's slot button: "move:<block id>:<the slot's start, in minutes since the epoch>".
  const [, moved, minute] = /^move:([^:]+):(\d{1,9})$/.exec(q.data ?? "") ?? [];
  if (moved) return UUID.test(moved) ? { action: "move", block_id: moved, at: Number(minute) * 60_000, ...from } : null;
  // P6: Today's Done on a task: "td:<task id>".
  const [, taskDone] = /^td:(.+)$/.exec(q.data ?? "") ?? [];
  if (taskDone) return UUID.test(taskDone) ? { action: "taskdone", task_id: taskDone, ...from } : null;
  const [, action, block_id] = /^(done|snooze|finished|more|nostart|tomorrow):(.+)$/.exec(q.data ?? "") ?? [];
  if (!action || !UUID.test(block_id)) return null;
  return { action, block_id, ...from };
}

// A plan tap names its day, not a block.
export const planTap = (tap) => tap.action === "pa" || tap.action === "ps";

// A nudge from an earlier day can name a block outside today's snapshot. The webhook then adds
// that block, its task's other blocks and its task before handleTap runs.
export const needsTappedBlock = (snapshot, tap) => !planTap(tap) && tap.action !== "taskdone" && !snapshot.blocks.some((b) => b.id === tap.block_id);

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
  if (tap.action === "taskdone") {
    const t = snapshot.tasks.find((x) => x.id === tap.task_id);
    if (!t) return { changes: [], text: "That task is no longer on the plan." };
    return t.done ? { changes: [], text: DONE } : { changes: done(t, snapshot, now).changes, text: `${DONE} · ${t.title}` };
  }
  const b = snapshot.blocks.find((x) => x.id === tap.block_id);
  const task = b && snapshot.tasks.find((t) => t.id === b.task_id);
  // A block deleted or moved off the plan since its nudge went out: nothing left to act on.
  if (!task) return { changes: [], text: GONE };
  if (task.done) return { changes: [], text: DONE };
  if (FINISHED_ANSWERS[tap.action]) return FINISHED_ANSWERS[tap.action](b, task, snapshot, now, tap);
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

// Didn't start's slot starts at least this long after the tap, on a quarter hour.
const SLOT_LEAD = 5;
// Whether `b` could run from `start` (ms) for `len` ms today: after now and once he's up, by the
// day's shutdown line and quiet hours, over no busy time (with travel_min each side) and no other approved
// block. Proposed blocks don't count, as for More time.
const TRAVEL_MS = 10 * 60_000;
function slotFree(b, start, len, snapshot, now) {
  const tz = snapshot.settings.time_zone;
  const { day: today } = localNow(now, tz);
  if (!Number.isFinite(start) || start <= now.getTime() || localNow(new Date(start), tz).day !== today) return false;
  // Not before he's up: a tap at 1:30 am or 7:00 am offers nothing in quiet hours.
  if (minutesOn(new Date(start).toISOString(), today, tz) < wakeTimes(snapshot, now, today, tz).openAt) return false;
  const line = shutdownFor(today, { line: snapshot.day?.shutdown_at, settings: snapshot.settings, sleep: snapshot.sleep ?? [], sleepTimes: snapshot.sleepTimes ?? [], tz });
  const end = start + len;
  if (minutesOn(new Date(end).toISOString(), today, tz) > Math.min(QUIET_FROM, Number(line.slice(0, 2)) * 60 + Number(line.slice(3, 5)))) return false;
  const hit = (x, pad) => Date.parse(x.starts_at) - pad < end && Date.parse(x.ends_at) + pad > start;
  return !(snapshot.busy ?? []).some((x) => hit(x, TRAVEL_MS)) && !snapshot.blocks.some((x) => x.id !== b.id && !x.proposed && hit(x, 0));
}
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
    // A late tap counts each block only to its end, on the block's own day (docs/sheet-v5.md,
    // "Day rules and first steps"), so tap latency never inflates pace.
    const row = { day: localNow(new Date(b.starts_at), snapshot.settings.time_zone).day, task_id: task.id, block_id: b.id, kind: paceKind(task), est_min: task.est_min ?? null, minutes };
    return { changes: [...changes, { table: "actuals", insert: row }], text: `✓ Done in ${minutes} min · ${task.title}` };
  },
  // Thirty minutes more, when nothing approved or busy takes them and they end by quiet hours.
  // Proposed blocks don't count as taken. The next Finished? follows at the new end.
  // P6's +15 min key passes tap.minutes.
  more(b, task, snapshot, now, tap) {
    const tz = snapshot.settings.time_zone;
    const from = Date.parse(b.ends_at);
    const extra = tap?.minutes ? tap.minutes * 60_000 : MORE_TIME;
    const to = from + extra;
    const ends_at = new Date(to).toISOString();
    const on = localNow(new Date(b.starts_at), tz).day;
    if (minutesOn(ends_at, on, tz) > QUIET_FROM) return { changes: [], text: `Too close to quiet hours · ${task.title}` };
    const taken = [...(snapshot.busy ?? []), ...snapshot.blocks.filter((x) => x.id !== b.id && !x.proposed)]
      .some((x) => Date.parse(x.starts_at) < to && Date.parse(x.ends_at) > from);
    if (taken) return { changes: [], text: `The next ${extra / 60_000} min aren't free · ${task.title}` };
    const pending = b.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: b.gcal_id, ends_at } }] : [];
    return { changes: [{ table: "blocks", id: b.id, update: { ends_at } }, ...pending], text: `More time: until ${formatClock(minutesOn(ends_at, on, tz))} · ${task.title}` };
  },
  // The next free slot today that holds the block (docs/sheet-v5.md, "Day rules and first
  // steps"), as a button that moves it there, and Tomorrow; with none, Tomorrow alone.
  nostart(b, task, snapshot, now) {
    const tz = snapshot.settings.time_zone;
    const len = Date.parse(b.ends_at) - Date.parse(b.starts_at);
    const tomorrowButton = { text: "Tomorrow", callback_data: `tomorrow:${b.id}` };
    const { day: today, minutes } = localNow(now, tz);
    for (let m = Math.ceil((minutes + SLOT_LEAD) / 15) * 15; m < 1440; m += 15) {
      const start = Date.parse(zonedIso(today, m, tz));
      if (!slotFree(b, start, len, snapshot, now)) continue;
      const at = formatClock(m);
      return {
        changes: [],
        text: `Next free slot: ${at} (${Math.round(len / 60_000)} min) · ${task.title}`,
        buttons: [{ text: `Move to ${at}`, callback_data: `move:${b.id}:${start / 60_000}` }, tomorrowButton],
      };
    }
    return { changes: [], text: `No free slot left today · ${task.title}`, buttons: [tomorrowButton] };
  },
  // A tap on the slot's button moves the block there once it is still free, as Lisul's own move:
  // locked (auto off), with its Google event deleted for /plan to make again.
  move(b, task, snapshot, now, tap) {
    const len = Date.parse(b.ends_at) - Date.parse(b.starts_at);
    if (!slotFree(b, tap.at, len, snapshot, now)) return { changes: [], text: `That slot isn't free any more · ${task.title}` };
    const starts_at = new Date(tap.at).toISOString();
    const ends_at = new Date(tap.at + len).toISOString();
    const pending = b.gcal_id ? [{ table: "gcal_pending", insert: { gcal_id: b.gcal_id, ends_at: null } }] : [];
    const at = formatClock(localNow(new Date(starts_at), snapshot.settings.time_zone).minutes);
    return { changes: [{ table: "blocks", id: b.id, update: { starts_at, ends_at, auto: false, gcal_id: null } }, ...pending], text: `Moved to ${at} · ${task.title}` };
  },
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

// --- The thumb keyboard (research/plan-phone.md P6) -------------------------------------------
// A persistent reply keyboard under the chat: ReplyKeyboardMarkup with is_persistent ("always
// show the keyboard when the regular keyboard is hidden") and resize_keyboard (fit two rows, not
// the letter keyboard's height): core.telegram.org/bots/api#replykeyboardmarkup. A key sends its
// label as a text, which capture.mjs's readKey takes before readText, so a label never reaches
// Claude. The telegram function sends it once (settings.keys_sent_at) and on /start or /keys.
export const KEY_LABELS = { Now: "now", Done: "done", "+15 min": "more15", Today: "today" };
export const KEYBOARD = { keyboard: [Object.keys(KEY_LABELS).map((text) => ({ text }))], is_persistent: true, resize_keyboard: true };
const TODAY_MAX = 8;

// What a key does, against the same snapshot as a tap: { changes, text, keyboard?, block_id? },
// keyboard being inline rows for the answer and block_id the block it acted on (its older
// messages lose their buttons: deadButtons).
//   now     the pinned Now line, with the running block's Done and Snooze
//   done    the running block's task done, as the Done tap
//   more15  15 more minutes on the running block, or one that ended under FINISHED_LATE ago
//   today   today's open tasks, a Done button each (td:<task id>)
//   keys    the keyboard again
export function keyStep(key, snapshot, now) {
  const t = now.getTime();
  const open = (b) => !b.proposed && snapshot.tasks.some((x) => x.id === b.task_id && !x.done);
  const blocks = [...snapshot.blocks].filter(open).sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at));
  const on = blocks.find((b) => Date.parse(b.starts_at) <= t && t < Date.parse(b.ends_at));
  if (key === "keys") return { changes: [], text: "Shortcuts are on: Now · Done · +15 min · Today.", reply: KEYBOARD };
  if (key === "now") return { changes: [], ...(on ? { block_id: on.id } : {}), text: nowText(snapshot, now), keyboard: on ? [tapButtons(on.id)] : [] };
  if (key === "done") {
    if (!on) return { changes: [], text: "Nothing is on right now." };
    const r = handleTap({ action: "done", block_id: on.id }, snapshot, now);
    const title = snapshot.tasks.find((x) => x.id === on.task_id).title;
    return { changes: r.changes, block_id: on.id, text: `${DONE} · ${title}` };
  }
  if (key === "more15") {
    const b = on ?? blocks.filter((x) => Date.parse(x.ends_at) <= t && t < Date.parse(x.ends_at) + FINISHED_LATE).at(-1);
    if (!b) return { changes: [], text: "Nothing is on right now." };
    const r = handleTap({ action: "more", block_id: b.id, minutes: 15 }, snapshot, now);
    return { changes: r.changes, block_id: b.id, text: r.text };
  }
  if (key === "today") {
    const tz = snapshot.settings.time_zone;
    const { day: today } = localNow(now, tz);
    const first = (task) => blocks.find((b) => b.task_id === task.id && localNow(new Date(b.starts_at), tz).day === today);
    const left = snapshot.tasks.filter((x) => x.day === today && !x.done)
      .map((x) => ({ x, b: first(x) }))
      .sort((p, q) => (p.b ? Date.parse(p.b.starts_at) : Infinity) - (q.b ? Date.parse(q.b.starts_at) : Infinity));
    if (!left.length) return { changes: [], text: "Nothing left today." };
    const lines = left.map(({ x, b }) => (b ? `${formatClock(localNow(new Date(b.starts_at), tz).minutes)} · ${x.title}` : x.title));
    return {
      changes: [],
      text: [`Today: ${left.length} left.`, ...lines.slice(0, TODAY_MAX)].join("\n"),
      keyboard: left.slice(0, TODAY_MAX).map(({ x }) => [{ text: `Done: ${String(x.title).slice(0, 30).trim()}`, callback_data: `td:${x.id}` }]),
    };
  }
  return { changes: [], text: "" };
}

// Whether the tick sends the keyboard now: once ever (settings.keys_sent_at, null until sent;
// absent before its column exists, and then never), while he's up, as the pinned message.
export function keysDue(snapshot, now) {
  if (!telegramOn(snapshot.settings) || !("keys_sent_at" in snapshot.settings) || snapshot.settings.keys_sent_at) return false;
  const day = dayOf(snapshot, now);
  return day.minutes >= day.openAt && day.minutes < QUIET_FROM;
}

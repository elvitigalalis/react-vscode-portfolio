// The Telegram messages (docs/sheet-nudges.md, "Messages"): which are due at a given minute.
// Kept free of the network so node --test covers it; the `telegram` Edge Function
// (supabase/functions/telegram) imports it, so the rules live only here.
//
// Nothing is booked ahead: each run works the messages out again from a snapshot of the day,
// and the nudges log is what stops one going out twice.
import { ORIGIN } from "../site.mjs";
import { localNow, zonedIso, minutesOn, atRisk, dueLabel } from "./logic.mjs";

// Quiet hours run from 11 pm to 8 am; the brief opens the day.
export const QUIET_FROM = 23 * 60;
export const BRIEF_AT = 8 * 60;
// The nudge budget: nudges, repeats and snoozes a day, not counting the brief or the check-in.
export const BUDGET = 6;

const PLAN_URL = `${ORIGIN}/plan/`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A snapshot of the day, as the Edge Function reads it:
//   settings  the settings row (time_zone, telegram_chat_id, nudges_on)
//   day       today's days row, or null
//   tasks     today's tasks, plus every undone task with a due date
//   blocks    today's blocks, plus every block of those tasks
//   log       today's rows of the nudges log
// Returns the messages due at `now`: { kind, block_id, day, send_at, text, buttons }, where
// send_at is the minute the message belongs to (it may be earlier than `now` if a run was late)
// and a button has either a url or, for later taps, callback data.
export function whatToSend(snapshot, now) {
  const { time_zone: tz, nudges_on, telegram_chat_id } = snapshot.settings;
  if (!nudges_on || !telegram_chat_id) return [];
  const { day: today, minutes } = localNow(now, tz);
  if (minutes < BRIEF_AT || minutes >= QUIET_FROM) return [];
  // Proposed blocks aren't part of the plan until approved: they count for nothing here.
  const day = { ...snapshot, blocks: snapshot.blocks.filter((b) => !b.proposed), today, tz };
  // Each kind of message is one rule over the same day; later kinds join this list.
  return [brief(day)]
    .filter((m) => Date.parse(m.send_at) <= now.getTime() && !logged(snapshot.log, m));
}

// One message per block, kind, day and send-at minute: the log's unique key.
const logged = (log, m) => log.some((n) => n.block_id === m.block_id && n.kind === m.kind && n.day === m.day
  && Date.parse(n.send_at) === Date.parse(m.send_at));

// The morning brief: what today holds, at 8:00. Private tasks show their real titles: the
// messages go only to Lisul.
function brief({ tasks, blocks, today, tz }) {
  const todays = tasks.filter((t) => t.day === today);
  const blocksToday = blocks.filter((b) => { const m = minutesOn(b.starts_at, today, tz); return m >= 0 && m < 1440; });
  const risky = tasks.filter((t) => atRisk(t, blocks, today, tz)).sort((a, b) => a.due.localeCompare(b.due));
  const n = blocksToday.length;
  const lines = [`Today: ${plural(todays.length, "task")}, ${plural(n, "block")}${n > BUDGET ? `, nudging the first ${BUDGET}` : ""}.`];
  if (risky.length) lines.push(`At risk: ${risky.map((t) => `${t.title} (${dueLabel(t.due, today)})`).join(", ")}.`);
  if (!n) lines.push('Nothing planned yet: say "plan my day" to Claude.');
  const text = todays.length || n || risky.length ? lines.join("\n") : "Nothing on today.";
  return { kind: "brief", block_id: null, day: today, send_at: zonedIso(today, BRIEF_AT, tz), text, buttons: [{ text: "Open /plan", url: PLAN_URL }] };
}

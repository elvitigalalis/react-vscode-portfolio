// Focus mode on /plan (docs/sheet-focus.md): the plain logic, with no DOM and no network.
// focus-start.mjs (on the page from the start) and focus-view.mjs (loaded on first Start) use it.
import { localNow, minutesOn } from "./logic.mjs";
import { paceKind } from "./pace.mjs";

// The block Start goes on: today's approved task block that is on now, else the next one today.
// Habit blocks (no task) and blocks of done tasks get none.
export function focusTarget(blocks, tasks, now, timeZone) {
  const t = now.getTime();
  const today = localNow(now, timeZone).day;
  const open = blocks
    .filter((b) => !b.proposed && b.task_id && tasks.get(b.task_id) && !tasks.get(b.task_id).done)
    .filter((b) => Date.parse(b.ends_at) > t && localNow(new Date(b.starts_at), timeZone).day === today)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  return open[0] ?? null;
}

// --- The session ---------------------------------------------------------------------------

// A session is what Start keeps in this browser (focus-start.mjs, localStorage), so leaving focus
// or reloading keeps the timer: the block and task, when Start was tapped and when the block ends,
// in epoch ms. The clock runs from these alone, so it keeps time offline.
export const startSession = (b, now) => ({ block_id: b.id, task_id: b.task_id, started_at: now.getTime(), ends_at: Date.parse(b.ends_at) });

export function readSession(raw) {
  let s;
  try { s = JSON.parse(raw); } catch { return null; }
  const whole = s && typeof s === "object" && typeof s.block_id === "string" && typeof s.task_id === "string"
    && Number.isFinite(s.started_at) && Number.isFinite(s.ends_at);
  return whole ? { block_id: s.block_id, task_id: s.task_id, started_at: s.started_at, ends_at: s.ends_at } : null;
}

// "24:30", or "1:02:03" from an hour on; whole seconds, rounded down.
export function countdown(ms) {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// What the view shows at `now`: time left to the block's end ("+2:05" once past it), time since
// Start, and the share of the session gone (0–1) for its thin bar.
export function focusClock(s, now) {
  const t = now.getTime();
  const over = t >= s.ends_at;
  const span = s.ends_at - s.started_at;
  return {
    left: over ? `+${countdown(t - s.ends_at)}` : countdown(s.ends_at - t),
    elapsed: countdown(t - s.started_at),
    over,
    share: over || span <= 0 ? 1 : Math.max(0, (t - s.started_at) / span),
  };
}

// --- Done and +15 min ------------------------------------------------------------------------

// Done's actuals row, as record_focus takes it (supabase/schema.sql): the minutes from Start to
// Done, rounded and held to actuals' 1–960, on the day the session started, with the task's pace
// kind and estimate, as Telegram's Finished writes them (nudges.mjs). Under a minute: none.
export function focusActual(s, task, now, timeZone) {
  const minutes = Math.min(Math.round((now.getTime() - s.started_at) / 60_000), 960);
  if (minutes < 1) return null;
  return { task: s.task_id, block: s.block_id, d: localNow(new Date(s.started_at), timeZone).day, kind: paceKind(task), est: task.est_min ?? null, minutes };
}

export const EXTEND_MIN = 15;
const QUIET_FROM = 23 * 60; // as nudges.mjs: nothing runs into quiet hours

// +15 min: the block's new end and the session with it, when the 15 minutes after the block's end
// overlap no other approved block and no busy time in `taken` (blocks and busy Google events), and
// end by 11 pm, as Telegram's More time checks its 30. Proposed blocks don't count. A block gone
// from the plan moves only the timer (ends_at null). Otherwise { why }.
export function extendFocus(s, b, taken, timeZone) {
  const add = EXTEND_MIN * 60_000;
  if (!b) return { ends_at: null, session: { ...s, ends_at: s.ends_at + add } };
  const from = Date.parse(b.ends_at);
  const to = from + add;
  const ends_at = new Date(to).toISOString();
  if (minutesOn(ends_at, localNow(new Date(b.starts_at), timeZone).day, timeZone) > QUIET_FROM) return { why: "Too close to quiet hours" };
  if (taken.some((x) => x.id !== b.id && !x.proposed && Date.parse(x.starts_at) < to && Date.parse(x.ends_at) > from)) return { why: `The next ${EXTEND_MIN} min aren't free` };
  return { ends_at, session: { ...s, ends_at: to } };
}

// --- Writes that wait for the network --------------------------------------------------------

// Done and +15 min save through an outbox kept beside the session, so a write made offline (or
// that failed) is tried again on the next load or when the browser is back online. The ops are
// { op: "actual", row } (record_focus), { op: "done", task } and { op: "extend", block, ends_at }.
const OPS = new Set(["actual", "done", "extend"]);
export function readOutbox(raw) {
  let q;
  try { q = JSON.parse(raw); } catch { return []; }
  return Array.isArray(q) ? q.filter((o) => o && typeof o === "object" && OPS.has(o.op)) : [];
}

// Runs the ops in order with `run`; the first that throws stops the drain, so Done's actuals row
// always lands before its task is marked done. Returns the ops left.
export async function drainOutbox(ops, run) {
  const left = [...ops];
  while (left.length) {
    try { await run(left[0]); } catch { return left; }
    left.shift();
  }
  return left;
}

// --- Stuck ---------------------------------------------------------------------------------

// Stuck's message to Claude, sent through /plan's message box (message-box.mjs), so the to-dos it
// adds show under Recent messages, each with Undo.
export function stuckMessage(task, b, today) {
  const first = b?.first_step ? ` Its first step was: ${b.first_step}.` : "";
  return `I'm stuck on "${task.title}". Break it into 2-4 smaller to-dos for today (${today}), about 10-25 min each, in the order to do them, each a concrete action.${first}`;
}

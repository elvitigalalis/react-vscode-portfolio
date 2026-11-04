// Replans during the day (docs/sheet-v5.md, "replan.mjs"; spec 47, "Replan decision"). Syncs log
// each change they find as a `changes` row with a fixed reason and weight; the telegram minute
// tick asks shouldReplan whether those changes matter enough to start the morning task again.
// Kept free of the network so node --test covers it.
import { SHEET } from "../site.mjs";
import { localNow } from "./logic.mjs";

// Every reason a change can carry: its kind (routine-fire.mjs's REASONS), weight and words.
const REASONS = {
  busy_overlap: ["busy", 10, "a busy time landed on a block"],
  time_freed: ["busy", 4, "time freed up"],
  busy_change: ["busy", 2, "busy times changed"],
  course_due_soon: ["course", 8, "a course task is due within 48 hours"],
  course_change: ["course", 3, "course tasks changed"],
  campus_change: ["campus", 3, "campus events changed"],
  mail_owed: ["mail", 8, "a known sender is waiting on a reply"],
  mail_new: ["mail", 2, "new mail"],
  github_due_soon: ["github", 8, "a GitHub item is due within 48 hours"],
  github_change: ["github", 3, "GitHub items changed"],
  jira_due_soon: ["jira", 8, "a Jira ticket is due within 48 hours"],
  jira_change: ["jira", 3, "Jira tickets changed"],
  slack_new: ["slack", 3, "new Slack mentions"],
  handshake_change: ["handshake", 3, "Handshake events changed"],
};

// The reasons' words, for the replan message.
export const REASON_WORDS = Object.fromEntries(Object.entries(REASONS).map(([r, [, , words]]) => [r, words]));

// "a busy time landed on a block, new mail", in the order given.
export const reasonWords = (reasons) => reasons.map((r) => REASON_WORDS[r]).filter(Boolean).join(", ");

// The changes row a sync writes for `reason`: { kind, reason, weight, ref }. `ref` is an id in
// the source (never a title), cut to the column's 200 characters.
export function changeRow(reason, ref = null) {
  const [kind, weight] = REASONS[reason] ?? [];
  if (!kind) throw new Error(`replan: unknown reason ${reason}`);
  return { kind, reason, weight, ref: ref == null ? null : String(ref).slice(0, 200) };
}

// The rules and holds (spec 47).
const FIRE_WEIGHT = 8;
const SUM_WEIGHT = 4;
const SUM_AGE = 15 * 60_000;
const ANY_AGE = 45 * 60_000;
const DAILY_CAP = 8;
const PLAN_GAP = 60 * 60_000;
const EDIT_GAP = 10 * 60_000;
// Quiet hours, as nudges.mjs has them (not imported: nudges.mjs imports this module).
const OPEN_FROM = 8 * 60;
const QUIET_FROM = 23 * 60;

const hhmm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
const ms = (iso) => (iso == null ? null : Date.parse(iso));

// Whether to start a replan at `now`: { fire: true, reasons, counts, ids } or { fire: false, hold }.
// `changes` are the rows not yet tied to a replan or a revision; `state` is { settings: {
// time_zone, replans_on, morning_on }, day, shutdown: "HH:MM", plans_today, last_plan_at,
// last_edit_at }. The holds come first, in the contract's order, then the rules.
export function shouldReplan(changes, state, now) {
  const { settings, day, shutdown, plans_today, last_plan_at, last_edit_at } = state;
  const t = now.getTime();
  const { minutes } = localNow(now, settings.time_zone);
  const lastPlan = ms(last_plan_at), lastEdit = ms(last_edit_at);
  const hold = !settings.replans_on ? "replans_off"
    : !settings.morning_on ? "morning_off"
    : minutes < OPEN_FROM || minutes >= QUIET_FROM ? "quiet"
    : day?.shutdown ? "shut_down"
    : minutes >= hhmm(shutdown) ? "after_shutdown"
    : plans_today >= DAILY_CAP ? "daily_cap"
    : lastPlan != null && t - lastPlan < PLAN_GAP ? "too_soon"
    : lastEdit != null && t - lastEdit < EDIT_GAP ? "editing"
    : null;
  if (hold) return { fire: false, hold };
  // The plan already saw anything at or before it (the run's own proposal included).
  const left = changes.filter((c) => { const at = Date.parse(c.at); return at <= t && (lastPlan == null || at > lastPlan); });
  if (!left.length) return { fire: false, hold: "nothing" };
  const oldest = t - Math.min(...left.map((c) => Date.parse(c.at)));
  const sum = left.reduce((n, c) => n + c.weight, 0);
  const fire = left.some((c) => c.weight >= FIRE_WEIGHT) || (sum >= SUM_WEIGHT && oldest >= SUM_AGE) || oldest >= ANY_AGE;
  if (!fire) return { fire: false, hold: "waiting" };
  const weight = {};
  const counts = {};
  for (const c of left) {
    weight[c.reason] = Math.max(weight[c.reason] ?? 0, c.weight);
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  }
  const reasons = Object.keys(weight).sort((a, b) => weight[b] - weight[a] || (a < b ? -1 : 1));
  return { fire: true, reasons, counts, ids: left.map((c) => c.id) };
}

// The `state` shouldReplan takes, from today's rows as the telegram tick reads them: settings,
// today's days row (or null), today's proposals rows and today's replans rows. The shutdown
// line is the day's, or the default; a morning revision counts as one plan and each replan as
// another; the last plan is the newest of either.
export function replanState({ settings, day, proposals, replans }) {
  // A replan that failed or was rate limited never ran, so it counts for neither.
  const fired = replans.filter((r) => r.result == null || r.result === "started");
  const times = [...proposals.map((p) => p.created_at), ...fired.map((r) => r.at)].filter(Boolean);
  const last = times.length ? Math.max(...times.map((x) => Date.parse(x))) : null;
  return {
    settings: { time_zone: settings.time_zone, replans_on: !!settings.replans_on, morning_on: !!settings.morning_on },
    day: day ?? null,
    shutdown: String(day?.shutdown_at ?? SHEET.shutdownAt).slice(0, 5),
    plans_today: (proposals.some((p) => (p.run_trigger ?? "morning") === "morning") ? 1 : 0) + fired.length,
    last_plan_at: last == null ? null : new Date(last).toISOString(),
    last_edit_at: settings.plan_edited_at ?? null,
  };
}

// What the tick writes after a fire: the replans row's patch, and whether to untie its changes
// (replan_id back to null) so the next tick weighs them again. `out` is fireRoutine's result;
// `thrown` an error it threw instead, which is recorded as a failure.
export function fireOutcome(out, thrown = null) {
  if (thrown) return { patch: { result: "failed", error: String(thrown?.message ?? thrown).slice(0, 300) }, untie: true };
  if (out.ok) return { patch: { result: "started", session_id: out.session_id }, untie: false };
  if (out.status === 429) return { patch: { result: "rate_limited", error: out.error, retry_after: out.retry_at }, untie: true };
  return { patch: { result: "failed", error: out.error }, untie: true };
}

// Whether a 429 still holds: no replan fires before a replans row's retry_after.
export const rateLimited = (replans, now) => replans.some((r) => r.retry_after && Date.parse(r.retry_after) > now.getTime());

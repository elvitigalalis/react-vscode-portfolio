// The morning plan's pure side (docs/sheet-morning.md, "proposal.mjs"; ADR 0003): what
// read_planner shows Claude, the checks a submitted proposal must pass before apply_proposal
// writes it, and the lines the brief adds for it. Kept free of the network and of Node APIs so
// node --test covers it; the planner-mcp and telegram Edge Functions import it.
import { localNow, zonedIso, minutesOn, planningDay, atRisk, addDays, formatClock, blockMinutes, plural, proposedOn } from "./logic.mjs";
import { freeFood } from "./campus.mjs";

// --- read_planner ----------------------------------------------------------------------------

// Course tasks due within this many days of the planning day go in the task list.
const COURSE_AHEAD = 7;
// The day's shutdown line when it has none of its own.
const DEFAULT_SHUTDOWN = "17:00";

// Whether an ISO span overlaps the local day `day` in `timeZone`.
const onDay = (s, day, timeZone) => minutesOn(s.ends_at, day, timeZone) > 0 && minutesOn(s.starts_at, day, timeZone) < 1440;

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
  const seen = new Set();
  const tasks = groups.flat().filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({
    id: t.id, title: t.title, est_min: t.est_min, at_time: t.at_time, due: t.due, tag: t.tag,
    source: t.source, day: t.day, list: t.list, at_risk: risky(t),
  }));
  return {
    now: now.toISOString(),
    time_zone: tz,
    plan_day: day,
    shutdown: line ? line.slice(0, 5) : DEFAULT_SHUTDOWN,
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
    proposal: rows.proposal ? { status: rows.proposal.status, created_at: rows.proposal.created_at } : null,
    needs_you_open: rows.needsOpen.map((n) => ({ account: n.account, message_id: n.message_id })),
    accounts: rows.accounts.map((a) => a.email),
  };
}

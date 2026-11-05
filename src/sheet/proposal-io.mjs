// The rows planner-mcp reads for read_planner and submit_proposal (docs/sheet-morning.md,
// "Contracts → Edge Functions"), before planSnapshot (proposal.mjs) shapes them. Each query is
// { table, select, filters: [[column, operator, value]], or?, order? }: the function applies it
// with supabase-js's .select(), .filter(), .or() and .order()
// (https://supabase.com/docs/reference/javascript/filter), and queryPath writes it as the
// PostgREST path it becomes (https://docs.postgrest.org/en/stable/references/api/tables_views.html).
import { addDays, localNow, planningDay, zonedIso } from "./logic.mjs";

// The query as a PostgREST path, as supabase-js sends it.
export function queryPath({ table, select, filters = [], or, order }) {
  return [
    `${table}?select=${select}`,
    ...filters.map(([column, op, value]) => `${column}=${op}.${value}`),
    ...(or ? [`or=(${or})`] : []),
    ...(order ? [`order=${order}`] : []),
  ].join("&");
}

// What to read once settings has given the time zone. plan_day follows the 3 pm rule. Its
// bounds are its local midnights, so a daylight-saving day is 23 or 25 hours. Tasks are
// plan_day's and every undone one due within 7 days of it (past due included); blocks are
// plan_day's plus every block of those tasks, since atRisk counts a block on any earlier day.
// Campus events leave out description and url, so their free text never reaches Claude; open
// needs_you rows and mail accounts are read only as far as the snapshot shows them.
// A replan run passes its own plan_day (today, planDayOf in proposal.mjs), even from 3 pm.
export function snapshotQueries(now, timeZone, plan_day = planningDay(localNow(now, timeZone))) {
  const from = zonedIso(plan_day, 0, timeZone);
  const to = zonedIso(addDays(plan_day, 1), 0, timeZone);
  const overlaps = [["starts_at", "lt", to], ["ends_at", "gt", from]];
  return {
    plan_day,
    queries: {
      tasks: { table: "tasks", select: "*", filters: [["done", "is", "false"]], or: `day.eq.${plan_day},due.lte.${addDays(plan_day, 7)}`, order: "position" },
      busy: { table: "busy", select: "starts_at,ends_at", filters: overlaps, order: "starts_at" },
      days: { table: "days", select: "*", filters: [["day", "eq", plan_day]] },
      campus: {
        table: "campus_events",
        select: "uid,title,starts_at,ends_at,all_day,group_name,event_type,tags,rsvp_count",
        filters: [["starts_at", "gte", from], ["starts_at", "lt", to]],
        order: "starts_at",
      },
      // v5: newest revision first; the snapshot takes the first row.
      proposal: { table: "proposals", select: "*", filters: [["day", "eq", plan_day]], order: "rev.desc" },
      needsOpen: { table: "needs_you", select: "account,message_id", filters: [["done", "is", "false"]], order: "created_at" },
      accounts: { table: "mail_accounts", select: "email", order: "connected_at" },
    },
    // Task ids are uuids from the tasks read, so they go into in.() as they are.
    blocks: (taskIds) => ({
      table: "blocks",
      select: "task_id,habit_id,starts_at,ends_at,proposed,auto",
      or: [`and(starts_at.lt.${to},ends_at.gt.${from})`, ...(taskIds.length ? [`task_id.in.(${taskIds.join(",")})`] : [])].join(","),
      order: "starts_at",
    }),
  };
}

// v5 P1, pace (docs/sheet-v5.md, "pace.mjs"): every actuals row (nightly_roll keeps 120 days),
// and the approved blocks of the 14 days before plan_day with their task's done, embedded through
// blocks.task_id (https://docs.postgrest.org/en/stable/references/api/resource_embedding.html).
export function paceQueries(now, timeZone, plan_day = planningDay(localNow(now, timeZone))) {
  return {
    actuals: { table: "actuals", select: "at,kind,est_min,minutes", order: "at" },
    past: {
      table: "blocks",
      select: "task_id,starts_at,ends_at,proposed,task:tasks(done)",
      filters: [["proposed", "is", "false"], ["starts_at", "gte", zonedIso(addDays(plan_day, -14), 0, timeZone)], ["starts_at", "lt", zonedIso(plan_day, 0, timeZone)]],
      order: "starts_at",
    },
  };
}

// v5 H1, habits (docs/sheet-v5.md, "planSnapshot"): every habits row; planSnapshot keeps
// plan_day's weekday's and orders them.
export const habitsQuery = () => ({ table: "habits", select: "id,name,days,ideal,minutes,flex_min,defence,position", order: "position" });

// v5 R1, replans (docs/sheet-v5.md, "planSnapshot"): plan_day's newest replans row, and the
// changes since `proposal` (the newest revision, or plan_day's start without one) up to now, as
// kinds only. planSnapshot turns them into `run`.
export function replanQueries(now, timeZone, proposal, plan_day = planningDay(localNow(now, timeZone))) {
  const since = proposal?.created_at ?? zonedIso(plan_day, 0, timeZone);
  return {
    replan: { table: "replans", select: "day,at,reasons,result", filters: [["day", "eq", plan_day]], order: "at.desc" },
    changes: { table: "changes", select: "at,kind", filters: [["at", "gt", since], ["at", "lte", now.toISOString()]], order: "at" },
  };
}

// What planDayOf (proposal.mjs) decides plan_day from: today's newest replans row, today's
// newest revision and the newest fired message. Replans are only ever for today, so a replan run plans the rest of today.
export function todayReplanQueries(now, timeZone) {
  const today = localNow(now, timeZone).day;
  return {
    replan: { table: "replans", select: "day,at,reasons,result", filters: [["day", "eq", today]], order: "at.desc" },
    proposal: { table: "proposals", select: "created_at", filters: [["day", "eq", today]], order: "rev.desc" },
    // The newest fired message: a message run may go on as a replan of today (messageRunOf).
    message: { table: "messages", select: "fired_at", filters: [["fired_at", "not.is", "null"]], order: "fired_at.desc" },
  };
}

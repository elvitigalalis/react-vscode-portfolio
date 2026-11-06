// The slack-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): Slack mentions and direct
// messages to Lisul since the last sync become Needs you rows, written by code with no AI.
// pg_cron calls it at :42 every hour (supabase/schema.sql, "sheet-slack"). slackNeeds
// (src/sheet/sources.mjs), the function the tests cover, decides the rows; this file only fetches
// and writes what it says. A row holds the channel, the person and the permalink, never the
// message text: the text is in each search match, and goes no further than this function's memory.
// Nothing here logs a match.
//
// - auth.test (https://docs.slack.dev/reference/methods/auth.test: no scopes required) gives his
//   user id, for the mentions query and to leave out his own messages.
// - search.messages (https://docs.slack.dev/reference/methods/search.messages: user tokens only,
//   scope search:read, Tier 2; `count` up to 100, `sort=timestamp`; matches carry channel { id,
//   name, is_im }, user, username, ts, permalink, text; messages.pagination.page_count) runs twice:
//   `<@USERID> after:<date>` for mentions and `to:me after:<date>` for DMs. `after:` takes a date
//   and means the days after it (https://slack.com/help/articles/202528808-Search-in-Slack, "before:,
//   after:, on:"), so the searches start the day before the last good sync; the overlap is
//   skipped by `known`.
// - The Web API takes the token in an Authorization: Bearer header, arguments as a query string,
//   and answers { ok: false, error: "<code>" } when a call fails
//   (https://docs.slack.dev/apis/web-api/).
//
// `known` is every slack needs_you row still there (done or not) plus the ids in feed_seen
// ('slack', id), since nightly_roll deletes done rows: a mention he marked done never comes back.
// Each new row writes a slack_new change of weight 3 for the replan decision.
//
// Deploy from the repo root, as work-sync:
//   npx supabase functions deploy slack-sync --use-api --no-verify-jwt
//
// Secrets (function secrets, set by Lisul, never in the repo or a column): SHEET_SLACK_TOKEN (a
// user token, xoxp-, from a Slack app of his own with only the search:read user scope) and
// SHEET_CRON_SECRET. With no token it records { ok: null, error: 'not connected' }. The token is
// never logged or written to feed_state.
import { slackNeeds } from "../../../src/sheet/sources.mjs";
import { changeRow } from "../../../src/sheet/replan.mjs";
import { addDays, localNow } from "../../../src/sheet/logic.mjs";
import { slackSince } from "../../../src/sheet/feed-state.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const SLACK_TOKEN = env("SHEET_SLACK_TOKEN");
const PER_PAGE = 100;
const PAGES = 3;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const fetched_at = now.toISOString();
  if (!SLACK_TOKEN) {
    await saveFeedState("slack", { fetched_at, ok: null, error: "not connected" });
    return Response.json({ ok: true, skipped: "not connected" });
  }
  try {
    const [settings] = await db("settings?select=time_zone");
    const timeZone = settings.time_zone;
    // The last good sync, however many failed since, or a day ago the first time (slackSince).
    const [last] = await db("feed_state?select=fetched_at,ok,last_ok_at&source=eq.slack");
    const since = slackSince(last, now);
    const after = addDays(localNow(since, timeZone).day, -1);
    const self = await userId();
    const matches = [...await search(`<@${self}> after:${after}`), ...await search(`to:me after:${after}`)];
    const known = [
      ...(await db("needs_you?select=message_id&source=eq.slack")),
      ...(await db("feed_seen?select=uid&source=eq.slack")).map((r: { uid: string }) => ({ message_id: r.uid })),
    ];
    const rows = slackNeeds(matches, { known, self });
    await save(rows, localNow(now, timeZone).day);
    await saveFeedState("slack", { fetched_at, ok: true, error: null, items: matches.length });
    return Response.json({ ok: true, read: matches.length, inserted: rows.length });
  } catch (e) {
    // feedFailed takes the token and any link out of the error (_shared/server.ts).
    return await feedFailed("slack", e, fetched_at, [SLACK_TOKEN]);
  }
});

// As work-sync: the rows first, then their ids, so a run that dies between the two still finds
// the row holding the id next time. Then the changes the replan decision weighs.
async function save(rows: Record<string, unknown>[], day: string) {
  if (!rows.length) return;
  await db("needs_you?on_conflict=account,message_id", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows.map((r) => ({ ...r, day }))),
  });
  await db("feed_seen?on_conflict=source,uid", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(rows.map((r) => ({ source: "slack", uid: r.message_id }))),
  });
  await db("changes", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(rows.map((r) => changeRow("slack_new", r.message_id))),
  });
}

// --- Slack ------------------------------------------------------------------------------------

// One Web API call. A failure throws with the HTTP status or Slack's error code only, never the
// body (a search body holds message text).
async function slack(method: string, params: Record<string, string> = {}) {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  if (res.status === 429) throw new Error("slack: rate limited");
  if (!res.ok) throw new Error(`slack: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.ok !== true) {
    const code = String(body?.error ?? "");
    throw new Error(`slack: ${/^[a-z_]{1,40}$/.test(code) ? code : "error"}`);
  }
  return body;
}

async function userId() {
  const id = String((await slack("auth.test")).user_id ?? "");
  if (!/^[UW][A-Z0-9]{2,20}$/.test(id)) throw new Error("slack: auth.test gave no user id");
  return id;
}

// Up to PAGES pages of one search, newest first. Older matches past them were seen by an earlier
// run, which searched the same days.
async function search(query: string) {
  const matches: unknown[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const body = await slack("search.messages", { query, count: String(PER_PAGE), page: String(page), sort: "timestamp", sort_dir: "desc" });
    matches.push(...(Array.isArray(body?.messages?.matches) ? body.messages.matches : []));
    if (page >= Number(body?.messages?.pagination?.page_count ?? 1)) break;
  }
  return matches;
}

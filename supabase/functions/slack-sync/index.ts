// The slack-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): reads Slack mentions and
// direct messages to Lisul since the last sync and records how many in feed_state, so Settings
// and the health check show whether the Slack token still works. pg_cron calls it at :42 every
// hour (supabase/schema.sql, "sheet-slack"). It writes nothing else: Slack no longer feeds Needs
// you (Needs you is mail and Jira only), and it logs no replan change either. The text of each
// search match goes no further than this function's memory; nothing here logs a match.
//
// - auth.test (https://docs.slack.dev/reference/methods/auth.test: no scopes required) gives his
//   user id, for the mentions query.
// - search.messages (https://docs.slack.dev/reference/methods/search.messages: user tokens only,
//   scope search:read, Tier 2; `count` up to 100, `sort=timestamp`; matches carry channel { id,
//   name, is_im }, user, username, ts, permalink, text; messages.pagination.page_count) runs twice:
//   `<@USERID> after:<date>` for mentions and `to:me after:<date>` for DMs. `after:` takes a date
//   and means the days after it (https://slack.com/help/articles/202528808-Search-in-Slack, "before:,
//   after:, on:"), so the searches start the day before the last good sync.
// - The Web API takes the token in an Authorization: Bearer header, arguments as a query string,
//   and answers { ok: false, error: "<code>" } when a call fails
//   (https://docs.slack.dev/apis/web-api/).
//
// Deploy from the repo root, as work-sync:
//   npx supabase functions deploy slack-sync --use-api --no-verify-jwt
//
// Secrets (function secrets, set by Lisul, never in the repo or a column): SHEET_SLACK_TOKEN (a
// user token, xoxp-, from a Slack app of his own with only the search:read user scope) and
// SHEET_CRON_SECRET. With no token it records { ok: null, error: 'not connected' }. The token is
// never logged or written to feed_state.
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
    await saveFeedState("slack", { fetched_at, ok: true, error: null, items: matches.length });
    return Response.json({ ok: true, read: matches.length });
  } catch (e) {
    // feedFailed takes the token and any link out of the error (_shared/server.ts).
    return await feedFailed("slack", e, fetched_at, [SLACK_TOKEN]);
  }
});

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

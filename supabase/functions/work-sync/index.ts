// The work-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): turns GitHub review requests
// and assigned issues in Lisul's orgs, and his open Jira tickets, into private tasks in the
// "GitHub" and "Jira" Someday lists. pg_cron calls it at :40 every hour (supabase/schema.sql,
// "sheet-work"). Both reads are read-only; githubTaskChanges and jiraTaskChanges
// (src/sheet/sources.mjs), the functions the tests cover, decide what changes; this file only
// fetches and writes what they say. Only titles, links and due dates are ever stored.
//
// - GitHub: GET /search/issues for `is:open review-requested:@me` and `is:open assignee:@me`
//   (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests: at most 100
//   per page and 30 requests a minute when signed in; `incomplete_results` is true when the search
//   timed out). Only repositories in settings.github_orgs count. Recorded in feed_state as
//   "github".
// - Jira: POST /rest/api/3/search/jql for `assignee = currentUser() AND statusCategory != Done`
//   with fields summary and duedate only, paged by nextPageToken until isLast
//   (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/,
//   "Search for issues using JQL enhanced search (POST)"; basic auth with an email and API token,
//   scope read:jira-work). Recorded as "jira".
//
// A task closes when its item is no longer listed: the review was done, the issue closed or the
// ticket finished. So a list that may be cut short (a search that timed out, more results than
// one page, Jira pages left over) closes nothing that run. A source whose secret isn't set
// records { ok: null, error: 'not connected' }; one failing doesn't stop the other.
//
// Deploy from the repo root, as brightspace:
//   npx supabase functions deploy work-sync --use-api --no-verify-jwt
//
// Secrets (function secrets, set by Lisul, never in the repo or a column): SHEET_GITHUB_TOKEN (a
// fine-grained token with read-only Pull requests, Issues and Metadata on his orgs),
// SHEET_JIRA_TOKEN, SHEET_JIRA_EMAIL and SHEET_JIRA_SITE ("<name>.atlassian.net"), and
// SHEET_CRON_SECRET. Tokens are never logged or written to feed_state.
import { githubTaskChanges, jiraTaskChanges } from "../../../src/sheet/sources.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const GITHUB_TOKEN = env("SHEET_GITHUB_TOKEN");
const JIRA_TOKEN = env("SHEET_JIRA_TOKEN");
const JIRA_EMAIL = env("SHEET_JIRA_EMAIL");
const JIRA_SITE = env("SHEET_JIRA_SITE").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
const PER_PAGE = 100;
const JIRA_PAGES = 5;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const [settings] = await db("settings?select=time_zone,github_orgs");
  const today = localNow(now, settings?.time_zone ?? "America/New_York").day;
  const orgs: string[] = settings?.github_orgs ?? [];
  const out = {
    github: await source("github", Boolean(GITHUB_TOKEN), [GITHUB_TOKEN], now, async () => {
      const { items, whole } = await githubItems();
      return { read: items.length, whole, changes: githubTaskChanges(items, { ...(await planner("github")), orgs, today }) };
    }),
    jira: await source("jira", Boolean(JIRA_TOKEN && JIRA_EMAIL && JIRA_SITE), [JIRA_TOKEN, JIRA_EMAIL, JIRA_SITE], now, async () => {
      if (!/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(JIRA_SITE)) throw new Error("jira: SHEET_JIRA_SITE isn't <name>.atlassian.net");
      const { issues, whole } = await jiraIssues();
      return { read: issues.length, whole, changes: jiraTaskChanges(issues, { ...(await planner("jira")), site: JIRA_SITE, today }) };
    }),
  };
  const ok = out.github.ok !== false && out.jira.ok !== false;
  return Response.json({ ok, ...out }, { status: ok ? 200 : 502 });
});

// --- Sync -------------------------------------------------------------------------------------

type Changes = {
  insert: Record<string, unknown>[];
  update: { id: string; title: string; due: string | null }[];
  close: string[];
  seen: { source: string; uid: string }[];
  changes: Record<string, unknown>[];
};

// One source's run: fetch, save, and record it.
async function source(name: string, connected: boolean, secrets: string[], now: Date,
  read: () => Promise<{ read: number; whole: boolean; changes: Changes }>) {
  const fetched_at = now.toISOString();
  if (!connected) {
    await saveFeedState(name, { fetched_at, ok: null, error: "not connected" });
    return { ok: null, skipped: "not connected" };
  }
  try {
    const { read: items, whole, changes } = await read();
    await save(changes, whole);
    await saveFeedState(name, { fetched_at, ok: true, error: null, items });
    return { ok: true, items, inserted: changes.insert.length, updated: changes.update.length, closed: whole ? changes.close.length : 0 };
  } catch (e) {
    // feedFailed takes the tokens and any link out of the error (_shared/server.ts).
    await feedFailed(name, e, fetched_at, secrets);
    return { ok: false };
  }
}

// The source's tasks and feed_seen uids.
async function planner(name: string) {
  const tasks = await db(`tasks?select=id,title,due,done,source,source_uid&source=eq.${name}`);
  const seen = (await db(`feed_seen?select=uid&source=eq.${name}`)).map((r: { uid: string }) => r.uid);
  return { tasks, seen };
}

// As brightspace: tasks first, then their uids, so a run that dies between the two still finds
// the task holding the uid next time. Closing is skipped when the list may be cut short.
async function save(c: Changes, whole: boolean) {
  if (c.insert.length) {
    await db("tasks?on_conflict=source,source_uid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(c.insert),
    });
  }
  if (c.seen.length) {
    await db("feed_seen?on_conflict=source,uid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(c.seen),
    });
  }
  for (const u of c.update) {
    await db(`tasks?id=eq.${u.id}&done=is.false`, { method: "PATCH", body: JSON.stringify({ title: u.title, due: u.due }) });
  }
  if (whole && c.close.length) {
    await db(`tasks?id=in.(${c.close.join(",")})&done=is.false`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  }
  // v5 R1: what the replan decision weighs, once the tasks are in.
  if (c.changes.length) await db("changes", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(c.changes) });
}

// --- GitHub -----------------------------------------------------------------------------------

async function githubSearch(q: string) {
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "the-sheet-work-sync",
    },
  });
  if (!res.ok) throw new Error(`github: HTTP ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body?.items) ? body.items : [];
  return { items, whole: body?.incomplete_results === false && Number(body?.total_count) <= items.length };
}

// Both searches, merged; githubTaskChanges counts an item in both once.
async function githubItems() {
  const review = await githubSearch("is:open review-requested:@me");
  const assigned = await githubSearch("is:open assignee:@me");
  return { items: [...review.items, ...assigned.items], whole: review.whole && assigned.whole };
}

// --- Jira -------------------------------------------------------------------------------------

async function jiraIssues() {
  const auth = `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`)}`;
  const issues: unknown[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < JIRA_PAGES; page++) {
    const res = await fetch(`https://${JIRA_SITE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { Authorization: auth, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        jql: "assignee = currentUser() AND statusCategory != Done ORDER BY key",
        fields: ["summary", "duedate"],
        maxResults: PER_PAGE,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`jira: HTTP ${res.status}`);
    const body = await res.json();
    issues.push(...(Array.isArray(body?.issues) ? body.issues : []));
    if (body?.isLast === true) return { issues, whole: true };
    if (!body?.nextPageToken) return { issues, whole: false };
    nextPageToken = body.nextPageToken;
  }
  return { issues, whole: false };
}

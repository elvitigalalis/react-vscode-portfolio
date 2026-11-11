// The work-sync Edge Function (docs/sheet-v5.md, "Edge Functions"): turns GitHub review requests
// and assigned issues in Lisul's orgs, and his open Jira tickets, into private tasks in the
// "GitHub" and "Jira" Someday lists. pg_cron calls it at :40 every hour (supabase/schema.sql,
// "sheet-work"). Both reads are read-only; githubTaskChanges and jiraTaskChanges
// (src/sheet/sources.mjs), the functions the tests cover, decide what changes; this file only
// fetches and writes what they say. Only titles, links and due dates are ever stored.
//
// - GitHub: GET /user for the login, then GET /search/issues for PRs awaiting his review and PRs and issues assigned to him
//   (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests: at most 100
//   per page and 30 requests a minute when signed in; `incomplete_results` is true when the search
//   timed out). Only repositories in settings.github_orgs count. Recorded in feed_state as
//   "github".
// - Jira: POST /rest/api/3/search/jql for `assignee = currentUser() AND statusCategory != Done`
//   with fields summary and duedate only, paged by nextPageToken until isLast
//   (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/,
//   "Search for issues using JQL enhanced search (POST)"; basic auth with an email and API token,
//   scope read:jira-work). Recorded as "jira".
// - Jira updates for Needs you: GET /rest/api/3/myself for his accountId, then the same search
//   for `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND
//   updated >= -2d`, with fields summary, status, assignee, creator, created and comment and
//   expand=changelog. jiraNeeds (src/sheet/sources.mjs) picks the updates that need him and
//   jiraResolved the open rows that no longer do; this file writes needs_you rows with source
//   'jira' (their ids also in feed_seen ('jira-needs', id), so one he marked done never comes
//   back) and marks the resolved ones done. Comment text stays in this function's memory.
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
import { githubTaskChanges, jiraNeeds, jiraResolved, jiraTaskChanges } from "../../../src/sheet/sources.mjs";
import { githubExpiry } from "../../../src/sheet/health.mjs";
import { localNow } from "../../../src/sheet/logic.mjs";
import { db, env, feedFailed, saveFeedState, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const GITHUB_TOKEN = env("SHEET_GITHUB_TOKEN");
const JIRA_TOKEN = env("SHEET_JIRA_TOKEN");
const JIRA_EMAIL = env("SHEET_JIRA_EMAIL");
const JIRA_SITE = env("SHEET_JIRA_SITE").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "");
const PER_PAGE = 100;
const JIRA_PAGES = 5;
const UPDATE_PAGES = 2;
const UPDATE_DAYS = 2;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  const now = new Date();
  const [settings] = await db("settings?select=time_zone,github_orgs");
  const today = localNow(now, settings.time_zone).day;
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
  // Needs you's Jira updates run after the tasks are saved, on their own: a failure here is
  // recorded under "jira-needs" and never undoes or fails the Jira task sync.
  const jira_needs = await needsSource(now, today);
  const ok = out.github.ok !== false && out.jira.ok !== false;
  return Response.json({ ok, ...out, jira_needs }, { status: ok ? 200 : 502 });
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

// research/plan-reliability.md R5: the PAT's end date goes to the credentials register (a date,
// never the token). Recording it can fail (the table not made yet); the sync goes on.
let tokenExpires: { at: string | null } | null = null;
async function saveTokenExpiry() {
  if (!tokenExpires) return;
  const { at } = tokenExpires;
  await db("credentials?on_conflict=name", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ name: "github_pat", expires_at: at, updated_at: new Date().toISOString(),
      note: at ? "From GitHub's GitHub-Authentication-Token-Expiration header." : "GitHub sent no expiration header: this token doesn't expire." }),
  }).catch((e) => console.error("credentials:", e instanceof Error ? e.message : e));
}

async function githubGet(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "the-sheet-work-sync",
    },
  });
  // R5: the token's expiry, read once a run from the /user call (health.mjs, githubExpiry).
  if (path === "/user" && res.ok) tokenExpires = { at: githubExpiry(res.headers.get("github-authentication-token-expiration")) };
  const body = await res.json().catch(() => null);
  // GitHub's own message ("Validation Failed: The listed users cannot be searched…") holds no
  // token or mail text, so it goes into feed_state to say why.
  if (!res.ok) {
    const why = [body?.message, body?.errors?.[0]?.message].filter(Boolean).join(": ").slice(0, 160);
    throw new Error(`github: HTTP ${res.status}${why ? ` ${why}` : ""}`);
  }
  return body;
}

async function githubSearch(q: string) {
  const body = await githubGet(`/search/issues?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}`);
  const items = Array.isArray(body?.items) ? body.items : [];
  return { items, whole: body?.incomplete_results === false && Number(body?.total_count) <= items.length };
}

// Both searches, merged; githubTaskChanges counts an item in both once.
// Search by login, not @me: a fine-grained token owned by an org gets 422 "The listed users
// cannot be searched" for @me (https://docs.github.com/en/rest/users/users#get-the-authenticated-user).
async function githubItems() {
  const login = String((await githubGet("/user"))?.login ?? "");
  await saveTokenExpiry();
  if (!/^[A-Za-z\d-]{1,39}$/.test(login)) throw new Error("github: no login for this token");
  // Each search must name is:issue or is:pull-request, or GitHub answers 422.
  const parts = await Promise.all([
    `is:open is:pull-request review-requested:${login}`,
    `is:open is:pull-request assignee:${login}`,
    `is:open is:issue assignee:${login}`,
  ].map(githubSearch));
  return { items: parts.flatMap((p) => p.items), whole: parts.every((p) => p.whole) };
}

// --- Jira -------------------------------------------------------------------------------------

const jiraHeaders = () => ({ Authorization: `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`)}`, Accept: "application/json" });

// Up to `pages` pages of one enhanced JQL search; `whole` is false when pages were left over.
async function jiraSearch(query: Record<string, unknown>, pages: number) {
  const issues: unknown[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < pages; page++) {
    const res = await fetch(`https://${JIRA_SITE}/rest/api/3/search/jql`, {
      method: "POST",
      headers: { ...jiraHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ...query, maxResults: PER_PAGE, ...(nextPageToken ? { nextPageToken } : {}) }),
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

const jiraIssues = () => jiraSearch({ jql: "assignee = currentUser() AND statusCategory != Done ORDER BY key", fields: ["summary", "duedate"] }, JIRA_PAGES);

// The Jira updates' run, recorded in feed_state as "jira-needs".
async function needsSource(now: Date, today: string) {
  const fetched_at = now.toISOString();
  if (!(JIRA_TOKEN && JIRA_EMAIL && JIRA_SITE) || !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(JIRA_SITE)) {
    await saveFeedState("jira-needs", { fetched_at, ok: null, error: "not connected" });
    return { ok: null, skipped: "not connected" };
  }
  try {
    const { read, inserted, resolved } = await jiraUpdates(now, today);
    await saveFeedState("jira-needs", { fetched_at, ok: true, error: null, items: read });
    return { ok: true, items: read, inserted, resolved };
  } catch (e) {
    await feedFailed("jira-needs", e, fetched_at, [JIRA_TOKEN, JIRA_EMAIL, JIRA_SITE]);
    return { ok: false };
  }
}

// Needs you's Jira rows: the updates of the last UPDATE_DAYS days that need him, written once
// each, and the open rows that no longer need him marked done. As save: the rows first, then
// their ids.
async function jiraUpdates(now: Date, today: string) {
  const me = await fetch(`https://${JIRA_SITE}/rest/api/3/myself`, { headers: jiraHeaders() });
  if (!me.ok) throw new Error(`jira: myself HTTP ${me.status}`);
  const self = String((await me.json())?.accountId ?? "");
  if (!/^[\w:-]{1,128}$/.test(self)) throw new Error("jira: myself gave no accountId");
  const { issues } = await jiraSearch({
    jql: `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -${UPDATE_DAYS}d ORDER BY updated DESC`,
    fields: ["summary", "status", "assignee", "creator", "created", "comment"],
    expand: "changelog",
  }, UPDATE_PAGES);
  const known = [
    ...(await db("needs_you?select=message_id&source=eq.jira")),
    ...(await db("feed_seen?select=uid&source=eq.jira-needs")).map((r: { uid: string }) => r.uid),
  ];
  const since = now.getTime() - UPDATE_DAYS * 24 * 60 * 60_000;
  const rows = jiraNeeds(issues, { self, site: JIRA_SITE, known, since });
  if (rows.length) {
    await db("needs_you?on_conflict=account,message_id", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(rows.map((r) => ({ ...r, day: today }))),
    });
    await db("feed_seen?on_conflict=source,uid", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify(rows.map((r) => ({ source: "jira-needs", uid: r.message_id }))),
    });
  }
  const open = await db("needs_you?select=id,message_id,kind,created_at&source=eq.jira&done=is.false");
  const resolved = jiraResolved(open, issues, self);
  if (resolved.length) {
    await db(`needs_you?id=in.(${resolved.join(",")})&done=is.false`, { method: "PATCH", body: JSON.stringify({ done: true }) });
  }
  return { read: issues.length, inserted: rows.length, resolved: resolved.length };
}

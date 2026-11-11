// v5 SRC1, GitHub and Jira tasks: what work-sync asks each API for, and what /plan and /now do
// with the tasks it makes. The task changes themselves are in test/v5-work.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fn = readFileSync(new URL("../supabase/functions/work-sync/index.ts", import.meta.url), "utf8");

test("work-sync: read-only searches, Jira fields summary and duedate only", () => {
  // By login, looked up with GET /user (a token an org owns can't search by @me).
  assert.match(fn, /githubGet\("\/user"\)/);
  assert.match(fn, /`is:open is:pull-request review-requested:\$\{login\}`/);
  assert.match(fn, /`is:open is:pull-request assignee:\$\{login\}`/);
  assert.match(fn, /`is:open is:issue assignee:\$\{login\}`/);
  assert.doesNotMatch(fn, /:@me/);
  assert.match(fn, /assignee = currentUser\(\) AND statusCategory != Done/);
  assert.match(fn, /fields: \["summary", "duedate"\]/);
  assert.doesNotMatch(fn, /description|"body"|\bbody\.body\b/);
});

test("work-sync: tokens come only from function secrets", () => {
  for (const name of ["SHEET_GITHUB_TOKEN", "SHEET_JIRA_TOKEN", "SHEET_JIRA_EMAIL", "SHEET_JIRA_SITE"]) {
    assert.match(fn, new RegExp(`env\\("${name}"\\)`));
  }
  assert.doesNotMatch(fn, /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|ATATT/);
});

test("work-sync: a list that may be cut short closes nothing", () => {
  assert.match(fn, /if \(whole && c\.close\.length\)/);
  assert.match(fn, /incomplete_results === false/);
});

test("work-sync: Jira updates for Needs you, read-only, written as jira rows and closed when resolved", () => {
  assert.match(fn, /\/rest\/api\/3\/myself/);
  assert.match(fn, /\(assignee = currentUser\(\) OR reporter = currentUser\(\) OR watcher = currentUser\(\)\) AND updated >= -\$\{minutes\}m/);
  assert.match(fn, /fields: \["summary", "status", "assignee", "creator", "created", "comment"\]/);
  assert.match(fn, /jiraNeeds\(issues, \{ self, site: JIRA_SITE, known, since \}\)/);
  assert.match(fn, /source: "jira-needs", uid: r\.message_id/);
  assert.match(fn, /jiraResolved\(open, issues, self\)/);
  assert.doesNotMatch(fn, /console\.log/);
});

test("work-sync: Jira updates run after the task sync, on their own, recorded as jira-needs", () => {
  const jiraTasks = fn.slice(fn.indexOf('jira: await source("jira"'), fn.indexOf("const jira_needs"));
  assert.doesNotMatch(jiraTasks, /jiraUpdates/);
  assert.match(fn, /const jira_needs = await needsSource\(now, today\);\n  const ok = out\.github\.ok !== false && out\.jira\.ok !== false;/);
  assert.match(fn, /await feedFailed\("jira-needs", e, fetched_at, \[JIRA_TOKEN, JIRA_EMAIL, JIRA_SITE\]\)/);
  assert.match(fn, /saveFeedState\("jira-needs", \{ fetched_at, ok: true/);
});

// --- /plan ----------------------------------------------------------------------------------------

test("githubOrgsFromInput: Settings' orgs, comma or space separated, lower case, once each", async () => {
  const { githubOrgsFromInput } = await import("../src/sheet/sources.mjs");
  assert.deepEqual(githubOrgsFromInput(" Acme-Robotics, other-org  acme-robotics "), ["acme-robotics", "other-org"]);
  assert.deepEqual(githubOrgsFromInput(""), []);
  // Not a GitHub login: nothing is saved.
  assert.equal(githubOrgsFromInput("acme/robotics"), undefined);
  assert.equal(githubOrgsFromInput("-acme"), undefined);
  assert.equal(githubOrgsFromInput("https://github.com/acme"), undefined);
});

test("sourceOf: GitHub and Jira tasks get their own source, before the #campus tag", async () => {
  const { sourceOf } = await import("../src/sheet/glance.mjs");
  assert.equal(sourceOf({ source: "github", tag: "campus" }), "github");
  assert.equal(sourceOf({ source: "jira", tag: null }), "jira");
  assert.equal(sourceOf({ source: "mail", tag: null }), null);
});

test("/plan: the github and kanban icons are in the sprite, with edges for both sources", () => {
  const page = readFileSync(new URL("../src/pages/plan/index.astro", import.meta.url), "utf8");
  for (const n of ["github", "kanban"]) assert.match(page, new RegExp(`<symbol id="i-${n}" viewBox="0 0 24 24">`), n);
  const css = readFileSync(new URL("../src/styles/sheet.css", import.meta.url), "utf8");
  for (const s of ["github", "jira"]) assert.match(css, new RegExp(`\\.sheet-task\\[data-source="${s}"\\]`), s);
});

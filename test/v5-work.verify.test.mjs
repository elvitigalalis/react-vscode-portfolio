// Verification tests for v5 SRC1, GitHub and Jira tasks: githubTaskChanges and jiraTaskChanges
// (src/sheet/sources.mjs) on fixture responses. Written before the code from docs/sheet-v5.md
// "Contracts" and spec 47. Every test starts as `todo`; the implementer removes `todo` and must
// not change an expectation. Expected values are written out by hand. The module is imported
// inside each test, so this file loads before it exists.
//
// The fixtures are hand-written in each API's shape, with made-up orgs, people and sites:
// - github-review-requested.json, a search/issues response for `is:open review-requested:@me`
//   (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests): PR 41 in
//   acme-robotics/planner, milestone due 2026-11-06, and PR 7 in other-org/tool, no milestone.
// - github-assigned.json, the same for `is:open assignee:@me`: issue 38 in acme-robotics/planner,
//   no milestone; issue 12 in acme-robotics/site, milestone due 2026-11-07; and PR 41 again.
// - jira-search-jql.json, a POST /rest/api/3/search/jql response
//   (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/): KAN-12
//   due 2026-11-05, KAN-15 with no due date, KAN-20 due 2026-11-09.
// Every body and description holds a marker (BODY-TEXT-, DESC-TEXT-, MILESTONE-TEXT) that must
// never come out.
//
// Today is Wednesday 2026-11-04, so "due within 48 hours" is Nov 4, 5 or 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("../src/sheet/sources.mjs");
const todo = { todo: true };

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const review = fixture("github-review-requested.json");
const assigned = fixture("github-assigned.json");
const jira = fixture("jira-search-jql.json");
const ITEMS = [...review.items, ...assigned.items];

const TODAY = "2026-11-04";
const ORGS = ["acme-robotics"];
const PR41 = "https://github.com/acme-robotics/planner/pull/41";
const ISSUE38 = "https://github.com/acme-robotics/planner/issues/38";
const ISSUE12 = "https://github.com/acme-robotics/site/issues/12";
const PR7 = "https://github.com/other-org/tool/pull/7";

const gh = (title, uid, due) => ({ title, day: null, list: "GitHub", due, public: false, source: "github", source_uid: uid, link: uid });

// =============================================================================================
// GitHub
// =============================================================================================

test("githubTaskChanges: review requests and assigned items in his orgs become private GitHub tasks", async () => {
  const { githubTaskChanges } = await load();
  const out = githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ORGS, today: TODAY });
  assert.deepEqual(out.insert, [
    gh("Review: Add retry to the sync worker", PR41, "2026-11-06"),
    gh("Calendar import drops all-day events", ISSUE38, null),
    gh("Fix footer links", ISSUE12, "2026-11-07"),
  ]);
  assert.deepEqual(out.seen, [
    { source: "github", uid: PR41 },
    { source: "github", uid: ISSUE38 },
    { source: "github", uid: ISSUE12 },
  ]);
  assert.deepEqual(out.update, []);
  assert.deepEqual(out.close, []);
});

test("githubTaskChanges: a change per insert, weight 8 when due within 48 hours, otherwise 3", async () => {
  const { githubTaskChanges } = await load();
  const out = githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ORGS, today: TODAY });
  assert.deepEqual(out.changes, [
    { kind: "github", reason: "github_due_soon", weight: 8, ref: PR41 }, // due Nov 6, the day after tomorrow
    { kind: "github", reason: "github_change", weight: 3, ref: ISSUE38 }, // no due date
    { kind: "github", reason: "github_change", weight: 3, ref: ISSUE12 }, // due Nov 7
  ]);
});

test("githubTaskChanges: due today counts as soon", async () => {
  const { githubTaskChanges } = await load();
  const item = { ...assigned.items[0], milestone: { ...assigned.items[1].milestone, due_on: "2026-11-04T07:00:00Z" } };
  const out = githubTaskChanges([item], { tasks: [], seen: [], orgs: ORGS, today: TODAY });
  assert.equal(out.insert[0].due, "2026-11-04");
  assert.deepEqual(out.changes, [{ kind: "github", reason: "github_due_soon", weight: 8, ref: ISSUE38 }]);
});

test("githubTaskChanges: titles and links only, never a body", async () => {
  const { githubTaskChanges } = await load();
  const out = JSON.stringify(githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ["acme-robotics", "other-org"], today: TODAY }));
  assert.doesNotMatch(out, /BODY-TEXT|MILESTONE-TEXT|Sprint 9|alex-chen-dev/);
  for (const row of githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ORGS, today: TODAY }).insert) {
    assert.deepEqual(Object.keys(row).sort(), ["day", "due", "link", "list", "public", "source", "source_uid", "title"]);
    assert.match(row.link, /^https:\/\/github\.com\//);
  }
});

test("githubTaskChanges: only repositories in the orgs set in Settings", async () => {
  const { githubTaskChanges } = await load();
  assert.deepEqual(githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: [], today: TODAY }).insert, []);
  const both = githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ["acme-robotics", "other-org"], today: TODAY });
  assert.deepEqual(both.insert.map((r) => r.source_uid), [PR41, PR7, ISSUE38, ISSUE12]);
  assert.equal(both.insert[1].title, "Review: Bump dependencies");
  const other = githubTaskChanges(ITEMS, { tasks: [], seen: [], orgs: ["other-org"], today: TODAY });
  assert.deepEqual(other.insert.map((r) => r.source_uid), [PR7]);
});

test("githubTaskChanges: a seen item updates its undone task, leaves a done or deleted one alone", async () => {
  const { githubTaskChanges } = await load();
  const tasks = [
    { id: "a1", title: "Review: Add retry", due: null, done: false, source: "github", source_uid: PR41, link: PR41 },
    { id: "a2", title: "Calendar import drops all-day events", due: null, done: true, source: "github", source_uid: ISSUE38, link: ISSUE38 },
  ];
  // Issue 12 was seen and its task deleted.
  const seen = [PR41, ISSUE38, ISSUE12];
  const out = githubTaskChanges(ITEMS, { tasks, seen, orgs: ORGS, today: TODAY });
  assert.deepEqual(out.insert, []);
  assert.deepEqual(out.seen, []);
  assert.deepEqual(out.update, [{ id: "a1", title: "Review: Add retry to the sync worker", due: "2026-11-06" }]);
  assert.deepEqual(out.changes, []);
  assert.deepEqual(out.close, []);
});

test("githubTaskChanges: a review done or an issue closed closes its task", async () => {
  const { githubTaskChanges } = await load();
  const MERGED = "https://github.com/acme-robotics/planner/pull/40";
  const CLOSED = "https://github.com/acme-robotics/planner/issues/30";
  const tasks = [
    { id: "c1", title: "Review: Old PR", due: null, done: false, source: "github", source_uid: MERGED, link: MERGED },
    { id: "c2", title: "Old issue", due: null, done: false, source: "github", source_uid: CLOSED, link: CLOSED },
    { id: "c3", title: "Already done", due: null, done: true, source: "github", source_uid: "https://github.com/acme-robotics/planner/issues/29", link: null },
    { id: "c4", title: "Review: Add retry to the sync worker", due: "2026-11-06", done: false, source: "github", source_uid: PR41, link: PR41 },
    { id: "c5", title: "HW3", due: "2026-11-06", done: false, source: "brightspace", source_uid: "d2l-123" },
    { id: "c6", title: "KAN-9 Old ticket", due: null, done: false, source: "jira", source_uid: "KAN-9" },
  ];
  const out = githubTaskChanges(ITEMS, { tasks, seen: [MERGED, CLOSED, PR41], orgs: ORGS, today: TODAY });
  assert.deepEqual(out.close, ["c1", "c2"]);
  assert.deepEqual(out.update, []);
});

test("githubTaskChanges: an item in both searches is one task", async () => {
  const { githubTaskChanges } = await load();
  const out = githubTaskChanges([...review.items, ...assigned.items, ...review.items], { tasks: [], seen: [], orgs: ORGS, today: TODAY });
  assert.equal(out.insert.filter((r) => r.source_uid === PR41).length, 1);
  assert.equal(out.changes.filter((c) => c.ref === PR41).length, 1);
});

// =============================================================================================
// Jira
// =============================================================================================

const SITE = "example-team.atlassian.net";
const jt = (key, summary, due) => ({
  title: `${key} ${summary}`, day: null, list: "Jira", due, public: false, source: "jira", source_uid: key, link: `https://${SITE}/browse/${key}`,
});

test("jiraTaskChanges: open tickets become private Jira tasks with a browse link", async () => {
  const { jiraTaskChanges } = await load();
  const out = jiraTaskChanges(jira.issues, { tasks: [], seen: [], site: SITE, today: TODAY });
  assert.deepEqual(out.insert, [
    jt("KAN-12", "Write the onboarding checklist", "2026-11-05"),
    jt("KAN-15", "Review the sprint board filters", null),
    jt("KAN-20", "Draft the demo script", "2026-11-09"),
  ]);
  assert.deepEqual(out.seen, [{ source: "jira", uid: "KAN-12" }, { source: "jira", uid: "KAN-15" }, { source: "jira", uid: "KAN-20" }]);
  assert.deepEqual(out.close, []);
});

test("jiraTaskChanges: weight 8 when due within 48 hours, otherwise 3", async () => {
  const { jiraTaskChanges } = await load();
  assert.deepEqual(jiraTaskChanges(jira.issues, { tasks: [], seen: [], site: SITE, today: TODAY }).changes, [
    { kind: "jira", reason: "jira_due_soon", weight: 8, ref: "KAN-12" },
    { kind: "jira", reason: "jira_change", weight: 3, ref: "KAN-15" },
    { kind: "jira", reason: "jira_change", weight: 3, ref: "KAN-20" },
  ]);
});

test("jiraTaskChanges: never the description", async () => {
  const { jiraTaskChanges } = await load();
  assert.doesNotMatch(JSON.stringify(jiraTaskChanges(jira.issues, { tasks: [], seen: [], site: SITE, today: TODAY })), /DESC-TEXT|In Progress|Medium/);
});

test("jiraTaskChanges: updates an undone task; a done ticket closes its task", async () => {
  const { jiraTaskChanges } = await load();
  const tasks = [
    { id: "j1", title: "KAN-12 Onboarding", due: null, done: false, source: "jira", source_uid: "KAN-12", link: `https://${SITE}/browse/KAN-12` },
    { id: "j2", title: "KAN-9 Set up the board", due: null, done: false, source: "jira", source_uid: "KAN-9", link: `https://${SITE}/browse/KAN-9` },
    { id: "j3", title: "KAN-8 Done already", due: null, done: true, source: "jira", source_uid: "KAN-8", link: `https://${SITE}/browse/KAN-8` },
    { id: "j4", title: "Review: Old PR", due: null, done: false, source: "github", source_uid: "https://github.com/acme-robotics/planner/pull/40" },
  ];
  const out = jiraTaskChanges(jira.issues, { tasks, seen: ["KAN-12", "KAN-9", "KAN-8", "KAN-15", "KAN-20"], site: SITE, today: TODAY });
  assert.deepEqual(out.update, [{ id: "j1", title: "KAN-12 Write the onboarding checklist", due: "2026-11-05" }]);
  assert.deepEqual(out.close, ["j2"]);
  assert.deepEqual(out.insert, []);
  assert.deepEqual(out.changes, []);
});

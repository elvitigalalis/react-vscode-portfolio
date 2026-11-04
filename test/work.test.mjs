// v5 SRC1, GitHub and Jira tasks: what work-sync asks each API for, and what /plan and /now do
// with the tasks it makes. The task changes themselves are in test/v5-work.verify.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fn = readFileSync(new URL("../supabase/functions/work-sync/index.ts", import.meta.url), "utf8");

test("work-sync: read-only searches, Jira fields summary and duedate only", () => {
  assert.match(fn, /is:open review-requested:@me/);
  assert.match(fn, /is:open assignee:@me/);
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

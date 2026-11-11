// Slack no longer feeds Needs you (docs/sheet-v5.md, SRC2): slack-sync only reads, for feed
// health; the morning task can't add a Slack item; /plan shows mail and Jira rows only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkProposal } from "../src/sheet/proposal.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fn = read("../supabase/functions/slack-sync/index.ts");

test("slack-sync: only auth.test and search.messages, the token from env, text never stored or logged", () => {
  assert.deepEqual([...new Set(fn.match(/slack\("[\w.]+"/g))].sort(), ['slack("auth.test"', 'slack("search.messages"']);
  assert.match(fn, /env\("SHEET_SLACK_TOKEN"\)/);
  assert.match(fn, /Authorization: `Bearer \$\{SLACK_TOKEN\}`/);
  assert.doesNotMatch(fn, /\.text\b|console\.log/);
  assert.match(fn, /not connected/);
});

test("slack-sync: writes no Needs you row, feed_seen id or change, only its feed state", () => {
  assert.doesNotMatch(fn, /needs_you|feed_seen|"changes"|slack_new|method: "POST"/);
  assert.match(fn, /saveFeedState\("slack", \{ fetched_at, ok: true, error: null, items: matches\.length \}\)/);
});

test("morning task: a Slack item is refused, so it can't add one to Needs you", () => {
  const DAY = "2026-11-04";
  const snap = {
    now: "2026-11-04T11:07:00.000Z", time_zone: "America/New_York", plan_day: DAY, shutdown: "17:00", tasks: [],
    blocks: [], busy: [], busy_as_of: null, interests: null, campus: [], proposal: null, needs_you_open: [], accounts: ["lisul.elvitigala@stonybrook.edu"],
  };
  const slack = { account: "slack", message_id: "C0EXAMPLE1:1762354800.000100", link: "https://example-team.slack.com/archives/C0EXAMPLE1/p1762354800000100",
    sender: "dana.lee", subject: "#team-backend", why: "Mentioned you", kind: "reply" };
  const r = checkProposal({ day: DAY, blocks: [], needs_you: [slack], picks: [], note: null }, snap);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /^needs_you\[0\]\.account: /.test(e)));
  assert.ok(r.errors.some((e) => /^needs_you\[0\]\.link: /.test(e)));
});

test("/plan: Needs you reads mail and Jira rows only, and draws no Slack icon or link", () => {
  assert.match(read("../src/sheet/api.mjs"), /needs_you\?done=is\.false&source=in\.\(mail,jira\)&order=created_at/);
  const needs = read("../src/sheet/needs-you.mjs");
  assert.doesNotMatch(needs, /slack/i);
});

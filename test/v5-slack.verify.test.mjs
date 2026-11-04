// Verification tests for v5 SRC2, Slack mentions in Needs you: slackNeeds (src/sheet/sources.mjs)
// on a search.messages fixture. Written before the code from docs/sheet-v5.md "Contracts" and
// spec 47. Every test starts as `todo`; the implementer removes `todo` and must not change an
// expectation. Expected values are written out by hand. The module is imported inside each test,
// so this file loads before it exists.
//
// test/fixtures/slack-search-messages.json is hand-written in the shape of a search.messages
// response (https://api.slack.com/methods/search.messages), with a made-up workspace and people.
// Its matches, in order:
//   1. a mention in #team-backend from dana.lee;
//   2. a direct message from sam.ortiz (channel.is_im);
//   3. a mention in the private channel design-crit from ria.patel;
//   4. a mention whose permalink is http://, not https://;
//   5. a mention whose permalink's host only starts with a .slack.com name;
//   6. match 1 again (the mentions and DM searches overlap).
// Every text holds a MSG-TEXT- marker that must never come out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const load = () => import("../src/sheet/sources.mjs");
const todo = { todo: true };

const response = JSON.parse(readFileSync(new URL("./fixtures/slack-search-messages.json", import.meta.url), "utf8"));
const MATCHES = response.messages.matches;
const P = "https://example-team.slack.com/archives";

const MENTION = {
  source: "slack", account: "slack", message_id: "C0EXAMPLE1:1762354800.000100", link: `${P}/C0EXAMPLE1/p1762354800000100`,
  sender: "dana.lee", subject: "#team-backend", why: "Mentioned you", kind: "reply",
};
const DM = {
  source: "slack", account: "slack", message_id: "D0EXAMPLE2:1762358400.000200", link: `${P}/D0EXAMPLE2/p1762358400000200`,
  sender: "sam.ortiz", subject: "Direct message", why: "Sent you a direct message", kind: "reply",
};
const PRIVATE = {
  source: "slack", account: "slack", message_id: "G0EXAMPLE3:1762362000.000300", link: `${P}/G0EXAMPLE3/p1762362000000300`,
  sender: "ria.patel", subject: "#design-crit", why: "Mentioned you", kind: "reply",
};

test("slackNeeds: mentions and DMs become Needs you rows with channel, person and permalink", async () => {
  const { slackNeeds } = await load();
  assert.deepEqual(slackNeeds(MATCHES, { known: [] }), [MENTION, DM, PRIVATE]);
});

test("slackNeeds: never the message text", async () => {
  const { slackNeeds } = await load();
  const rows = slackNeeds(MATCHES, { known: [] });
  assert.doesNotMatch(JSON.stringify(rows), /MSG-TEXT|U0OWNER|deploy/);
  for (const row of rows) assert.equal("text" in row, false);
});

test("slackNeeds: a DM reads as a direct message, a channel as #name", async () => {
  const { slackNeeds } = await load();
  const [dm] = slackNeeds([MATCHES[1]], { known: [] });
  assert.equal(dm.subject, "Direct message");
  assert.equal(dm.why, "Sent you a direct message");
  const [mention] = slackNeeds([MATCHES[0]], { known: [] });
  assert.equal(mention.subject, "#team-backend");
  assert.equal(mention.why, "Mentioned you");
});

test("slackNeeds: a permalink must be https:// on a .slack.com/ address", async () => {
  const { slackNeeds } = await load();
  assert.deepEqual(slackNeeds([MATCHES[3]], { known: [] }), []); // http://
  assert.deepEqual(slackNeeds([MATCHES[4]], { known: [] }), []); // .slack.com.evil.example/
  assert.deepEqual(slackNeeds([{ ...MATCHES[0], permalink: undefined }], { known: [] }), []);
  assert.deepEqual(slackNeeds([{ ...MATCHES[0], permalink: "javascript:alert(1)//.slack.com/" }], { known: [] }), []);
});

test("slackNeeds: no duplicates within a sync or across syncs", async () => {
  const { slackNeeds } = await load();
  const first = slackNeeds(MATCHES, { known: [] });
  assert.equal(first.filter((r) => r.message_id === MENTION.message_id).length, 1);
  // The next sync sees the same matches: rows already saved are skipped.
  assert.deepEqual(slackNeeds(MATCHES, { known: first.map((r) => ({ message_id: r.message_id })) }), []);
  // One saved, the others new.
  assert.deepEqual(slackNeeds(MATCHES, { known: [{ message_id: MENTION.message_id }] }), [DM, PRIVATE]);
});

test("slackNeeds: nothing found, nothing written", async () => {
  const { slackNeeds } = await load();
  assert.deepEqual(slackNeeds([], { known: [] }), []);
});

test("changeRow: a Slack mention is a weight-3 slack change", async () => {
  const { changeRow } = await import("../src/sheet/replan.mjs");
  assert.deepEqual(changeRow("slack_new", MENTION.message_id), { kind: "slack", reason: "slack_new", weight: 3, ref: "C0EXAMPLE1:1762354800.000100" });
});

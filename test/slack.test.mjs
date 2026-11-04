// slackNeeds (src/sheet/sources.mjs) and slackLink (morning.mjs) beyond the SRC2 verification
// tests: his own messages, odd names and links.
import { test } from "node:test";
import assert from "node:assert/strict";
import { slackNeeds } from "../src/sheet/sources.mjs";
import { slackLink } from "../src/sheet/morning.mjs";

const match = (over = {}) => ({
  channel: { id: "C0EXAMPLE1", is_im: false, name: "team-backend" }, user: "U0DANA", username: "dana.lee",
  ts: "1762354800.000100", text: "MSG-TEXT", permalink: "https://example-team.slack.com/archives/C0EXAMPLE1/p1762354800000100", ...over,
});

test("slackNeeds: his own messages give no row", () => {
  assert.equal(slackNeeds([match()], { known: [], self: "U0DANA" }).length, 0);
  assert.equal(slackNeeds([match()], { known: [], self: "U0OWNER" }).length, 1);
});

test("slackNeeds: a channel name or username that isn't a Slack name is left out", () => {
  assert.deepEqual(slackNeeds([match({ channel: { id: "C0EXAMPLE1", name: "evil.example/x y" } })], { known: [] }), []);
  assert.equal(slackNeeds([match({ username: "Dana <b>" })], { known: [] })[0].sender, "Someone");
  assert.equal(slackNeeds([match({ username: undefined })], { known: [] })[0].sender, "Someone");
});

test("slackNeeds: a match without a channel id or ts gives no row", () => {
  assert.deepEqual(slackNeeds([match({ ts: "x" }), match({ channel: { name: "a" } })], { known: [] }), []);
});

test("slackLink: only https:// permalinks on a .slack.com address", () => {
  assert.equal(slackLink("https://acme.slack.com/archives/C1/p1"), "https://acme.slack.com/archives/C1/p1");
  assert.equal(slackLink("https://acme.enterprise.slack.com/archives/C1/p1"), "https://acme.enterprise.slack.com/archives/C1/p1");
  for (const bad of ["http://acme.slack.com/x", "https://acme.slack.com.evil.example/x", "https://evil.example/.slack.com/", "https://slack.com/x", null])
    assert.equal(slackLink(bad), null, String(bad));
});

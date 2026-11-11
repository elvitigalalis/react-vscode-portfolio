// Jira updates in Needs you (src/sheet/sources.mjs, jiraNeeds and jiraResolved) and the link
// /plan draws for them (morning.mjs, jiraLink). People and ids are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jiraNeeds, jiraResolved } from "../src/sheet/sources.mjs";
import { jiraLink } from "../src/sheet/morning.mjs";

const ME = "712020:me";
const ANA = { accountId: "5b:ana", displayName: "Ana Ruiz" };
const SELF = { accountId: ME, displayName: "Lisul Elvitigala" };
const SITE = "example.atlassian.net";
const SINCE = Date.parse("2026-11-08T00:00:00Z");
const mention = (id) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "COMMENT-TEXT " }, { type: "mention", attrs: { id } }] }] });
const plain = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "COMMENT-TEXT" }] }] };
const comment = (id, author, created, body = plain) => ({ id, author, created, body });
let nextId = 1;
const issue = (key, fields = {}, histories = [], id = String(10000 + nextId++)) => ({
  key, id, changelog: { histories },
  fields: { summary: "Fix the login", status: { statusCategory: { key: "indeterminate" } }, assignee: SELF, creator: SELF,
    created: "2026-10-01T10:00:00.000-0400", comment: { comments: [] }, ...fields },
});
const assign = (id, author, created, to = ME) => ({ id, author, created, items: [{ field: "assignee", fieldId: "assignee", to }] });
const run = (issues, opts = {}) => jiraNeeds(issues, { self: ME, site: SITE, known: [], since: SINCE, ...opts });

test("jiraNeeds: a comment by someone else on his issue is a reply row, with the issue and the person", () => {
  assert.deepEqual(run([issue("KAN-7", { comment: { comments: [comment("10001", ANA, "2026-11-09T10:00:00.000-0500")] } })]), [{
    source: "jira", account: "jira", message_id: "comment:10001", link: "https://example.atlassian.net/browse/KAN-7?focusedCommentId=10001",
    sender: "Ana Ruiz", subject: "KAN-7: Fix the login", why: "Commented on your issue", kind: "reply",
  }]);
});

test("jiraNeeds: a mention counts on an issue that isn't his, a plain comment there doesn't", () => {
  const other = { assignee: ANA };
  const rows = run([issue("KAN-8", { ...other, comment: { comments: [
    comment("1", ANA, "2026-11-09T10:00:00Z", mention(ME)),
    comment("2", ANA, "2026-11-09T11:00:00Z"),
    comment("3", ANA, "2026-11-09T12:00:00Z", mention("5b:someone-else")),
  ] } })]);
  assert.deepEqual(rows.map((r) => [r.message_id, r.why]), [["comment:1", "Mentioned you in a comment"]]);
});

test("jiraNeeds: newly assigned to him by someone else, by a change or at creation", () => {
  const rows = run([
    issue("KAN-9", {}, [assign("20001", ANA, "2026-11-09T09:00:00Z")]),
    issue("KAN-10", { creator: ANA, created: "2026-11-09T09:00:00Z" }, [], "10500"),
  ]);
  assert.deepEqual(rows.map((r) => [r.message_id, r.kind, r.sender, r.link, r.why]), [
    ["assigned:20001", "assigned", "Ana Ruiz", "https://example.atlassian.net/browse/KAN-9", "Assigned it to you"],
    ["assigned:new:10500", "assigned", "Ana Ruiz", "https://example.atlassian.net/browse/KAN-10", "Assigned it to you"],
  ]);
});

test("jiraNeeds: his own actions, field churn and status moves give nothing", () => {
  const churn = { id: "30001", author: ANA, created: "2026-11-09T09:00:00Z", items: [
    { field: "status", fieldId: "status", toString: "In PR Review" }, { field: "summary", fieldId: "summary" }, { field: "priority", fieldId: "priority" }] };
  assert.deepEqual(run([
    issue("KAN-11", { comment: { comments: [comment("4", SELF, "2026-11-09T09:00:00Z", mention(ME))] } }, [assign("30002", SELF, "2026-11-09T09:00:00Z"), churn]),
    issue("KAN-12", { created: "2026-11-09T09:00:00Z" }),
    issue("KAN-13", { assignee: ANA }, [assign("30003", ANA, "2026-11-09T09:00:00Z")]),
  ]), []);
});

test("jiraNeeds: old events, Done issues and ones he has answered are skipped", () => {
  const done = { status: { statusCategory: { key: "done" } } };
  assert.deepEqual(run([
    issue("KAN-14", { comment: { comments: [comment("5", ANA, "2026-11-01T09:00:00Z")] } }),
    issue("KAN-15", { ...done, comment: { comments: [comment("6", ANA, "2026-11-09T09:00:00Z")] } }),
    issue("KAN-16", { comment: { comments: [comment("7", ANA, "2026-11-09T09:00:00Z"), comment("8", SELF, "2026-11-09T10:00:00Z")] } }),
  ]), []);
});

test("jiraNeeds: never twice, within a run or across runs", () => {
  const i = issue("KAN-17", { comment: { comments: [comment("9", ANA, "2026-11-09T09:00:00Z")] } });
  assert.equal(run([i, i]).length, 1);
  assert.deepEqual(run([i], { known: [{ message_id: "comment:9" }] }), []);
  assert.deepEqual(run([i], { known: ["comment:9"] }), []);
});

test("jiraNeeds: never comment text; odd keys, ids and sites give nothing; names are one line", () => {
  const i = issue("KAN-18", { summary: "  Fix\nthe   login ", comment: { comments: [comment("10", { accountId: "5b:x", displayName: "Ana\n<b>Ruiz</b>" }, "2026-11-09T09:00:00Z")] } });
  const [row] = run([i]);
  assert.doesNotMatch(JSON.stringify(row), /COMMENT-TEXT/);
  assert.equal(row.subject, "KAN-18: Fix the login");
  assert.equal(row.sender, "Ana <b>Ruiz</b>");
  assert.deepEqual(run([{ ...i, key: "kan-18" }]), []);
  assert.deepEqual(run([issue("KAN-19", { comment: { comments: [comment("1x", ANA, "2026-11-09T09:00:00Z")] } })]), []);
  assert.deepEqual(run([i], { site: "evil.example" }), []);
  assert.deepEqual(run([i], { self: null }), []);
  assert.equal(run([issue("KAN-20", { summary: "x".repeat(300), comment: { comments: [comment("11", ANA, "2026-11-09T09:00:00Z")] } })])[0].subject.length, 140);
});

test("jiraResolved: Done, answered or no longer his closes a row; an issue not read leaves it", () => {
  const row = (id, message_id, kind = "reply") => ({ id, message_id, kind, created_at: "2026-11-09T12:00:00Z" });
  const open = [row("a", "comment:1"), row("b", "comment:2"), row("c", "assigned:3", "assigned"), row("d", "comment:4"),
    row("e", "comment:5"), row("f", "comment:6"), row("g", "assigned:new:10900", "assigned")];
  const others = (id) => ({ comment: { comments: [comment(id, ANA, "2026-11-09T11:00:00Z")] } });
  const issues = [
    issue("KAN-21", { ...others("1"), status: { statusCategory: { key: "done" } } }),
    issue("KAN-22", { comment: { comments: [comment("2", ANA, "2026-11-09T11:00:00Z"), comment("7", SELF, "2026-11-09T13:00:00Z")] } }),
    issue("KAN-23", { assignee: ANA }, [assign("3", ANA, "2026-11-09T11:00:00Z")]),
    issue("KAN-24", { comment: { comments: [comment("4", ANA, "2026-11-09T10:00:00Z"), comment("8", SELF, "2026-11-09T11:00:00Z")] } }),
    issue("KAN-25", { ...others("5"), assignee: ANA }),
    issue("KAN-27", { assignee: ANA }, [], "10900"),
  ];
  assert.deepEqual(jiraResolved(open, issues, ME), ["a", "b", "c", "g"]);
});

test("jiraNeeds: an issue moved to another project keeps its row ids, so no second row", () => {
  const before = issue("KAN-30", { comment: { comments: [comment("40", ANA, "2026-11-09T09:00:00Z")] } }, [assign("41", ANA, "2026-11-09T09:00:00Z")], "10700");
  const first = run([before]);
  assert.deepEqual(first.map((r) => r.message_id), ["comment:40", "assigned:41"]);
  const moved = { ...before, key: "OPS-4" };
  assert.deepEqual(run([moved], { known: first.map((r) => r.message_id) }), []);
});

test("jiraLink: only https:// issue links on an atlassian.net site", () => {
  for (const ok of ["https://example.atlassian.net/browse/KAN-7", "https://example.atlassian.net/browse/KAN-7?focusedCommentId=10001"]) assert.equal(jiraLink(ok), ok);
  for (const bad of ["http://example.atlassian.net/browse/KAN-7", "https://example.atlassian.net.evil.com/browse/KAN-7",
    "https://evil.com/example.atlassian.net/browse/KAN-7", "https://example.atlassian.net/browse/KAN-7?x=<script>",
    "javascript:alert(1)//example.atlassian.net/browse/KAN-7", "https://example.atlassian.net/browse/KAN-7#x", null, 7]) {
    assert.equal(jiraLink(bad), null, String(bad));
  }
});

test("needsGroups: an assigned Jira row goes under Assigned to you, after the mail groups", async () => {
  const { needsGroups } = await import("../src/sheet/morning.mjs");
  const rows = [{ id: 1, kind: "assigned", done: false }, { id: 2, kind: "reply", done: false }];
  assert.deepEqual(needsGroups(rows).map((g) => [g.kind, g.title]), [["reply", "Reply owed"], ["assigned", "Assigned to you"]]);
});

test("/plan: a Jira row has the kanban icon, opens only a jiraLink, and offers no Not needed", async () => {
  const { readFileSync } = await import("node:fs");
  const needs = readFileSync(new URL("../src/sheet/needs-you.mjs", import.meta.url), "utf8");
  assert.match(needs, /jira \? sourceIcon\("jira"\) : null/);
  assert.match(needs, /const link = jira \? jiraLink\(r\.link\) : gmailLink\(r\.link\)/);
  assert.match(needs, /const skip = jira \? null : el\("button"/);
  assert.match(needs, /if \(mail\) await api\.logFeedback/);
  assert.match(readFileSync(new URL("../src/sheet/planner.mjs", import.meta.url), "utf8"), /jira: \["kanban", "From Jira"\]/);
});

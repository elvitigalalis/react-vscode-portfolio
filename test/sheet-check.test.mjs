// The live check's parsing and report (tools/sheet-check.mjs, used by tools/verify-sheet-v3.sh).
// The db-query fixtures are real `supabase db query` output (CLI 3.0.0): with an agent detected it
// wraps rows in an untrusted-data boundary, otherwise `-o json` prints a bare array, and a failed
// query prints an error object. secrets.json has the Management API's shape for
// GET /v1/projects/{ref}/secrets (name plus a digest of the value).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rowsOf, secretNames, report } from "../tools/sheet-check.mjs";

const fixture = (f) => readFileSync(new URL(`fixtures/db-query/${f}`, import.meta.url), "utf8");

test("rows come out of the untrusted-data boundary", () => {
  const rows = rowsOf(fixture("agent-rows.json"));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { name: "table campus_events", status: "ok", detail: "12 columns" });
  assert.deepEqual(rowsOf(fixture("agent-empty.json")), []);
});

test("a bare array after a 'Target:' line is the rows", () => {
  assert.deepEqual(rowsOf(fixture("plain-rows.json")), [{ name: "mail_accounts", status: "info", detail: "2 connected" }]);
});

test("a failed query throws its message, and so does output that isn't JSON", () => {
  assert.throws(() => rowsOf(fixture("error.json")), /column "nonsense" does not exist/);
  assert.throws(() => rowsOf("┌───┐\n│ a │\n└───┘"), /no JSON/);
  assert.throws(() => rowsOf('{"boundary": "x"}'), /no rows/);
});

test("secret names only, never their values", () => {
  const names = secretNames(fixture("secrets.json"));
  assert.deepEqual(names, ["GOOGLE_CLIENT_ID", "SHEET_CRON_SECRET", "SUPABASE_URL"]);
  assert.deepEqual(secretNames(JSON.stringify({ boundary: "b", rows: [{ name: "A", value: "v" }] })), ["A"]);
});

test("the report prints one line per row and counts the failures", () => {
  const { lines, failed } = report(rowsOf(fixture("agent-rows.json")));
  assert.equal(failed, 1);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^✓ table campus_events: 12 columns$/);
  assert.match(lines[1], /^! cron sheet-campus runs: no runs yet$/);
  assert.match(lines[2], /^✗ feed_state brightspace: /);
});

test("database text in a detail is data: one line, control characters dropped, URLs hidden, cut short", () => {
  const { lines } = report([
    { name: "feed_state campus", status: "fail", detail: "feed: 500\n\u001b[31mfetch https://feeds.example.edu/x?token=abc failed" },
    { name: "long", status: "info", detail: "x".repeat(500) },
  ]);
  assert.equal(lines[0], "✗ feed_state campus: feed: 500 [31mfetch <url> failed");
  assert.ok(lines[1].length <= 200);
});

test("an unknown status counts as a failure", () => {
  const { lines, failed } = report([{ name: "odd", status: "maybe", detail: null }]);
  assert.equal(failed, 1);
  assert.equal(lines[0], "✗ odd: status maybe");
});

// Token and grant expiries, and the live check, in the Sheet's health (src/sheet/health.mjs;
// research/plan-reliability.md R5, R10). Friday 2026-11-06, 10:00 am in New York (EST, UTC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { expiries, health, healthLine } from "../src/sheet/health.mjs";

const tz = "America/New_York";
const now = new Date("2026-11-06T15:00:00Z");
const mail = [{ email: "me@gmail.com", label: null, last_error: null, connected_at: "2026-11-03T08:01:52Z" }];
const calendar = { last_error: null, connected_at: "2026-11-04T22:25:34Z" };

test("expiries: while the Google app may be in Testing, each grant ends 7 days after it was connected", () => {
  const credentials = [{ name: "google_testing", expires_at: null, label: null, fix: null }];
  assert.deepEqual(expiries({ credentials, mail, calendar }), [
    { key: "google:me@gmail.com", label: "Gmail sign-in (me@gmail.com)", at: "2026-11-10T08:01:52.000Z", fix: "if the Google app is still in Testing, publish it In production, then reconnect" },
    { key: "google:calendar", label: "Calendar sign-in", at: "2026-11-11T22:25:34.000Z", fix: "if the Google app is still in Testing, publish it In production, then reconnect" },
  ]);
});

test("expiries: no google_testing row (the app is In production) means no Google expiry", () => {
  assert.deepEqual(expiries({ credentials: [], mail, calendar }), []);
});

test("expiries: a dated row is kept, an undated one (not knowable) is not", () => {
  const credentials = [
    { name: "github_pat", label: "GitHub token", expires_at: "2026-11-19T05:00:00Z", fix: "make a new one and set SHEET_GITHUB_TOKEN" },
    { name: "jira_token", label: "Jira token", expires_at: null, fix: null },
  ];
  assert.deepEqual(expiries({ credentials, mail, calendar }), [
    { key: "github_pat", label: "GitHub token", at: "2026-11-19T05:00:00Z", fix: "make a new one and set SHEET_GITHUB_TOKEN" },
  ]);
});

test("health: an expiry within 14 days is an issue keyed by its date; further off is not", () => {
  const soon = { key: "github_pat", label: "GitHub token", at: "2026-11-19T05:00:00Z", fix: "renew it" };
  const far = { key: "jira_token", label: "Jira token", at: "2026-12-30T05:00:00Z", fix: null };
  const h = health({ tz, expiring: [soon, far] }, now);
  assert.deepEqual(h.issues, [{ key: "expiry:github_pat:2026-11-19", words: "GitHub token expires Thu Nov 19", fix: "renew it" }]);
});

test("health: a passed expiry says expired", () => {
  const h = health({ tz, expiring: [{ key: "google:calendar", label: "Calendar sign-in", at: "2026-11-05T22:25:34Z", fix: null }] }, now);
  assert.deepEqual(h.issues, [{ key: "expiry:google:calendar:2026-11-05", words: "Calendar sign-in expired Thu Nov 5", fix: "renew it" }]);
});

test("live check: a failed check is an issue; passing ones say so on the green line", () => {
  const checks = [{ name: "cron jobs active", status: "ok", detail: "11 of 11" }, { name: "Vault URLs", status: "fail", detail: "sheet_busy_url missing" }];
  const h = health({ tz, checks }, now);
  assert.deepEqual(h.issues, [{ key: "check:Vault URLs", words: "live check failed: Vault URLs (sheet_busy_url missing)", fix: null }]);
  const ok = health({ tz, checks: [checks[0]] }, now);
  assert.equal(healthLine(ok), "Sheet: all green (live check passed).");
  // Without a live check, the line is as before.
  assert.equal(healthLine(health({ tz }, now)), "Sheet: all green.");
});

test("GitHub's token expiration header reads as an instant; no header means no expiry", async () => {
  const { githubExpiry } = await import("../src/sheet/health.mjs");
  assert.equal(githubExpiry("2026-12-01 00:00:00 UTC"), "2026-12-01T00:00:00.000Z");
  assert.equal(githubExpiry("2026-12-01 09:30:00 -0800"), "2026-12-01T17:30:00.000Z");
  assert.equal(githubExpiry(null), null);
  assert.equal(githubExpiry("soon"), null);
});

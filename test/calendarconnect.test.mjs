// The calendar-connect helpers in src/sheet/mailconnect.mjs (docs/sheet-v5.md, "Edge Functions"):
// the free/busy consent URL and the ID token's email, which decides whose grant it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALENDAR_SCOPES, FREEBUSY, READONLY, googleAuthUrl, idTokenEmail } from "../src/sheet/mailconnect.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

test("the calendar consent URL asks for free/busy, /plan's two scopes and identity, offline, for his account", () => {
  const u = new URL(googleAuthUrl({ clientId: "c", redirectUri: "https://x.example/cb", state: "s", loginHint: "me@example.com", scope: CALENDAR_SCOPES }));
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.app.created");
  assert.equal(FREEBUSY, "https://www.googleapis.com/auth/calendar.freebusy");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("login_hint"), "me@example.com");
  assert.equal(u.searchParams.get("include_granted_scopes"), "false");
  // Mail's consent URL is unchanged.
  assert.equal(new URL(googleAuthUrl({ clientId: "c", redirectUri: "https://x.example/cb", state: "s" })).searchParams.get("scope"), READONLY);
});

test("idTokenEmail: the email only when Google says it is verified", () => {
  assert.equal(idTokenEmail(idToken({ email: "me@example.com", email_verified: true })), "me@example.com");
  assert.equal(idTokenEmail(idToken({ email: "me@example.com", email_verified: false })), null);
  assert.equal(idTokenEmail(idToken({ email: "me@example.com" })), null);
  assert.equal(idTokenEmail(idToken({ email_verified: true })), null);
  for (const bad of [undefined, null, "", "not-a-token", "a.%%%.c"]) assert.equal(idTokenEmail(bad), null, String(bad));
});

// --- The functions' source (supabase/functions/calendar-connect, busy-sync) --------------------

const connectFn = readFileSync(new URL("../supabase/functions/calendar-connect/index.ts", import.meta.url), "utf8");
const syncFn = readFileSync(new URL("../supabase/functions/busy-sync/index.ts", import.meta.url), "utf8");

test("calendar-connect accepts only the owner's verified account, and stores the token by rpc", () => {
  assert.match(connectFn, /CALENDAR_SCOPES/);
  assert.match(connectFn, /idTokenEmail\(/);
  assert.match(connectFn, /owner_email/);
  assert.match(connectFn, /rpc\/calendar_account_save/);
  assert.doesNotMatch(connectFn, /console\.(log|error)\([^)]*refresh_token/);
});

test("busy-sync checks the cron secret, reads the token by rpc, and writes in one call", () => {
  assert.match(syncFn, /secretMatches\(/);
  assert.match(syncFn, /rpc\/calendar_refresh_token/);
  assert.match(syncFn, /rpc\/busy_sync_save/);
  assert.match(syncFn, /freeBusyRequest\(/);
  assert.match(syncFn, /freeBusyRows\(/);
  assert.match(syncFn, /busyChange\(.*shutdown\)/);
  assert.match(syncFn, /"freebusy"/);
  assert.match(syncFn, /not connected/);
});

// --- /plan Settings, Calendar (src/sheet/calendar-settings.mjs) -------------------------------

const calSettings = readFileSync(new URL("../src/sheet/calendar-settings.mjs", import.meta.url), "utf8");
const planPage = readFileSync(new URL("../src/pages/plan/index.astro", import.meta.url), "utf8");

test("/plan: Settings shows when busy times were saved, with Connect or Reconnect and Disconnect", () => {
  for (const hook of ["data-busy-saved", "data-cal-account", "data-cal-error", 'data-act="cal-connect"', 'data-act="cal-disconnect"']) {
    assert.ok(planPage.includes(hook), hook);
  }
  assert.match(planPage, /setupCalendarSettings/);
  assert.match(calSettings, /busySaved\(/);
  assert.match(calSettings, /"Reconnect" : "Connect"/);
  // The sign-in token rides in a header to /start, never in a URL.
  assert.match(calSettings, /functions\/v1\/calendar-connect\/start`, \{\s*method: "POST",\s*headers: \{ authorization: `Bearer \$\{token\}` \}/);
  // Disconnect asks first, then deletes the row (and with it the token).
  assert.match(calSettings, /confirm\([\s\S]*?deleteCalendarAccount\(\)/);
  assert.doesNotMatch(calSettings, /innerHTML/);
});

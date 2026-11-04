// The calendar-connect helpers in src/sheet/mailconnect.mjs (docs/sheet-v5.md, "Edge Functions"):
// the free/busy consent URL and the ID token's email, which decides whose grant it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALENDAR_SCOPES, FREEBUSY, READONLY, googleAuthUrl, idTokenEmail } from "../src/sheet/mailconnect.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims) => `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;

test("the calendar consent URL asks for free/busy and identity only, offline, for his account", () => {
  const u = new URL(googleAuthUrl({ clientId: "c", redirectUri: "https://x.example/cb", state: "s", loginHint: "me@example.com", scope: CALENDAR_SCOPES }));
  assert.equal(u.searchParams.get("scope"), "openid email https://www.googleapis.com/auth/calendar.freebusy");
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

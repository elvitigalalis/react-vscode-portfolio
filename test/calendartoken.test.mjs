// calendar-connect's /token (docs/sheet-v5.md, "Edge Functions"): /plan's Google access token
// from the server's calendar grant, for the owner only, and only when the grant can read events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serveToken, hasPlanScopes } from "../src/sheet/calendartoken.mjs";

const EVENTS = "https://www.googleapis.com/auth/calendar.events.readonly";
const CREATED = "https://www.googleapis.com/auth/calendar.app.created";
const FREEBUSY = "https://www.googleapis.com/auth/calendar.freebusy";
const WIDE = `openid ${FREEBUSY} ${EVENTS} ${CREATED} email`;

// A server where "good" is the owner's session and "other" someone else's.
function server({ refresh = "rt-secret", grant = { access_token: "at-1", expires_in: 3599, scope: WIDE, refresh_token: "rt-new" }, ok = true } = {}) {
  const calls = { refresh: [] };
  const deps = {
    userEmail: async (bearer) => ({ good: "me@example.com", other: "you@example.com" })[bearer] ?? null,
    ownerEmail: async () => "me@example.com",
    refreshToken: async () => refresh,
    refresh: async (rt) => { calls.refresh.push(rt); return { ok, status: ok ? 200 : 400, grant: ok ? grant : { error: "invalid_grant" } }; },
  };
  return { deps, calls };
}

test("the owner gets a fresh access token and its lifetime, nothing else", async () => {
  const { deps, calls } = server();
  const out = await serveToken("good", deps);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { access_token: "at-1", expires_in: 3599 });
  assert.deepEqual(calls.refresh, ["rt-secret"]);
  assert.ok(!JSON.stringify(out).includes("rt-"), "never the refresh token");
});

test("anyone but the owner is refused before the grant is touched", async () => {
  for (const bearer of ["", "other", "nobody"]) {
    const { deps, calls } = server();
    const out = await serveToken(bearer, deps);
    assert.equal(out.status, 403, bearer);
    assert.deepEqual(out.body, { error: "not-owner" });
    assert.equal(calls.refresh.length, 0);
  }
});

test("no grant, a refused refresh, or a grant without the /plan scopes gives no token", async () => {
  assert.deepEqual(await serveToken("good", server({ refresh: null }).deps), { status: 409, body: { error: "not-connected" } });
  const refused = await serveToken("good", server({ ok: false }).deps);
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.body, { error: "refused" });
  assert.equal(refused.lastError, "token refresh refused: invalid_grant");
  const narrow = await serveToken("good", server({ grant: { access_token: "at-1", expires_in: 3599, scope: `openid email ${FREEBUSY}` } }).deps);
  assert.deepEqual(narrow, { status: 409, body: { error: "needs-scopes" } });
});

test("hasPlanScopes: both events.readonly and app.created", () => {
  assert.equal(hasPlanScopes(WIDE), true);
  assert.equal(hasPlanScopes(`${FREEBUSY} ${EVENTS}`), false);
  assert.equal(hasPlanScopes(`${FREEBUSY} ${CREATED}`), false);
  for (const bad of [undefined, null, ""]) assert.equal(hasPlanScopes(bad), false);
});

const connectFn = readFileSync(new URL("../supabase/functions/calendar-connect/index.ts", import.meta.url), "utf8");

test("calendar-connect serves /token through serveToken, uncached, with the site's CORS", () => {
  assert.match(connectFn, /endsWith\("\/token"\)\) return token\(req\)/);
  assert.match(connectFn, /serveToken\(bearer,/);
  assert.match(connectFn, /"Cache-Control": "no-store"/);
  assert.match(connectFn, /async function token[\s\S]*corsFor\(/);
  assert.doesNotMatch(connectFn, /console\.(log|error)\([^)]*(access_token|grant|out\b)/);
});

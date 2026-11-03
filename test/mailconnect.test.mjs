// The mail-connect helpers (src/sheet/mailconnect.mjs), beyond the verification tests in
// test/v3-f.verify.test.mjs: the edges of the signed state.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { signState, verifyState } from "../src/sheet/mailconnect.mjs";

const SECRET = "test-state-secret-one";
const NOW = Date.parse("2026-11-03T14:00:00Z");

test("a state stamped more than a minute ahead of the clock is refused", async () => {
  const ahead = await signState({ owner: "a@example.com" }, SECRET, NOW + 5 * 60_000);
  assert.equal(await verifyState(ahead, SECRET, NOW), null);
  const skew = await signState({ owner: "a@example.com" }, SECRET, NOW + 30_000);
  assert.deepEqual(await verifyState(skew, SECRET, NOW), { owner: "a@example.com" });
});

test("a state is refused at 10 minutes and one millisecond, kept at exactly 10", async () => {
  const state = await signState({ n: 1 }, SECRET, NOW);
  assert.deepEqual(await verifyState(state, SECRET, NOW + 600_000), { n: 1 });
  assert.equal(await verifyState(state, SECRET, NOW + 600_001), null);
});

test("a state with padding added to its mac is refused", async () => {
  const state = await signState({ n: 1 }, SECRET, NOW);
  assert.equal(await verifyState(`${state}=`, SECRET, NOW), null);
});

// --- /start's browser call ---------------------------------------------------------------------

test("corsFor: only the site and the dev server may call /start", async () => {
  const { corsFor } = await import("../src/sheet/mailconnect.mjs");
  for (const origin of ["https://www.lisul-elvi.com", "http://localhost:4321"]) {
    const h = corsFor(origin);
    assert.equal(h["Access-Control-Allow-Origin"], origin);
    assert.equal(h["Access-Control-Allow-Methods"], "POST");
    assert.match(h["Access-Control-Allow-Headers"], /authorization/i);
    assert.equal(h.Vary, "Origin");
  }
  for (const origin of ["https://evil.example", "https://lisul-elvi.com.evil.example", "http://localhost:3000", "null", "", null]) {
    assert.equal(corsFor(origin)["Access-Control-Allow-Origin"], undefined, String(origin));
    assert.equal(corsFor(origin).Vary, "Origin");
  }
});

test("READONLY is the one Gmail scope the consent URL asks for", async () => {
  const { READONLY, googleAuthUrl } = await import("../src/sheet/mailconnect.mjs");
  assert.equal(READONLY, "https://www.googleapis.com/auth/gmail.readonly");
  assert.equal(new URL(googleAuthUrl({ clientId: "c", redirectUri: "https://x.example/cb", state: "s" })).searchParams.get("scope"), READONLY);
});

// --- Single-use states (supabase/schema.sql, supabase/functions/mail-connect) -----------------

const schemaSql = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const connectFn = readFileSync(new URL("../supabase/functions/mail-connect/index.ts", import.meta.url), "utf8");

test("schema: mail_connect_states holds each state's nonce, closed to the browser", () => {
  const body = schemaSql.match(/create table if not exists mail_connect_states \(([\s\S]*?)\n\);/)?.[1];
  assert.ok(body, "no mail_connect_states table");
  assert.match(body, /^\s*nonce text primary key/m);
  assert.match(body, /^\s*created_at timestamptz not null default now\(\)/m);
  assert.match(schemaSql, /alter table mail_connect_states enable row level security;/);
  assert.match(schemaSql, /revoke all on mail_connect_states from anon, authenticated;/);
  assert.doesNotMatch(schemaSql, /create policy \w+ on mail_connect_states/);
  assert.doesNotMatch(schemaSql, /grant [^;]* on [^;]*mail_connect_states/);
});

test("mail-connect: /start writes the nonce and /callback consumes it", () => {
  assert.match(connectFn, /mail_connect_states/);
  // Consumed by a delete that returns the row, so a second callback with the same state finds none.
  assert.match(connectFn, /mail_connect_states\?nonce=eq\.[\s\S]{0,200}method: "DELETE"[\s\S]{0,120}return=representation/);
  assert.doesNotMatch(connectFn, /searchParams\.get\("hint"\)/);
  assert.doesNotMatch(connectFn, /searchParams\.get\("access_token"\)/);
});

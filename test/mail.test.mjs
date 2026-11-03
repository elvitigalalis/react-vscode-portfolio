// The mail connector's extras beyond the verification tests (test/v3-g.verify.test.mjs): the
// server-only refresh-token reader in the schema, and HTML bodies with links and entities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { messageBody } from "../src/sheet/mail.mjs";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const html = (text) => ({ id: "h1", threadId: "h1", payload: { mimeType: "text/html", filename: "", headers: [], body: { size: text.length, data: Buffer.from(text).toString("base64url") } } });

test("schema: mail_refresh_token reads Vault and only the service role may call it", () => {
  const fn = schema.match(/create or replace function mail_refresh_token\(account_email text\) returns text\n([\s\S]*?)\$\$;/)?.[0];
  assert.ok(fn, "no mail_refresh_token(account_email text) returns text");
  assert.match(fn, /security definer/);
  assert.match(fn, /vault\.decrypted_secrets s on s\.id = a\.vault_secret_id/);
  assert.match(schema, /revoke execute on function mail_refresh_token\(text\) from public, anon, authenticated;/);
  assert.doesNotMatch(schema, /grant execute on function mail_refresh_token/);
});

test("mail body: a link whose text is its address is written once", () => {
  assert.equal(messageBody(html('<p>See <a href="https://example.com/a">https://example.com/a</a></p>')), "See https://example.com/a");
});

test("mail body: links that aren't web or mail addresses keep only their text", () => {
  assert.equal(messageBody(html('<a href="javascript:alert(1)">Open</a> or <a href="#top">top</a>')), "Open or top");
});

test("mail body: entities in a link's address are decoded, comments and line breaks handled", () => {
  assert.equal(messageBody(html('<!-- tracking --><a href="https://x.edu/?a=1&amp;b=2">Form</a><br>Due Fri&nbsp;5&nbsp;pm')),
    "Form (https://x.edu/?a=1&b=2)\nDue Fri 5 pm");
});

// --- What an account's row records after a use (mail-mcp) ------------------------------------

test("accountPatch: a good use records last_used_at and clears last_error", async () => {
  const { accountPatch } = await import("../src/sheet/mail.mjs");
  assert.deepEqual(accountPatch({ ok: true }, new Date("2026-11-03T14:00:00Z")), { last_used_at: "2026-11-03T14:00:00.000Z", last_error: null });
});

test("accountPatch: a refused refresh or a Gmail error after a good refresh is recorded", async () => {
  const { accountPatch } = await import("../src/sheet/mail.mjs");
  const now = new Date("2026-11-03T14:00:00Z");
  assert.deepEqual(accountPatch({ ok: false, error: "Google token refresh failed: invalid_grant" }, now), { last_error: "Google token refresh failed: invalid_grant" });
  assert.deepEqual(accountPatch({ ok: false, status: 403, error: "Gmail 403: Gmail API has not been used" }, now), { last_error: "Gmail 403: Gmail API has not been used" });
  assert.deepEqual(accountPatch({ ok: false, status: 429, error: "Gmail 429: Too many requests" }, now), { last_error: "Gmail 429: Too many requests" });
  assert.equal(accountPatch({ ok: false, error: "x".repeat(900) }, now).last_error.length, 300);
});

test("accountPatch: a bad search or a missing message says nothing about the account", async () => {
  const { accountPatch } = await import("../src/sheet/mail.mjs");
  const now = new Date("2026-11-03T14:00:00Z");
  assert.equal(accountPatch({ ok: false, status: 400, error: "Gmail 400: Invalid query" }, now), null);
  assert.equal(accountPatch({ ok: false, status: 404, error: "Gmail 404: Not Found" }, now), null);
});

test("gmailError: Gmail's own message, never the raw body", async () => {
  const { gmailError } = await import("../src/sheet/mail.mjs");
  assert.equal(gmailError(403, '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}'), "Gmail 403: Request had insufficient authentication scopes.");
  assert.equal(gmailError(502, "<html>Bad Gateway</html>"), "Gmail 502");
});

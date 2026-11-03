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

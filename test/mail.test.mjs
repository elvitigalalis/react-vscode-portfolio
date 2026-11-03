// The mail connector's extras beyond the verification tests (test/v3-g.verify.test.mjs): the
// server-only refresh-token reader in the schema, and HTML bodies with links and entities.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";


const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");

test("schema: mail_refresh_token reads Vault and only the service role may call it", () => {
  const fn = schema.match(/create or replace function mail_refresh_token\(account_email text\) returns text\n([\s\S]*?)\$\$;/)?.[0];
  assert.ok(fn, "no mail_refresh_token(account_email text) returns text");
  assert.match(fn, /security definer/);
  assert.match(fn, /vault\.decrypted_secrets s on s\.id = a\.vault_secret_id/);
  assert.match(schema, /revoke execute on function mail_refresh_token\(text\) from public, anon, authenticated;/);
  assert.doesNotMatch(schema, /grant execute on function mail_refresh_token/);
});

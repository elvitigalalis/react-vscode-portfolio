// Verification tests for v3 F, connecting mail accounts (issue 27; contract in
// docs/sheet-sources.md, "Contracts", and docs/adr/0002-a-read-only-mail-connector-of-our-own.md).
// Written before the code. Each test starts as `todo`: the implementer removes the `todo` and must
// not change what a test expects.
//
// src/sheet/mailconnect.mjs uses Web Crypto (so it runs in Node and Deno), so its functions may
// be async; every call below is awaited, which also accepts a plain value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const MOD = "../src/sheet/mailconnect.mjs";
const read = (f) => {
  const u = new URL(`../${f}`, import.meta.url);
  return existsSync(u) ? readFileSync(u, "utf8") : "";
};
const schema = read("supabase/schema.sql");
const fn = read("supabase/functions/mail-connect/index.ts");
const page = read("src/pages/plan/index.astro");
const sheetJs = readdirSync(new URL("../src/sheet/", import.meta.url))
  .filter((f) => f.endsWith(".mjs") && f !== "mailconnect.mjs")
  .map((f) => read(`src/sheet/${f}`))
  .join("\n");

const SECRET = "test-state-secret-one";
const OTHER = "test-state-secret-two";
const NOW = Date.parse("2026-11-03T14:00:00Z");
const MIN = 60_000;
const PAYLOAD = { owner: "lisul@example.com", nonce: "n-4f1c" };

// --- signState / verifyState ----------------------------------------------------------------

test("mailconnect: a fresh state verifies back to its payload", { todo: true }, async () => {
  const m = await import(MOD);
  const state = await m.signState(PAYLOAD, SECRET, NOW);
  assert.equal(typeof state, "string");
  assert.deepEqual(await m.verifyState(state, SECRET, NOW), PAYLOAD);
  assert.deepEqual(await m.verifyState(state, SECRET, NOW + 9 * MIN + 59_000), PAYLOAD);
});

test("mailconnect: a state is URL-safe and doesn't contain the secret", { todo: true }, async () => {
  const m = await import(MOD);
  const state = await m.signState(PAYLOAD, SECRET, NOW);
  assert.match(state, /^[A-Za-z0-9._~-]+$/);
  assert.ok(!state.includes(SECRET));
});

test("mailconnect: a state expires after 10 minutes", { todo: true }, async () => {
  const m = await import(MOD);
  const state = await m.signState(PAYLOAD, SECRET, NOW);
  assert.equal(await m.verifyState(state, SECRET, NOW + 10 * MIN + 1000), null);
  assert.equal(await m.verifyState(state, SECRET, NOW + 60 * MIN), null);
  // The clock is the `now` passed in, not the machine's: a state signed 11 minutes ago is dead.
  const old = await m.signState(PAYLOAD, SECRET, NOW - 11 * MIN);
  assert.equal(await m.verifyState(old, SECRET, NOW), null);
});

test("mailconnect: a state signed with another secret is refused", { todo: true }, async () => {
  const m = await import(MOD);
  const state = await m.signState(PAYLOAD, OTHER, NOW);
  assert.equal(await m.verifyState(state, SECRET, NOW), null);
});

test("mailconnect: a tampered state is refused", { todo: true }, async () => {
  const m = await import(MOD);
  const state = await m.signState(PAYLOAD, SECRET, NOW);
  const swap = (c) => (c === "A" ? "B" : "A");
  const tampered = [
    swap(state[0]) + state.slice(1),        // the first character changed
    state.slice(0, -2),                      // cut short
    state + "A",                             // something added
    state.split("").reverse().join(""),      // scrambled
  ];
  for (const t of tampered) assert.equal(await m.verifyState(t, SECRET, NOW), null, t);
  // Another payload's state doesn't verify as this one's.
  const other = await m.signState({ owner: "someone@example.com", nonce: "n-4f1c" }, SECRET, NOW);
  assert.deepEqual(await m.verifyState(other, SECRET, NOW), { owner: "someone@example.com", nonce: "n-4f1c" });
  assert.notEqual(other, state);
});

test("mailconnect: junk is refused without throwing", { todo: true }, async () => {
  const m = await import(MOD);
  for (const junk of ["", ".", "abc", "abc.def", "...", "%%%", undefined, null]) {
    assert.equal(await m.verifyState(junk, SECRET, NOW), null, String(junk));
  }
});

// --- googleAuthUrl --------------------------------------------------------------------------

const REDIRECT = "https://abcd.supabase.co/functions/v1/mail-connect/callback";
const CLIENT = "1234-test.apps.example";

test("mailconnect: the Google URL asks for read-only Gmail, offline, with consent", { todo: true }, async () => {
  const m = await import(MOD);
  const url = new URL(String(await m.googleAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s.t-1" })));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual([...url.searchParams].sort(), [
    ["access_type", "offline"],
    ["client_id", "1234-test.apps.example"],
    ["include_granted_scopes", "false"],
    ["prompt", "consent"],
    ["redirect_uri", "https://abcd.supabase.co/functions/v1/mail-connect/callback"],
    ["response_type", "code"],
    ["scope", "https://www.googleapis.com/auth/gmail.readonly"],
    ["state", "s.t-1"],
  ]);
});

test("mailconnect: the Google URL carries login_hint only when given", { todo: true }, async () => {
  const m = await import(MOD);
  const url = new URL(String(await m.googleAuthUrl({ clientId: CLIENT, redirectUri: REDIRECT, state: "s", loginHint: "me+sbu@stonybrook.edu" })));
  assert.equal(url.searchParams.get("login_hint"), "me+sbu@stonybrook.edu");
  assert.equal([...url.searchParams].length, 9);
  // The + and @ are encoded, not left to read as a space.
  assert.ok(!/login_hint=me\+sbu/.test(url.href), url.href);
});

test("mailconnect: the module is pure and uses Web Crypto", { todo: true }, async () => {
  await import(MOD);
  const src = read("src/sheet/mailconnect.mjs");
  assert.match(src, /crypto\.subtle/);
  assert.match(src, /HMAC/);
  assert.doesNotMatch(src, /from ["']node:|require\(|\bfetch\(|Deno\.|process\.env/);
  assert.match(src, /export (async )?function signState/);
  assert.match(src, /export (async )?function verifyState/);
  assert.match(src, /export (async )?function googleAuthUrl/);
});

// --- Schema ---------------------------------------------------------------------------------

const mailTable = () => schema.match(/create table if not exists mail_accounts \(([\s\S]*?)\n\);/)?.[1] ?? "";

test("schema: mail_accounts has the contract's columns, email unique", { todo: true }, async () => {
  await import(MOD);
  const body = mailTable();
  assert.ok(body, "no `create table if not exists mail_accounts (…);`");
  const col = (name, type) => assert.match(body, new RegExp(`^\\s*${name} ${type}\\b`, "m"), `${name} ${type}`);
  col("id", "uuid");
  assert.match(body, /^\s*id uuid primary key/m);
  col("email", "text");
  assert.match(body, /^\s*email text[^,\n]*\bunique\b/m);
  col("label", "text");
  col("vault_secret_id", "uuid");
  col("connected_at", "timestamptz");
  col("last_used_at", "timestamptz");
  col("last_error", "text");
});

test("schema: mail_accounts is owner-only and closed to anon", { todo: true }, async () => {
  await import(MOD);
  assert.match(schema, /alter table mail_accounts enable row level security;/);
  assert.match(schema, /drop policy if exists owner_all on mail_accounts;/);
  assert.match(schema, /create policy owner_all on mail_accounts for all using \(is_owner\(\)\) with check \(is_owner\(\)\);/);
  assert.match(schema, /revoke all on [^;]*\bmail_accounts\b[^;]* from anon;/);
});

test("schema: deleting a mail account deletes its Vault secret, through a trigger", { todo: true }, async () => {
  await import(MOD);
  // The trigger function: security definer (the browser's role can't touch Vault), deleting the
  // row's secret by its id.
  const fns = [...schema.matchAll(/create or replace function (\w+)\(\) returns trigger([\s\S]*?)\$\$([\s\S]*?)\$\$;/g)];
  const del = fns.find(([, , , body]) => /delete from vault\.secrets where id = old\.vault_secret_id/.test(body));
  assert.ok(del, "no trigger function running `delete from vault.secrets where id = old.vault_secret_id`");
  const [, name, head] = del;
  assert.match(head, /security definer/);
  assert.match(head, /set search_path/);
  // Re-runnable: dropped before it is created, on delete of each row.
  const trig = schema.match(new RegExp(`create trigger (\\w+) (before|after) delete on mail_accounts for each row execute function ${name}\\(\\);`));
  assert.ok(trig, `no delete trigger on mail_accounts calling ${name}()`);
  assert.match(schema, new RegExp(`drop trigger if exists ${trig[1]} on mail_accounts;`));
});

test("schema: the browser's roles are never granted Vault", { todo: true }, async () => {
  await import(MOD);
  for (const stmt of schema.split(";")) {
    if (!/\bgrant\b/i.test(stmt)) continue;
    assert.ok(!(/vault/i.test(stmt) && /\b(anon|authenticated|public)\b/i.test(stmt)), stmt.trim());
  }
  assert.doesNotMatch(schema, /grant usage on schema vault/i);
  // A helper that writes Vault (create_secret / update_secret) is for the server only.
  for (const [, name, body] of schema.matchAll(/create or replace function (\w+)\(([^)]*)\)[\s\S]*?\$\$([\s\S]*?)\$\$;/g)) {
    if (!/vault\.(create|update)_secret/.test(body)) continue;
    assert.match(schema, new RegExp(`revoke execute on function ${name}\\([^)]*\\) from public, anon, authenticated;`), name);
    assert.doesNotMatch(schema, new RegExp(`grant execute on function ${name}\\b[^;]*\\b(anon|authenticated)\\b`), name);
  }
});

test("schema: the mail_accounts parts are safe to re-run", { todo: true }, async () => {
  await import(MOD);
  assert.ok(mailTable(), "no `create table if not exists mail_accounts`");
  assert.doesNotMatch(schema, /create table mail_accounts/);
  for (const [, policy] of schema.matchAll(/create policy (\w+) on mail_accounts/g)) {
    assert.match(schema, new RegExp(`drop policy if exists ${policy} on mail_accounts;`));
  }
  for (const [, trig] of schema.matchAll(/create trigger (\w+) \w+ \w+ on mail_accounts/g)) {
    assert.match(schema, new RegExp(`drop trigger if exists ${trig} on mail_accounts;`));
  }
  assert.doesNotMatch(schema, /create function /);
});

test("schema: mail accounts never reach the public views", { todo: true }, async () => {
  await import(MOD);
  const views = [...schema.matchAll(/create or replace view (\w+) as([\s\S]*?);/g)];
  assert.ok(views.length >= 3);
  for (const [, name, body] of views) assert.doesNotMatch(body, /mail|vault/i, name);
});

// --- The mail-connect function --------------------------------------------------------------

test("mail-connect: deployed like telegram, secrets from the environment", { todo: true }, async () => {
  await import(MOD);
  assert.ok(fn, "no supabase/functions/mail-connect/index.ts");
  assert.match(fn, /--no-verify-jwt/);
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MAIL_STATE_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    assert.match(fn, new RegExp(`(Deno\\.env\\.get|env)\\(\\s*["']${name}["']`), name);
  }
  assert.match(fn, /from ["']\.\.\/\.\.\/\.\.\/src\/sheet\/mailconnect\.mjs["']/);
});

test("mail-connect: /start checks the owner's token before sending him to Google", { todo: true }, async () => {
  await import(MOD);
  assert.match(fn, /["'`/]start\b/);
  assert.match(fn, /access_token/);
  // The token is checked with Supabase Auth, and its email against settings.owner_email.
  assert.match(fn, /\/auth\/v1\/user|auth\.getUser/);
  assert.match(fn, /owner_email/);
  assert.match(fn, /signState\(/);
  assert.match(fn, /googleAuthUrl\(/);
  assert.match(fn, /\/functions\/v1\/mail-connect\/callback/);
});

test("mail-connect: /callback checks the state, swaps the code and reads the account's email", { todo: true }, async () => {
  await import(MOD);
  assert.match(fn, /["'`/]callback\b/);
  assert.match(fn, /verifyState\(/);
  assert.match(fn, /https:\/\/oauth2\.googleapis\.com\/token/);
  assert.match(fn, /authorization_code/);
  assert.match(fn, /https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/);
  assert.match(fn, /emailAddress/);
});

test("mail-connect: the refresh token goes to Vault and the row is upserted by email", { todo: true }, async () => {
  await import(MOD);
  const both = fn + "\n" + schema;
  assert.match(fn, /refresh_token/);
  // Vault: create a secret for a new account, update it on reconnect (directly or through a
  // server-only SQL helper the function calls with rpc).
  assert.match(both, /vault\.create_secret/);
  assert.match(both, /vault\.update_secret/);
  assert.match(fn, /mail_accounts|\/rpc\//);
  assert.match(both, /mail_accounts\?on_conflict=email|on conflict \(email\)/);
});

test("mail-connect: it redirects back to /plan with the outcome", { todo: true }, async () => {
  await import(MOD);
  assert.match(fn, /\/plan\/\?mail=connected/);
  assert.match(fn, /\/plan\/\?mail=error&reason=/);
  assert.match(fn, /\b30[23]\b|Response\.redirect\(/);
});

test("mail-connect: tokens are never logged or sent back", { todo: true }, async () => {
  await import(MOD);
  assert.ok(fn, "no function file");
  for (const line of fn.split("\n")) {
    if (/console\.\w+\(/.test(line)) assert.doesNotMatch(line, /token|secret|code/i, line.trim());
    if (/reason=/.test(line)) assert.doesNotMatch(line, /token|secret/i, line.trim());
    if (/Response\.json\(|new Response\(/.test(line)) assert.doesNotMatch(line, /refresh_token|access_token|tokens?\b/i, line.trim());
  }
});

test("mail-connect: no secret is written into the repo", { todo: true }, async () => {
  await import(MOD);
  const files = { fn, schema, page, sheetJs, mod: read("src/sheet/mailconnect.mjs") };
  for (const [name, text] of Object.entries(files)) {
    assert.doesNotMatch(text, /GOCSPX-/, `${name}: a Google client secret`);
    assert.doesNotMatch(text, /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/, `${name}: a real client id`);
    assert.doesNotMatch(text, /ya29\.|["']1\/\/[\w-]{10,}/, `${name}: a Google token`);
    assert.doesNotMatch(text, /sb_secret_|eyJ[\w-]{10,}\.eyJ/, `${name}: a Supabase key`);
  }
  // The state secret is read from env, never given a fallback value.
  assert.doesNotMatch(fn, /MAIL_STATE_SECRET["']\)\s*(\?\?|\|\|)\s*["'][^"']+["']/);
});

// --- /plan Settings -------------------------------------------------------------------------

test("/plan: Settings lists the mail accounts with their last error", { todo: true }, async () => {
  await import(MOD);
  assert.match(page, /Settings/);
  assert.match(page, /Mail accounts/);
  assert.match(page, /data-mail-accounts\b/);
  assert.match(sheetJs, /mail_accounts/);
  assert.match(sheetJs, /last_error/);
});

test("/plan: Connect an account opens mail-connect/start with the sign-in token", { todo: true }, async () => {
  await import(MOD);
  // A real button or link, so it is reachable from the keyboard.
  assert.match(page + sheetJs, /<(button|a)\b[^>]*>\s*Connect an account\s*</);
  assert.match(page + sheetJs, /mail-connect\/start/);
  assert.match(sheetJs, /access_token/);
});

test("/plan: Remove asks first, then deletes the row", { todo: true }, async () => {
  await import(MOD);
  const ui = page + "\n" + sheetJs;
  assert.match(ui, /<button\b[^>]*>\s*Remove\s*</);
  assert.match(ui, /\bconfirm\(|data-confirm\b/);
  assert.match(sheetJs, /mail_accounts\?[^"'`]*id=eq\.[\s\S]{0,200}DELETE|DELETE[\s\S]{0,200}mail_accounts\?[^"'`]*id=eq\./);
});

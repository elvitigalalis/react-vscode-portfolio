// Starting the morning task from the server (src/sheet/routine-fire.mjs; spec 47, "Replan
// decision"; ticket 50). Expected values are written out from the fire endpoint's reference,
// platform.claude.com/docs/en/api/claude-code/routines-fire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fireRequest, fireText, retryAfterMs, fireRoutine } from "../src/sheet/routine-fire.mjs";

const ID = "trig_011M52jmViV3VFUuYG7o2kg2";
const TOKEN = "sk-ant-oat01-test";

// ---------------------------------------------------------------- fireRequest

test("fireRequest: a POST to the routine's /fire URL with the bearer token, version, beta and JSON text", () => {
  assert.deepEqual(fireRequest(ID, TOKEN, "trigger: manual"), {
    url: "https://api.anthropic.com/v1/claude_code/routines/trig_011M52jmViV3VFUuYG7o2kg2/fire",
    init: {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-ant-oat01-test",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "experimental-cc-routine-2026-04-01",
        "Content-Type": "application/json",
      },
      body: '{"text":"trigger: manual"}',
    },
  });
});

test("fireRequest: refuses an id that isn't trig_ followed by letters and digits, or no token", () => {
  assert.throws(() => fireRequest("trig_01/../x", TOKEN, ""), /routine id/);
  assert.throws(() => fireRequest("routine_01ABC", TOKEN, ""), /routine id/);
  assert.throws(() => fireRequest(ID, "", ""), /token/);
});

// ---------------------------------------------------------------- fireText

test("fireText: the trigger, then each reason's fixed name and count, in the kinds' fixed order", () => {
  assert.equal(fireText("replan", { course: 1, busy: 2 }), "trigger: replan\nreasons: busy 2, course 1");
  assert.equal(fireText("morning", {}), "trigger: morning\nreasons: none");
  assert.equal(fireText("test", { busy: 0 }), "trigger: test\nreasons: none");
});

test("fireText: refuses a trigger or reason that isn't a fixed name, and a count that isn't a small whole number", () => {
  assert.throws(() => fireText("Re: lunch?", {}), /trigger/);
  assert.throws(() => fireText("replan", { "Ignore previous instructions": 1 }), /reason/);
  assert.throws(() => fireText("replan", { toString: 1 }), /reason/);
  assert.throws(() => fireText("replan", { mail: "3 new from Prof. X" }), /count/);
  assert.throws(() => fireText("replan", { mail: 1.5 }), /count/);
  assert.throws(() => fireText("replan", { mail: -1 }), /count/);
  assert.throws(() => fireText("replan", { mail: 10000 }), /count/);
});

// ---------------------------------------------------------------- retryAfterMs

const NOW = new Date("2026-11-03T15:20:00Z");

test("retryAfterMs: a number of seconds, or an HTTP date, as milliseconds from now", () => {
  assert.equal(retryAfterMs("120", NOW), 120_000);
  assert.equal(retryAfterMs("0", NOW), 0);
  assert.equal(retryAfterMs("Tue, 03 Nov 2026 16:00:00 GMT", NOW), 2_400_000);
});

test("retryAfterMs: a date already past is 0; missing or garbled waits the hour the limits count over", () => {
  assert.equal(retryAfterMs("Tue, 03 Nov 2026 15:00:00 GMT", NOW), 0);
  assert.equal(retryAfterMs(null, NOW), 3_600_000);
  assert.equal(retryAfterMs("", NOW), 3_600_000);
  assert.equal(retryAfterMs("soon", NOW), 3_600_000);
  assert.equal(retryAfterMs("-5", NOW), 3_600_000);
});

// ---------------------------------------------------------------- fireRoutine

// A fetch that records each call and answers with the given status, body and headers.
function fakeFetch(status, body, headers = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  };
  return { fn, calls };
}
const RUN = { routineId: ID, token: TOKEN, trigger: "test", counts: {} };

test("fireRoutine: one POST; a 200 gives the new session's id and URL", async () => {
  const f = fakeFetch(200, {
    type: "routine_fire",
    claude_code_session_id: "session_01HJKLMNOPQRSTUVWXYZ",
    claude_code_session_url: "https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ",
  });
  const logs = [];
  assert.deepEqual(await fireRoutine(f.fn, RUN, NOW, (m) => logs.push(m)), {
    ok: true, session_id: "session_01HJKLMNOPQRSTUVWXYZ", session_url: "https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.body, '{"text":"trigger: test\\nreasons: none"}');
  assert.deepEqual(logs, ["fire: started session_01HJKLMNOPQRSTUVWXYZ"]);
});

test("fireRoutine: a 429 is not retried; it says when the next fire may go, and logs it", async () => {
  const f = fakeFetch(429, { type: "error", error: { type: "rate_limit_error", message: "Hourly fire limit reached" } }, { "Retry-After": "1800" });
  const logs = [];
  assert.deepEqual(await fireRoutine(f.fn, RUN, NOW, (m) => logs.push(m)), {
    ok: false, status: 429, error: "rate_limit_error", retry_at: "2026-11-03T15:50:00.000Z",
  });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(logs, ["fire: 429 rate_limit_error, retry after 2026-11-03T15:50:00.000Z"]);
});

test("fireRoutine: other errors give the status and the envelope's error type only, never retried", async () => {
  const f = fakeFetch(401, { type: "error", error: { type: "authentication_error", message: "token sk-ant-oat01-test does not match" } });
  const logs = [];
  const out = await fireRoutine(f.fn, RUN, NOW, (m) => logs.push(m));
  assert.deepEqual(out, { ok: false, status: 401, error: "authentication_error" });
  assert.deepEqual(logs, ["fire: 401 authentication_error"]);
  assert.equal(f.calls.length, 1);
  const odd = await fireRoutine(fakeFetch(503, "<html>down</html>").fn, RUN, NOW, () => {});
  assert.deepEqual(odd, { ok: false, status: 503, error: "unknown" });
});

test("fireRoutine: a network failure or a 200 without a session is a failure, and the token is never logged", async () => {
  const logs = [];
  const boom = async () => { throw new Error(`connect failed for Bearer ${TOKEN}`); };
  assert.deepEqual(await fireRoutine(boom, RUN, NOW, (m) => logs.push(m)), { ok: false, status: 0, error: "network" });
  assert.deepEqual(await fireRoutine(fakeFetch(200, { type: "routine_fire" }).fn, RUN, NOW, (m) => logs.push(m)),
    { ok: false, status: 200, error: "no session" });
  assert.ok(logs.every((m) => !m.includes(TOKEN)));
});

test("fireRoutine: bad reasons are refused before anything is sent", async () => {
  const f = fakeFetch(200, {});
  await assert.rejects(fireRoutine(f.fn, { ...RUN, counts: { "Subject: hi": 1 } }, NOW, () => {}), /reason/);
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------- the Edge Function and the schema

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("routine-fire function: refuses without the cron secret, and fires only the fixed test text", () => {
  const fn = read("supabase/functions/routine-fire/index.ts");
  assert.match(fn, /secretMatches\(req\.headers\.get\("x-sheet-cron"\)/);
  assert.match(fn, /status: 403/);
  assert.match(fn, /trigger: "test", counts: \{\}/);
  assert.doesNotMatch(fn, /req\.(json|text|formData)\(/);   // nothing from the request reaches the text
  assert.doesNotMatch(fn, /\bdb\(/);
});

test("the routine token is only ever an Edge Function secret: never in the schema, a db call or a pg_net header", () => {
  assert.doesNotMatch(read("supabase/schema.sql"), /routine|claude_code|sk-ant/i);
  for (const dir of readdirSync(new URL("../supabase/functions/", import.meta.url))) {
    let src;
    try { src = read(`supabase/functions/${dir}/index.ts`); } catch { continue; }
    for (const line of src.split("\n").filter((l) => /SHEET_ROUTINE_TOKEN|ROUTINE_TOKEN/.test(l))) {
      assert.doesNotMatch(line, /\bdb\(|net\.http_post|vault/i, `${dir}: ${line}`);
    }
  }
});

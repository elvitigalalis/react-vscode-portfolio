// /plan's Google token (src/sheet/gtoken.mjs): the sign-in's token while it lasts, then one from
// calendar-connect's /token, fetched once however many calls want it, and once more on a 401.
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleTokens } from "../src/sheet/gtoken.mjs";

const HOUR = 3600_000;

// A session store, a clock and a /token that answers from `answers` in turn.
function setup({ session = { access_token: "sb" }, answers = [] } = {}) {
  let s = session;
  let t = 1_000_000;
  const asked = [];
  const tokens = googleTokens({
    read: () => s,
    save: (next) => { s = next; },
    fetchToken: async () => {
      asked.push(t);
      await Promise.resolve();
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a ?? { error: "failed" };
    },
    now: () => t,
  });
  return { tokens, asked, session: () => s, tick: (ms) => { t += ms; }, at: () => t };
}

test("the sign-in's Google token is used while it lasts, without asking the server", async () => {
  const { tokens, asked, at } = setup({ session: { provider_token: "signin", provider_expires_at: 1_000_000 + HOUR } });
  assert.equal(tokens.ready(), true);
  assert.equal(await tokens.token(), "signin");
  assert.equal(asked.length, 0);
  assert.ok(at());
});

test("an expired or missing token comes from the server once, however many calls ask", async () => {
  const { tokens, asked, session, tick } = setup({
    session: { access_token: "sb", provider_token: "old", provider_expires_at: 999_999 },
    answers: [{ access_token: "server-1", expires_in: 3599 }],
  });
  assert.equal(tokens.ready(), false);
  assert.deepEqual(await Promise.all([tokens.token(), tokens.token(), tokens.token()]), ["server-1", "server-1", "server-1"]);
  assert.equal(asked.length, 1);
  assert.equal(tokens.ready(), true);
  assert.equal(tokens.status(), "ok");
  assert.equal(session().access_token, "sb", "the Supabase session is kept");
  // Kept a few minutes short of Google's hour, then fetched again.
  tick(50 * 60_000);
  assert.equal(await tokens.token(), "server-1");
  tick(5 * 60_000);
  assert.equal(await tokens.token(), null);
  assert.equal(asked.length, 2);
});

test("when the server can't give a token: null, its reason, and no new ask for a minute", async () => {
  const { tokens, asked, tick } = setup({ answers: [{ error: "needs-scopes" }, new Error("offline"), { access_token: "server-1", expires_in: 3600 }] });
  assert.equal(await tokens.token(), null);
  assert.equal(tokens.status(), "needs-scopes");
  assert.equal(await tokens.token(), null);
  assert.equal(asked.length, 1);
  tick(61_000);
  assert.equal(await tokens.token(), null);
  assert.equal(tokens.status(), "failed");
  tick(61_000);
  assert.equal(await tokens.token(), "server-1");
  assert.equal(asked.length, 3);
});

test("call: a 401 gets one fresh token from the server and one retry", async () => {
  const { tokens, asked } = setup({
    session: { provider_token: "signin", provider_expires_at: 1_000_000 + HOUR },
    answers: [{ access_token: "server-1", expires_in: 3600 }],
  });
  const seen = [];
  const res = await tokens.call(async (t) => { seen.push(t); return { status: t === "signin" ? 401 : 200 }; });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["signin", "server-1"]);
  assert.equal(asked.length, 1);
});

test("call: a second 401 gives up and leaves no token marked live", async () => {
  const { tokens } = setup({
    session: { provider_token: "signin", provider_expires_at: 1_000_000 + HOUR },
    answers: [{ access_token: "server-1", expires_in: 3600 }],
  });
  const seen = [];
  const res = await tokens.call(async (t) => { seen.push(t); return { status: 401 }; });
  assert.equal(res.status, 401);
  assert.deepEqual(seen, ["signin", "server-1"]);
  assert.equal(tokens.ready(), false);
});

test("call: no token at all answers null without calling Google", async () => {
  const { tokens } = setup({ answers: [{ error: "not-connected" }] });
  let called = false;
  assert.equal(await tokens.call(async () => { called = true; return { status: 200 }; }), null);
  assert.equal(called, false);
});

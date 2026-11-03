// The routine-fire Edge Function (ticket 50): the server's one path to start the morning task by
// hand, to check that the token held here works before replans depend on it. A POST with the
// cron secret fires the routine once with the fixed text "trigger: test / reasons: none" and
// answers with the session, or the status and error type. The fire call itself is
// src/sheet/routine-fire.mjs, which the telegram tick imports for replans.
//
// Deploy like telegram, from the repo root:
//   npx supabase functions deploy routine-fire --use-api --no-verify-jwt
// --no-verify-jwt because the caller has no Supabase sign-in: it proves itself with the shared
// cron secret, so only Lisul (tools/routine-probe.mjs) and the server can call it.
//
// Secrets (function secrets, set by Lisul, never in the repo or the database): SHEET_ROUTINE_ID
// (the trig_ id in the routine's Fire URL) and SHEET_ROUTINE_TOKEN (made once in the claude.ai
// web UI; docs/sheet-morning.md, "Setup"), and SHEET_CRON_SECRET from the Telegram setup.
//
// A 429's Retry-After can be most of an hour and a function stays up at most 400 s ("Maximum
// Duration (Wall clock limit)": supabase.com/docs/guides/functions/limits), so the wait is the
// reply's retry_at, not a sleep here.
import { fireRoutine } from "../../../src/sheet/routine-fire.mjs";
import { env, secretMatches } from "../_shared/server.ts";

const CRON_SECRET = env("SHEET_CRON_SECRET");
const ROUTINE_ID = env("SHEET_ROUTINE_ID");
const ROUTINE_TOKEN = env("SHEET_ROUTINE_TOKEN");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!CRON_SECRET || !secretMatches(req.headers.get("x-sheet-cron") ?? "", CRON_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }
  if (!ROUTINE_ID || !ROUTINE_TOKEN) return Response.json({ ok: false, error: "not connected" }, { status: 503 });
  const out = await fireRoutine(fetch, { routineId: ROUTINE_ID, token: ROUTINE_TOKEN, trigger: "test", counts: {} }, new Date());
  return Response.json(out, { status: out.ok ? 200 : 502 });
});

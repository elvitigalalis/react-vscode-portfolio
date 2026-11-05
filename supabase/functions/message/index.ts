// The message Edge Function (docs/sheet-messages.md): a message Lisul types to Claude in /plan.
// /plan POSTs { text } with his Supabase access token; the function checks the token is the
// owner's (as calendar-connect's /start does), saves the message pending, then fires the morning
// task with the fixed text "trigger: message / reasons: none" (src/sheet/routine-fire.mjs). The
// run reads the pending messages through read_planner and answers them with answer_messages.
// No fire when another pending message was fired under 3 minutes ago (shouldFire): that run reads
// this one too. A message that isn't fired (rate limited, or the fire failed) stays pending, and
// the next send, replan or morning run picks it up. The message text never goes in the fire.
// A fired message keeps the run's claude.ai link and a first step, "Started Claude" (startedPatch);
// a batched one gets the link of the run it rides on.
//
// Deploy from the repo root:
//   npx supabase functions deploy message --use-api --no-verify-jwt
// --no-verify-jwt as calendar-connect: it checks the caller's token itself, against Auth.
//
// Secrets: SHEET_ROUTINE_ID and SHEET_ROUTINE_TOKEN, shared with telegram and routine-fire, read
// in ../_shared/capture.ts (the save and the fire, which the telegram function shares). The token
// is never logged or returned.
import { messageText } from "../../../src/sheet/messages.mjs";
import { corsFor } from "../../../src/sheet/mailconnect.mjs";
import { db, env } from "../_shared/server.ts";
import { saveAndFire } from "../_shared/capture.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  const cors = corsFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { ...cors, Allow: "POST" } });
  const reply = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: cors });
  try {
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    if (!(await isOwner(bearer))) return reply({ error: "not-owner" }, 403);
    let body: { text?: unknown } = {};
    try { body = await req.json(); } catch { /* not JSON */ }
    const text = messageText(body?.text);
    if (!text) return reply({ error: "bad-text" }, 400);

    return reply(await saveAndFire(text, new Date()));
  } catch (e) {
    console.error("message:", e instanceof Error ? e.message : "failed");
    return reply({ error: "failed" }, 500);
  }
});

// Whether the access token is a live Supabase session of settings.owner_email.
async function isOwner(accessToken: string) {
  if (!accessToken) return false;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return false;
  const { email } = await res.json();
  const owner = (await db("settings?select=owner_email"))?.[0]?.owner_email ?? null;
  return Boolean(email) && email === owner;
}

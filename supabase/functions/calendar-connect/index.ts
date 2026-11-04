// The calendar-connect Edge Function (docs/sheet-v5.md, "Edge Functions"): connects Lisul's own
// Google account for free/busy only, apart from mail, so busy-sync can save his busy times every
// 10 minutes. It works as mail-connect does: /plan Settings POSTs to /start with his Supabase
// access token; /start checks it is the owner's, records a one-time nonce and answers with
// Google's consent URL; Google sends him back to /callback, which uses up the nonce, swaps the
// code for a refresh token and stores it in Vault (calendar_account_save), then sends him back
// to /plan. The state, the consent URL, the ID token's email and the CORS rule are in
// src/sheet/mailconnect.mjs, which the tests cover.
//
// It asks for openid, email and calendar.freebusy (CALENDAR_SCOPES), and keeps the grant only
// when the ID token's verified email is settings.owner_email: the identity scopes are there only
// to prove whose account it is. OAuth is Google's web server flow
// (developers.google.com/identity/protocols/oauth2/web-server). The callback URL,
//   https://<project>.supabase.co/functions/v1/calendar-connect/callback
// must be listed as an authorized redirect URI on the Google client.
//
// Deploy from the repo root:
//   npx supabase functions deploy calendar-connect --use-api --no-verify-jwt
// --no-verify-jwt because /callback comes from Google with no JWT, proven by the signed state.
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and MAIL_STATE_SECRET, shared with
// mail-connect (a state names its grant, so one can't be spent on the other). Tokens are never
// logged, and never put in a response or a redirect.
import { signState, verifyState, googleAuthUrl, corsFor, idTokenEmail, CALENDAR_SCOPES, FREEBUSY } from "../../../src/sheet/mailconnect.mjs";
import { ORIGIN } from "../../../src/site.mjs";
import { db, env } from "../_shared/server.ts";
import { googleToken } from "../_shared/google.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CLIENT_ID = env("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET");
const STATE_SECRET = env("MAIL_STATE_SECRET");
const CALLBACK = `${SUPABASE_URL}/functions/v1/calendar-connect/callback`;
const STATE_TTL = 10 * 60_000;
const GRANT = "calendar";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/start")) return start(req);
  if (!url.pathname.endsWith("/callback")) return new Response("not found", { status: 404 });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return back("not-set-up");
  try {
    return await callback(url);
  } catch (e) {
    console.error("calendar-connect:", e instanceof Error ? e.message : "failed");
    return back("failed");
  }
});

// Back to /plan, which shows the outcome. A reason is one of the fixed words in this file.
const back = (reason?: string) =>
  Response.redirect(reason ? `${ORIGIN}/plan/?calendar=error&reason=${reason}` : `${ORIGIN}/plan/?calendar=connected`, 302);

const ownerEmail = async () => ((await db("settings?select=owner_email"))?.[0]?.owner_email ?? null) as string | null;

// --- /start -------------------------------------------------------------------------------

async function start(req: Request) {
  const cors = corsFor(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { ...cors, Allow: "POST" } });
  const fail = (error: string, status: number) => Response.json({ error }, { status, headers: cors });
  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return fail("not-set-up", 503);
  try {
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
    const owner = await ownerOf(bearer);
    if (!owner) return fail("not-owner", 403);
    const nonce = crypto.randomUUID();
    await db(`mail_connect_states?created_at=lt.${encodeURIComponent(new Date(Date.now() - STATE_TTL).toISOString())}`, { method: "DELETE" });
    await db("mail_connect_states", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ nonce }) });
    const state = await signState({ owner, nonce, grant: GRANT }, STATE_SECRET, Date.now());
    const url = googleAuthUrl({ clientId: CLIENT_ID, redirectUri: CALLBACK, state, loginHint: owner, scope: CALENDAR_SCOPES });
    return Response.json({ url }, { headers: cors });
  } catch (e) {
    console.error("calendar-connect:", e instanceof Error ? e.message : "failed");
    return fail("failed", 500);
  }
}

// The signed-in user's email when the access token is a live Supabase session of the owner.
async function ownerOf(accessToken: string) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const { email } = await res.json();
  return email && email === (await ownerEmail()) ? email : null;
}

// --- /callback ----------------------------------------------------------------------------

async function callback(url: URL) {
  const q = url.searchParams;
  const state = await verifyState(q.get("state"), STATE_SECRET, Date.now());
  if (!state?.nonce || state.grant !== GRANT) return back("expired");
  // Use up the nonce, so a replayed state is refused.
  const used = await db(`mail_connect_states?nonce=eq.${encodeURIComponent(state.nonce)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!used?.length) return back("expired");
  if (q.get("error")) return back(q.get("error") === "access_denied" ? "denied" : "google");
  const code = q.get("code") ?? "";
  if (!code) return back("google");
  const { ok, grant } = await googleToken({ code, redirect_uri: CALLBACK, grant_type: "authorization_code" });
  if (!ok) return back("google");
  if (!grant.refresh_token) return back("not-offline");
  // Each permission can be unticked on Google's screen; without free/busy there is nothing to read.
  if (!String(grant.scope ?? "").split(" ").includes(FREEBUSY)) return back("no-freebusy");
  // Only his own account: the ID token's verified email must be the owner's.
  const email = idTokenEmail(grant.id_token);
  if (!email || email !== (await ownerEmail())) return back("not-owner-account");
  await db("rpc/calendar_account_save", { method: "POST", body: JSON.stringify({ account: email, refresh: grant.refresh_token }) });
  return back();
}

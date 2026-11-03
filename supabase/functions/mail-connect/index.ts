// The mail-connect Edge Function (docs/sheet-sources.md, ADR 0002): connects one Google mail
// account, read-only, for the inbox sweep. /plan Settings POSTs to /start with Lisul's Supabase
// access token in the Authorization header; /start checks it is the owner's, records a one-time
// nonce and answers with Google's consent URL carrying a signed state, which /plan opens. Google
// sends him back to /callback, which uses up the nonce, swaps the code for a refresh token, puts
// it in Vault and upserts the mail_accounts row, then sends him back to /plan. The state, the
// consent URL and the CORS rule are in src/sheet/mailconnect.mjs, which the tests cover.
//
// Google's side is the OAuth 2.0 web server flow
// (developers.google.com/identity/protocols/oauth2/web-server). The callback URL below,
//   https://<project>.supabase.co/functions/v1/mail-connect/callback
// must be listed as an authorized redirect URI on the Google client.
//
// Deploy from the repo root with server-side bundling, which follows the imports out of
// supabase/functions (docs/sheet-sources.md, "Edge Functions"):
//   npx supabase functions deploy mail-connect --use-api --no-verify-jwt
// --no-verify-jwt because /callback comes from Google with no JWT, proven by the signed state;
// /start checks its Bearer token itself, with Supabase Auth.
//
// Secrets (function secrets, set by Lisul, never in the repo): GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET and MAIL_STATE_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase. Tokens are never logged, and never put in a response or a redirect.
import { signState, verifyState, googleAuthUrl, corsFor, READONLY } from "../../../src/sheet/mailconnect.mjs";
import { ORIGIN } from "../../../src/site.mjs";
import { db, env } from "../_shared/server.ts";
import { googleToken } from "../_shared/google.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CLIENT_ID = env("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET");
const STATE_SECRET = env("MAIL_STATE_SECRET");
const CALLBACK = `${SUPABASE_URL}/functions/v1/mail-connect/callback`;
// A state lives 10 minutes (mailconnect.mjs); older nonces are cleared on each /start.
const STATE_TTL = 10 * 60_000;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/start")) return start(req);
  if (!url.pathname.endsWith("/callback")) return new Response("not found", { status: 404 });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return back("not-set-up");
  try {
    return await callback(url);
  } catch (e) {
    // Errors thrown below name the step and its HTTP status, never a request or response body.
    console.error("mail-connect:", e instanceof Error ? e.message : "failed");
    return back("failed");
  }
});

// Back to /plan, which shows the outcome. A reason is one of the fixed words in this file.
const back = (reason?: string) =>
  Response.redirect(reason ? `${ORIGIN}/plan/?mail=error&reason=${reason}` : `${ORIGIN}/plan/?mail=connected`, 302);

// --- /start -------------------------------------------------------------------------------

// A fetch from /plan, never a navigation: the token rides in a header, so it stays out of URLs,
// history and logs. The browser asks first with an OPTIONS preflight (the Authorization header
// makes the request non-simple), and only the site's origin may read the answer.
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
    const state = await signState({ owner, nonce }, STATE_SECRET, Date.now());
    return Response.json({ url: googleAuthUrl({ clientId: CLIENT_ID, redirectUri: CALLBACK, state }) }, { headers: cors });
  } catch (e) {
    console.error("mail-connect:", e instanceof Error ? e.message : "failed");
    return fail("failed", 500);
  }
}

// The signed-in user's email when the access token is a live Supabase session of the owner
// (settings.owner_email, the same test as is_owner() in supabase/schema.sql), otherwise null.
async function ownerOf(accessToken: string) {
  if (!accessToken) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const { email } = await res.json();
  const [settings] = await db("settings?select=owner_email");
  return email && email === settings?.owner_email ? email : null;
}

// --- /callback ----------------------------------------------------------------------------

async function callback(url: URL) {
  const q = url.searchParams;
  const state = await verifyState(q.get("state"), STATE_SECRET, Date.now());
  if (!state?.nonce) return back("expired");
  // Use up the nonce: the delete hands back the row only the first time, so a state replayed
  // (from history, say) is refused even inside its 10 minutes.
  const used = await db(`mail_connect_states?nonce=eq.${encodeURIComponent(state.nonce)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!used?.length) return back("expired");
  // Google's own error (the user said no, for one) comes back instead of a code.
  if (q.get("error")) return back(q.get("error") === "access_denied" ? "denied" : "google");
  const grant = await exchange(q.get("code") ?? "");
  if (!grant) return back("google");
  // Without a refresh token the account could only be read for an hour.
  if (!grant.refresh_token) return back("not-offline");
  // Google's consent screen lets each permission be unticked; without Gmail there is nothing to read.
  if (!String(grant.scope ?? "").split(" ").includes(READONLY)) return back("no-gmail");
  const email = await profileEmail(grant.access_token!);
  if (!email) return back("profile");
  await db("rpc/mail_account_save", { method: "POST", body: JSON.stringify({ account: email, refresh: grant.refresh_token }) });
  return back();
}

// The authorization code swapped at Google's token endpoint (https://oauth2.googleapis.com/token,
// in ../_shared/google.ts), or null when Google refuses it.
async function exchange(authCode: string) {
  if (!authCode) return null;
  const { ok, grant } = await googleToken({ code: authCode, redirect_uri: CALLBACK, grant_type: "authorization_code" });
  return ok ? grant : null;
}

// The account's address, from the Gmail profile (gmail.readonly covers it; no extra scope).
async function profileEmail(accessToken: string) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const { emailAddress } = await res.json();
  return typeof emailAddress === "string" && emailAddress ? emailAddress : null;
}

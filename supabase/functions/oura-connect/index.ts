// The oura-connect Edge Function (docs/sheet-v5.md, "Oura"): connects Lisul's Oura account so
// oura-sync can read when he sleeps. It works as calendar-connect does: /plan Settings POSTs to
// /start with his Supabase access token; /start checks it is the owner's, records a one-time
// nonce with a PKCE code verifier, and answers with Oura's consent URL; Oura sends him back to
// /callback, which uses up the nonce, swaps the code (with the verifier) for tokens and stores
// them in Vault (oura_token_save), then sends him back to /plan. The consent URL, PKCE and the
// token call are in src/sheet/oura.mjs, the state and the CORS rule in src/sheet/mailconnect.mjs;
// the tests cover both.
//
// OAuth2 authorization code with PKCE, scope daily (cloud.ouraring.com/docs/authentication). The
// callback URL,
//   https://<project>.supabase.co/functions/v1/oura-connect/callback
// must be the app's redirect URI at cloud.ouraring.com/oauth/applications, exactly. Oura gives no
// ID token, so the owner check is /start's: the state is signed for his session and works once.
//
// Deploy from the repo root:
//   npx supabase functions deploy oura-connect --use-api --no-verify-jwt
// --no-verify-jwt because /callback comes from Oura with no JWT, proven by the signed state.
//
// Secrets: OURA_CLIENT_ID, OURA_CLIENT_SECRET, and MAIL_STATE_SECRET, shared with mail-connect
// (a state names its grant, so one can't be spent on another). Tokens are never logged, and
// never put in a response or a redirect.
import { signState, verifyState, corsFor } from "../../../src/sheet/mailconnect.mjs";
import { ouraAuthUrl, ouraToken, pkce } from "../../../src/sheet/oura.mjs";
import { ORIGIN } from "../../../src/site.mjs";
import { db, env } from "../_shared/server.ts";

const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CLIENT_ID = env("OURA_CLIENT_ID");
const CLIENT_SECRET = env("OURA_CLIENT_SECRET");
const STATE_SECRET = env("MAIL_STATE_SECRET");
const CALLBACK = `${SUPABASE_URL}/functions/v1/oura-connect/callback`;
const STATE_TTL = 10 * 60_000;
const GRANT = "oura";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith("/start")) return start(req);
  if (!url.pathname.endsWith("/callback")) return new Response("not found", { status: 404 });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return back("not-set-up");
  try {
    return await callback(url);
  } catch (e) {
    console.error("oura-connect:", e instanceof Error ? e.message : "failed");
    return back("failed");
  }
});

// Back to /plan, which shows the outcome. A reason is one of the fixed words in this file.
const back = (reason?: string) =>
  Response.redirect(reason ? `${ORIGIN}/plan/?oura=error&reason=${reason}` : `${ORIGIN}/plan/?oura=connected`, 302);

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
    const { verifier, challenge } = await pkce();
    await db(`mail_connect_states?created_at=lt.${encodeURIComponent(new Date(Date.now() - STATE_TTL).toISOString())}`, { method: "DELETE" });
    await db("mail_connect_states", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ nonce, verifier }) });
    const state = await signState({ owner, nonce, grant: GRANT }, STATE_SECRET, Date.now());
    return Response.json({ url: ouraAuthUrl({ clientId: CLIENT_ID, redirectUri: CALLBACK, state, challenge }) }, { headers: cors });
  } catch (e) {
    console.error("oura-connect:", e instanceof Error ? e.message : "failed");
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
  const [settings] = await db("settings?select=owner_email");
  return email && email === settings?.owner_email ? email : null;
}

// --- /callback ----------------------------------------------------------------------------

async function callback(url: URL) {
  const q = url.searchParams;
  const state = await verifyState(q.get("state"), STATE_SECRET, Date.now());
  if (!state?.nonce || state.grant !== GRANT) return back("expired");
  // Use up the nonce, so a replayed state is refused; its row holds the PKCE verifier.
  const used = await db(`mail_connect_states?nonce=eq.${encodeURIComponent(state.nonce)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!used?.length || !used[0].verifier) return back("expired");
  if (q.get("error")) return back(q.get("error") === "access_denied" ? "denied" : "oura");
  const code = q.get("code") ?? "";
  if (!code) return back("oura");
  const { ok, grant } = await ouraToken(fetch, {
    grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: used[0].verifier,
  }, { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  if (!ok) return back("oura");
  if (!grant.refresh_token) return back("not-offline");
  const expires_at = new Date(Date.now() + Number(grant.expires_in ?? 0) * 1000).toISOString();
  await db("rpc/oura_token_save", { method: "POST", body: JSON.stringify({ refresh: grant.refresh_token, access: grant.access_token, expires_at }) });
  return back();
}

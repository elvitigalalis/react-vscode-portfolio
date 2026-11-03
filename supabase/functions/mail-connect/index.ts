// The mail-connect Edge Function (docs/sheet-sources.md, ADR 0002): connects one Google mail
// account, read-only, for the inbox sweep. /plan Settings sends Lisul to /start with his Supabase
// access token; /start checks it is the owner's and sends him on to Google's consent screen with a
// signed state. Google sends him back to /callback, which swaps the code for a refresh token, puts
// it in Vault and upserts the mail_accounts row, then sends him back to /plan. The state and the
// consent URL are built in src/sheet/mailconnect.mjs, which the tests cover.
//
// Google's side is the OAuth 2.0 web server flow
// (developers.google.com/identity/protocols/oauth2/web-server). The callback URL below,
//   https://<project>.supabase.co/functions/v1/mail-connect/callback
// must be listed as an authorized redirect URI on the Google client.
//
// Deploy from the repo root with server-side bundling, which follows the import out of
// supabase/functions (docs/sheet-sources.md, "Edge Functions"):
//   npx supabase functions deploy mail-connect --use-api --no-verify-jwt
// --no-verify-jwt because neither request carries a JWT header: /start is a browser navigation with
// the token in the query, checked below with Supabase Auth, and /callback comes from Google,
// proven by the signed state.
//
// Secrets (function secrets, set by Lisul, never in the repo): GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET and MAIL_STATE_SECRET. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// provided by Supabase. Tokens are never logged, and never put in a response or a redirect.
import { signState, verifyState, googleAuthUrl } from "../../../src/sheet/mailconnect.mjs";
import { ORIGIN } from "../../../src/site.mjs";

const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const CLIENT_ID = env("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = env("GOOGLE_CLIENT_SECRET");
const STATE_SECRET = env("MAIL_STATE_SECRET");
const CALLBACK = `${SUPABASE_URL}/functions/v1/mail-connect/callback`;
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const url = new URL(req.url);
  const step = url.pathname.endsWith("/start") ? start : url.pathname.endsWith("/callback") ? callback : null;
  if (!step) return new Response("not found", { status: 404 });
  if (!CLIENT_ID || !CLIENT_SECRET || !STATE_SECRET) return back("not-set-up");
  try {
    return await step(url);
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

async function start(url: URL) {
  const owner = await ownerOf(url.searchParams.get("access_token") ?? "");
  if (!owner) return back("not-owner");
  const state = await signState({ owner, nonce: crypto.randomUUID() }, STATE_SECRET, Date.now());
  // /plan may pass ?hint=<email> to reconnect one account; Google then preselects it.
  const loginHint = url.searchParams.get("hint") || undefined;
  return Response.redirect(googleAuthUrl({ clientId: CLIENT_ID, redirectUri: CALLBACK, state, loginHint }), 302);
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
  if (!(await verifyState(q.get("state"), STATE_SECRET, Date.now()))) return back("expired");
  // Google's own error (the user said no, for one) comes back instead of a code.
  if (q.get("error")) return back(q.get("error") === "access_denied" ? "denied" : "google");
  const grant = await exchange(q.get("code") ?? "");
  if (!grant) return back("google");
  // Without a refresh token the account could only be read for an hour.
  if (!grant.refresh_token) return back("not-offline");
  // Google's consent screen lets each permission be unticked; without Gmail there is nothing to read.
  if (!String(grant.scope ?? "").split(" ").includes(READONLY)) return back("no-gmail");
  const email = await profileEmail(grant.access_token);
  if (!email) return back("profile");
  await db("rpc/mail_account_save", { method: "POST", body: JSON.stringify({ account: email, refresh: grant.refresh_token }) });
  return back();
}

// The authorization code swapped at Google's token endpoint, or null when Google refuses it.
async function exchange(authCode: string): Promise<{ access_token: string; refresh_token?: string; scope?: string } | null> {
  if (!authCode) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: authCode,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: CALLBACK,
      grant_type: "authorization_code",
    }),
  });
  return res.ok ? res.json() : null;
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

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  // The status only: an rpc's body carries the refresh token, and an error could echo it.
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

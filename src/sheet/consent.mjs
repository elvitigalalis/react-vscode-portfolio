// The OAuth consent page's network side (/oauth/consent/, docs/sheet-sources.md; ADR 0002).
// Supabase Auth's OAuth 2.1 server sends a client asking for access here, with an
// `authorization_id`; the signed-in user sees who is asking and for what, then approves or
// denies, and Supabase answers with the URL to send the browser back to.
// https://supabase.com/docs/guides/auth/oauth-server/getting-started ("consent screen"). These
// are the REST calls behind supabase-js's auth.oauth.getAuthorizationDetails,
// approveAuthorization and denyAuthorization (@supabase/auth-js 2.118, GoTrueClient), made with
// plain fetch like the rest of the site.
import { SHEET } from "../site.mjs";
import { accessToken } from "./api.mjs";

async function call(id, suffix = "", init = {}) {
  const token = await accessToken();
  if (!token) throw new Error("signed out");
  const res = await fetch(`${SHEET.supabaseUrl}/auth/v1/oauth/authorizations/${encodeURIComponent(id)}${suffix}`, {
    ...init,
    headers: { apikey: SHEET.anonKey, authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.msg ?? out.message ?? out.error_description ?? `${res.status}`);
  return out;
}

// { authorization_id, client: { id, name, uri, logo_uri }, redirect_uri, scope, user: { email } }
// while consent is needed, or { redirect_url } when this client was already approved.
export const authorizationDetails = (id) => call(id);

// Approve or deny; either way the answer is { redirect_url } back to the client.
export const decide = (id, action) => call(id, "/consent", { method: "POST", body: JSON.stringify({ action }) });

// What each scope lets the client see, in plain words. Anything else shows as its name.
const SCOPES = {
  openid: "Confirm that it is you",
  email: "See your email address",
  profile: "See your name and profile picture",
  phone: "See your phone number",
};
export const scopeLines = (scope) => (scope ?? "").split(/\s+/).filter(Boolean).map((s) => SCOPES[s] ?? s);

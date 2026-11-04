// calendar-connect's /token (docs/sheet-v5.md, "Edge Functions"), its pure side: /plan POSTs the
// owner's Supabase access token and gets a Google access token from the server's calendar grant,
// so the week keeps reading his events after the sign-in's Google token runs out (Supabase never
// refreshes that one). The answer is { access_token, expires_in } and nothing else: never the
// refresh token, which stays in Vault. The Edge Function wires in the calls; the tests fake them.
import { APP_CREATED, EVENTS_READONLY } from "./mailconnect.mjs";

// The grant can serve /plan only if he left both /plan scopes ticked on Google's screen. Google's
// refresh answer lists the scopes the token holds (developers.google.com/identity/protocols/
// oauth2/web-server, "Refreshing an access token").
export const hasPlanScopes = (scope) => {
  const have = String(scope ?? "").split(" ");
  return have.includes(EVENTS_READONLY) && have.includes(APP_CREATED);
};

// `deps`: userEmail(bearer) the session's email or null, ownerEmail() settings.owner_email,
// refreshToken() the Vault token or null, refresh(token) googleToken's { ok, status, grant }.
// Returns { status, body }, plus lastError for calendar_account when Google refused the grant.
export async function serveToken(bearer, deps) {
  const email = bearer ? await deps.userEmail(bearer) : null;
  if (!email || email !== (await deps.ownerEmail())) return { status: 403, body: { error: "not-owner" } };
  const refresh = await deps.refreshToken();
  if (!refresh) return { status: 409, body: { error: "not-connected" } };
  const { ok, status, grant } = await deps.refresh(refresh);
  if (!ok) {
    // As refusedWhy in _shared/google.ts: Google's error code, never its description.
    const why = /^[\w-]{1,40}$/.test(grant?.error ?? "") ? grant.error : `HTTP ${status}`;
    return { status: 502, body: { error: "refused" }, lastError: `token refresh refused: ${why}` };
  }
  if (!hasPlanScopes(grant.scope)) return { status: 409, body: { error: "needs-scopes" } };
  return { status: 200, body: { access_token: grant.access_token, expires_in: Number(grant.expires_in) || 3600 } };
}

// Google's token endpoint, for mail-connect (an authorization code) and mail-mcp (a refresh
// token): https://developers.google.com/identity/protocols/oauth2/web-server, steps 5 and
// "Refreshing an access token (offline access)". The client ID and secret are function secrets.
import { env } from "./server.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type Grant = { access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string };

// Swaps `fields` (code + redirect_uri + grant_type=authorization_code, or refresh_token +
// grant_type=refresh_token) for tokens. `ok` is false when Google refuses; `grant` then holds
// Google's error and error_description, which never contain a token.
export async function googleToken(fields: Record<string, string>): Promise<{ ok: boolean; status: number; grant: Grant }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), ...fields }),
  });
  const grant = await res.json().catch(() => ({}));
  return { ok: res.ok && Boolean(grant.access_token), status: res.status, grant };
}

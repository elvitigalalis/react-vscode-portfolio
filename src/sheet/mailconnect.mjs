// The pure parts of the mail-connect Edge Function (docs/sheet-sources.md, "Pure modules"): the
// signed OAuth `state` and Google's consent URL. Web Crypto only, so the same file runs in Node
// (the tests) and in Deno (supabase/functions/mail-connect).

// A state lives 10 minutes: long enough to pick an account and click through Google's screens.
const STATE_TTL = 10 * 60_000;

const enc = new TextEncoder();

// base64url without padding (RFC 4648 §5), so a state can sit in a URL as it is.
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const hmacKey = (secret, use) =>
  crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [use]);

// `<body>.<mac>`: the body is the payload and the time it was signed, as base64url JSON; the mac
// is HMAC-SHA256 of the body under the secret.
export async function signState(payload, secret, now) {
  const body = toB64(enc.encode(JSON.stringify({ p: payload, t: now })));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(body));
  return `${body}.${toB64(new Uint8Array(mac))}`;
}

// The payload, or null for anything that isn't a state this secret signed in the last 10
// minutes. crypto.subtle.verify compares the mac in constant time.
export async function verifyState(state, secret, now) {
  try {
    const parts = String(state ?? "").split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [body, mac] = parts;
    if (toB64(fromB64(mac)) !== mac) return null;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), fromB64(mac), enc.encode(body)))) return null;
    const { p, t } = JSON.parse(new TextDecoder().decode(fromB64(body)));
    if (typeof t !== "number" || now - t > STATE_TTL || t - now > 60_000) return null;
    return p ?? null;
  } catch {
    return null;
  }
}

// Google's consent screen for one mail account, read-only. Per Google's web server flow
// (developers.google.com/identity/protocols/oauth2/web-server): access_type=offline asks for a
// refresh token, and prompt=consent makes Google send one again when an account reconnects.
// include_granted_scopes=false keeps the grant to gmail.readonly alone.
export function googleAuthUrl({ clientId, redirectUri, state, loginHint }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
    state,
  });
  if (loginHint) q.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// /plan's Google access token (docs/sheet-v5.md, "/plan"). The one Supabase hands back at sign-in
// lasts an hour and Supabase never refreshes it, so once it runs out (or Google answers 401) the
// token comes from calendar-connect's /token, which refreshes the server's calendar grant. Pure:
// api.mjs passes in the session store, the /token call and the clock; the tests fake them.

// Google's tokens last an hour (expires_in); treat them as stale 5 minutes early.
const EARLY_MS = 5 * 60_000;
// After the server can't give a token, wait a minute before asking again.
const RETRY_MS = 60_000;

// read() and save(s) the session (provider_token, provider_expires_at); fetchToken() answers
// { access_token, expires_in } or { error }, or throws.
export function googleTokens({ read, save, fetchToken, now = Date.now }) {
  let pending = null;
  let failedAt = -Infinity;
  let why = null;

  const live = () => { const s = read(); return s?.provider_token && now() < s.provider_expires_at ? s.provider_token : null; };

  // One /token call at a time: parallel callers share it.
  function fromServer() {
    return (pending ??= (async () => {
      try {
        const out = await fetchToken();
        if (!out?.access_token) throw Object.assign(new Error("no token"), { why: out?.error ?? "failed" });
        const s = read();
        if (s) save({ ...s, provider_token: out.access_token, provider_expires_at: now() + Number(out.expires_in ?? 3600) * 1000 - EARLY_MS });
        why = "ok";
        return out.access_token;
      } catch (e) {
        why = e?.why ?? "failed";
        failedAt = now();
        return null;
      } finally {
        pending = null;
      }
    })());
  }

  // A live token, or null when the server can't give one either.
  async function token() {
    const t = live();
    if (t) return t;
    if (!read() || now() - failedAt < RETRY_MS) return null;
    return fromServer();
  }

  // Marks `t` dead, if it is still the session's token.
  function invalidate(t) {
    const s = read();
    if (s?.provider_token === t) save({ ...s, provider_expires_at: 0 });
  }

  // fn(token) makes the Google call and returns its Response; on a 401 the token is dropped and
  // fn runs once more with a fresh one. null when there is no token at all.
  async function call(fn) {
    const t = await token();
    if (!t) return null;
    const res = await fn(t);
    if (res.status !== 401) return res;
    invalidate(t);
    const next = await token();
    if (!next || next === t) return res;
    const again = await fn(next);
    if (again.status === 401) invalidate(next);
    return again;
  }

  return {
    token,
    call,
    // A token is live now (no network); after a successful token() it stays true until expiry.
    ready: () => Boolean(live()),
    // The last /token outcome: "ok", or why it gave none ("needs-scopes", "not-connected",
    // "refused", "not-owner", "failed"); null before the first ask.
    status: () => why,
  };
}

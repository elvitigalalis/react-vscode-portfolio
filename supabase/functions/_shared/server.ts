// What every Sheet Edge Function shares: reading its secrets, checking a shared-secret header,
// and the database through PostgREST with the service key. Supabase keeps shared code in a
// folder starting with an underscore, which is never deployed as a function of its own
// (supabase.com/docs/guides/functions/development-tips, "Organizing your Edge Functions").
// `functions deploy --use-api` bundles on Supabase's side from each function's imports, so this
// folder and src/sheet/ go up with every function that imports them ("This also simplifies
// importing files outside the supabase/ directory within Edge Functions": supabase.com/changelog/
// 33613-deploy-edge-functions-from-cli-without-needing-docker-import-files-outside-of-supabase-directory).

import { feedStateRow } from "../../../src/sheet/feed-state.mjs";

export const env = (name: string) => Deno.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

// Whether a header holds the secret, compared without stopping at the first difference.
export function secretMatches(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// --- The database, through PostgREST with the service key (it bypasses row-level security) ---

// A failed call throws with the table or rpc, the HTTP status and PostgREST's error code (like
// 23505), never the response body: an rpc's arguments carry a refresh token, and an error can
// echo them. A reply with no body (204, or 201 with return=minimal) is null.
export async function db(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...init.headers },
  });
  const text = await res.text();
  if (!res.ok) {
    let code = "";
    try { code = String(JSON.parse(text).code ?? ""); } catch { /* not JSON */ }
    throw new Error(`${path.split("?")[0]}: ${res.status}${/^[\w-]{1,10}$/.test(code) ? ` ${code}` : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

// --- Feeds (brightspace, campus) ------------------------------------------------------------

// Upserts a feed's one feed_state row. Only the columns given change, so a failed run keeps the
// last good ETag and Last-Modified, and last_ok_at, which a good read sets (feedStateRow). Upserts follow PostgREST: on_conflict names the unique
// columns, and Prefer: resolution=merge-duplicates says a clash updates
// (docs.postgrest.org/en/stable/references/api/tables_views.html#upsert).
export const saveFeedState = (source: string, row: Record<string, unknown>) =>
  db("feed_state?on_conflict=source", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(feedStateRow(source, row)),
  });

// A fetched feed's text, or a throw when it failed or isn't an iCal calendar.
export async function calendarText(res: Response) {
  if (!res.ok) throw new Error(`feed: HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("feed: not an iCal calendar");
  return text;
}

// A failed feed run: the error's text with the given secrets taken out (a fetch error can quote
// the URL it fetched) and any other link too, cut to a line's length, logged and written to
// feed_state. Recording it can fail too (the database being the problem); the reply says what
// went wrong either way.
export async function feedFailed(source: string, e: unknown, fetched_at: string, secrets: string[] = []) {
  let error = e instanceof Error ? e.message : String(e);
  for (const s of secrets.filter(Boolean)) error = error.split(s).join("<secret>");
  error = error.replace(/(https?|webcals?):\/\/\S+/g, "<link>").slice(0, 300);
  console.error(`${source}:`, error);
  await saveFeedState(source, { fetched_at, ok: false, error }).catch(() => {});
  return Response.json({ ok: false, error }, { status: 502 });
}

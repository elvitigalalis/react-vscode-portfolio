// The Gym tracker's network side (docs/sheet-gym.md): Supabase REST through plain fetch, signed
// in with /plan's session (api.mjs). Reads page through every row; writes come from the outbox
// (gym-sync.mjs) as upserts by id and deletes by id, so each update or delete has a where, as
// pg-safeupdate wants.
import { SHEET } from "../site.mjs";
import { accessToken, SheetError } from "./api.mjs";
import { keyOf } from "./gym-sync.mjs";

async function rest(path, { method = "GET", body, prefer } = {}) {
  const token = await accessToken();
  if (!token) throw new SheetError("gym: signed out");
  const res = await fetch(`${SHEET.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SHEET.anonKey, authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}), ...(prefer ? { prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new SheetError(`gym ${method} ${path.split("?")[0]}: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Supabase answers at most 1000 rows a request (its max-rows), so read in pages until a short one.
const PAGE = 1000;
async function all(table, order) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await rest(`${table}?select=*&order=${order}&limit=${PAGE}&offset=${offset}`);
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// Everything the page draws from, in one go.
export async function loadAll() {
  const [exercises, days, rxs, baselines, swaps, sessions, sets] = await Promise.all([
    all("gym_exercises", "name"), all("gym_program_days", "phase,week,position"), all("gym_prescriptions", "program_day_id,position"),
    all("gym_baselines", "exercise_id"), all("gym_swaps", "created_at"), all("gym_sessions", "started_at"), all("gym_sets", "done_at,id"),
  ]);
  return { exercises, days, rxs, baselines, swaps, sessions, sets };
}

// The outbox's send: an upsert by the table's key (resolution=merge-duplicates with on_conflict,
// https://docs.postgrest.org/en/stable/references/api/tables_views.html#upsert), or a delete by
// ids. Rows of one call share their columns (columns=, so PostgREST reads every key).
export function send(call) {
  const key = keyOf(call.table);
  if (call.op === "delete") {
    return rest(`${call.table}?${key}=in.(${call.ids.map(encodeURIComponent).join(",")})`, { method: "DELETE", prefer: "return=minimal" });
  }
  const columns = [...new Set(call.rows.flatMap(Object.keys))];
  return rest(`${call.table}?on_conflict=${key}&columns=${columns.join(",")}`, {
    method: "POST", body: call.rows, prefer: "resolution=merge-duplicates,return=minimal",
  });
}

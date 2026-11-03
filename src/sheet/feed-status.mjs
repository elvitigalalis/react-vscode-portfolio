// Settings, Feeds status (docs/sheet-sources.md, "/plan"): each feed_state row, so Lisul sees
// whether the hourly Brightspace and campus feed reads worked, without opening Supabase. Text goes in
// through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { plural } from "./logic.mjs";
import { el, settingsHooks } from "./planner.mjs";

const NAMES = { brightspace: "Brightspace", campus: "Campus events" };
const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: SHEET.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// "Brightspace: ok, 12 items, Nov 3, 2:20 PM", or the error. A row with no fetch yet says so.
function line(f) {
  const name = NAMES[f.source] ?? f.source;
  if (!f.fetched_at) return `${name}: not read yet`;
  const how = f.ok ? `ok, ${plural(f.items ?? 0, "item")}` : `failed: ${f.error ?? "unknown error"}`;
  return `${name}: ${how}, ${when(f.fetched_at)}`;
}

async function draw(root) {
  const list = root.querySelector("[data-feeds]");
  const rows = await api.listFeedState();
  list.replaceChildren(...rows.map((f) => el("li", { className: f.ok === false ? "sheet-mail-error" : "", textContent: line(f) })));
  if (!rows.length) list.append(el("li", { className: "small", textContent: "No feed has been read yet." }));
}

// The Feeds section of Settings, filled each time Settings opens (planner.mjs, settingsHooks).
export function setupFeedStatus(root) {
  settingsHooks.push(() => draw(root));
}

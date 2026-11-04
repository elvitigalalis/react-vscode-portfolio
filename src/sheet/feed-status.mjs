// Settings, Feeds status (docs/sheet-sources.md, "/plan"): each feed_state row, so Lisul sees
// whether the hourly Brightspace and campus feed reads worked, without opening Supabase. Text goes in
// through textContent only.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { plural } from "./logic.mjs";
import { actHooks, el, failed, icon, settingsHooks, state } from "./planner.mjs";
import { feedAlert } from "./glance.mjs";
import { githubOrgsFromInput } from "./sources.mjs";

const NAMES = { brightspace: "Brightspace", campus: "Campus events", weather: "Weather", freebusy: "Calendar busy times", handshake: "Handshake", academic: "Academic calendar", github: "GitHub", jira: "Jira" };
const when = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: SHEET.timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// "Brightspace: ok, 12 items, Nov 3, 2:20 PM", or the error. A row with no fetch yet says so.
function line(f) {
  const name = NAMES[f.source] ?? f.source;
  if (!f.fetched_at) return `${name}: not read yet`;
  // A sync with nothing to read yet ("not connected") hasn't failed.
  if (f.ok === null && f.error) return `${name}: ${f.error}`;
  const how = f.ok ? `ok, ${plural(f.items ?? 0, "item")}` : `failed: ${f.error ?? "unknown error"}`;
  return `${name}: ${how}, ${when(f.fetched_at)}`;
}

// A check for a read that worked, an alert for one that failed, nothing before the first read.
const mark = (f) => (f.ok === true ? icon("circle-check") : f.ok === false ? icon("circle-alert") : null);

async function draw(root) {
  root.querySelector("#sheet-gh-orgs").value = (state.settings?.github_orgs ?? []).join(", ");
  root.querySelector("[data-gh-note]").textContent = "";
  const list = root.querySelector("[data-feeds]");
  const rows = await api.listFeedState();
  list.replaceChildren(...rows.map((f) => el("li", { className: f.ok === false ? "sheet-mail-error" : "" }, mark(f), " ", line(f))));
  if (!rows.length) list.append(el("li", { className: "small", textContent: "No feed has been read yet." }));
  chip(root, rows);
}

// The top bar's Feed failed chip (docs/sheet-glance.md, change 6) shows while any feed's last
// read failed, and opens Settings (data-act="settings").
function chip(root, rows) {
  const failed = feedAlert(rows);
  const button = root.querySelector("[data-feed-alert]");
  button.hidden = !failed.length;
  button.title = `${failed.map((s) => NAMES[s] ?? s).join(" and ")} failed. Open Settings to see why`;
}

// v5 SRC1: the GitHub orgs work-sync reads (settings.github_orgs).
async function saveOrgs(root) {
  const github_orgs = githubOrgsFromInput(root.querySelector("#sheet-gh-orgs").value);
  const note = root.querySelector("[data-gh-note]");
  if (!github_orgs) return void (note.textContent = "Org names only, like acme-robotics.");
  try {
    await api.saveSettings({ github_orgs });
    state.settings = { ...state.settings, github_orgs };
    note.textContent = "Saved. Synced within the hour.";
  } catch (e) { failed(e); }
}

// The Feeds section of Settings, filled each time Settings opens (planner.mjs, settingsHooks).
// The chip is set once on load too, from the same rows.
export function setupFeedStatus(root) {
  settingsHooks.push(() => draw(root));
  actHooks["save-gh-orgs"] = () => saveOrgs(root);
  api.listFeedState().then((rows) => chip(root, rows), () => {});
}

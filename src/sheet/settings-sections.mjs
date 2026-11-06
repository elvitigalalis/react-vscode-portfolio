// Settings' four groups you can jump to (research/plan-improvements.md 12): Accounts, Day, Claude
// and Status, with an index at the top. Opening at a group (the Feed failed chip at Status,
// Calendars in the ⋯ menu at Accounts) scrolls to it; on a phone the other groups start closed
// (glance.mjs, settingsOpen). Loaded with Settings (settings.mjs); planner.mjs calls settingsNav.
import { settingsOpen } from "./glance.mjs";
import { NARROW, actHooks, settingsHooks, settingsNav, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

// Open the group and bring it to the top of the dialog, under the index.
function go(section) {
  const group = section && $(`.sheet-settings-group[data-section="${section}"]`);
  if (!group) return;
  group.open = true;
  group.scrollIntoView({ block: "start" });
  group.querySelector("summary").focus({ preventScroll: true });
}

function open(section) {
  const groups = [...root.querySelectorAll(".sheet-settings-group")];
  settingsOpen(groups.map((g) => g.dataset.section), section, matchMedia(NARROW).matches).forEach((o, i) => { groups[i].open = o; });
  $("[data-cal-ids-note]").textContent = "";
  go(section);
}

export function setupSettingsSections(node) {
  root = node;
  Object.assign(settingsNav, { open, go });
  actHooks["settings-go"] = (e) => go(e.target.closest("[data-act]").dataset.section);
  // The extra calendar IDs, once a dialog of their own (planner.mjs saves them).
  settingsHooks.push(() => { $("#sheet-cal-ids").value = state.calendars.join("\n"); });
}

// Settings' four groups you can jump to (research/plan-improvements.md 12): Accounts, Day, Claude
// and Status, listed down the left (across the top on a phone), which marks the one in view.
// Opening at a group (the Feed failed chip at Status, Calendars in the ⋯ menu at Accounts) scrolls
// to it. On a wide screen every group shows, each under its name as a plain heading; on a phone
// the list works as tabs, showing one group at a time, the first unless asked for another
// (glance.mjs, settingsOpen). Loaded with Settings (settings.mjs); planner.mjs calls settingsNav.
import { settingsOpen } from "./glance.mjs";
import { NARROW, actHooks, settingsHooks, settingsNav, state } from "./planner.mjs";

let root;
const $ = (sel) => root.querySelector(sel);

// The section list marks the group in view (aria-current), as it scrolls.
function mark(section) {
  for (const b of root.querySelectorAll('[data-act="settings-go"]')) {
    if (b.dataset.section === section) b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  }
}

// The last open group whose top has reached the list's top (the last one once scrolled to the
// end), or the first open one; none while every group is closed (a phone, opened at none).
function inView() {
  const dialog = $("[data-settings]");
  const groups = [...root.querySelectorAll(".sheet-settings-group")].filter((g) => g.open);
  if (!dialog.open) return groups[0]?.dataset.section;
  const line = dialog.getBoundingClientRect().top + 80;
  const scrolls = dialog.scrollHeight > dialog.clientHeight + 2;
  const end = scrolls && dialog.scrollTop + dialog.clientHeight >= dialog.scrollHeight - 2;
  const past = groups.filter((g) => g.getBoundingClientRect().top <= line);
  return (end ? groups.at(-1) : past.at(-1) ?? groups[0])?.dataset.section;
}

const groupsOf = () => [...root.querySelectorAll(".sheet-settings-group")];
// Which groups are open: all on a wide screen, only `section` on a phone.
const show = (section) => settingsOpen(groupsOf().map((g) => g.dataset.section), section, matchMedia(NARROW).matches).forEach((o, i) => { groupsOf()[i].open = o; });

// Open the group and bring it to the top of the dialog, under the index.
function go(section) {
  const group = section && $(`.sheet-settings-group[data-section="${section}"]`);
  if (!group) return mark(inView());
  show(section);
  group.scrollIntoView({ block: "start" });
  group.querySelector("summary").focus({ preventScroll: true });
  mark(section);
}

function open(section) {
  // A phone shows one group, the first unless asked for another.
  const at = section ?? (matchMedia(NARROW).matches ? groupsOf()[0]?.dataset.section : undefined);
  show(at);
  $("[data-cal-ids-note]").textContent = "";
  go(at);
}

export function setupSettingsSections(node) {
  root = node;
  Object.assign(settingsNav, { open, go });
  let frame = 0;
  $("[data-settings]").addEventListener("scroll", () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => mark(inView()));
  }, { passive: true });
  for (const g of groupsOf()) {
    g.addEventListener("toggle", () => mark(inView()));
    // A group's name is its heading, not a switch: the list beside it does the jumping.
    const name = g.querySelector("summary");
    Object.assign(name, { tabIndex: -1 });
    name.setAttribute("role", "heading");
    name.setAttribute("aria-level", "3");
    name.addEventListener("click", (e) => e.preventDefault());
  }
  actHooks["settings-go"] = (e) => go(e.target.closest("[data-act]").dataset.section);
  // The extra calendar IDs, once a dialog of their own (planner.mjs saves them).
  settingsHooks.push(() => { $("#sheet-cal-ids").value = state.calendars.join("\n"); });
}

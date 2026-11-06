// The top bar on /plan (docs/sheet-glance.md, change 6): the ‹ Today › labels, the Nudges
// toggle's state and the ⋯ menu (which holds Gym, and on phones Feed failed). planner.mjs handles the clicks; feed-status.mjs the Feed
// failed chip. Text goes in through textContent only.
import { state, renderHooks, NARROW } from "./planner.mjs";
import { weekdayName } from "./logic.mjs";

function draw(root) {
  // On phones the arrows step the one day on screen, and the middle button names it.
  const phone = matchMedia(NARROW).matches;
  const unit = phone ? "day" : "week";
  root.querySelector('[data-act="prev"]').ariaLabel = `Previous ${unit}`;
  root.querySelector('[data-act="next"]').ariaLabel = `Next ${unit}`;
  // The weekday and day of the month ("Tue 3"), short enough to keep the bar on one row; the
  // day's own header under it gives the month.
  if (state.focus) root.querySelector("[data-focus-day]").textContent = `${weekdayName(state.focus)} ${Number(state.focus.slice(8))}`;
  // A toggle keeps one label and says its state with aria-pressed.
  const on = Boolean(state.settings?.nudges_on);
  const nudges = root.querySelector('[data-act="telegram"]');
  nudges.setAttribute("aria-pressed", String(on));
  nudges.querySelector("use").setAttribute("href", on ? "#i-bell" : "#i-bell-off");
}

export function setupTopBar(root) {
  renderHooks.push(() => draw(root));
  matchMedia(NARROW).addEventListener("change", () => draw(root));
  // The ⋯ menu is a native popover: Escape and a click outside close it, and focus goes back
  // to the button. It opens under the button with its first item focused.
  const menu = root.querySelector("[data-more]");
  const button = root.querySelector('[popovertarget="sheet-more"]');
  menu.addEventListener("toggle", (e) => {
    if (e.newState !== "open") return;
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, document.documentElement.clientWidth - menu.offsetWidth - 8))}px`;
    // The first item shown: Feed failed shows only on phones while a feed failed (sheet.css).
    [...menu.querySelectorAll("a, button")].find((x) => x.getClientRects().length)?.focus();
  });
}

// The week's newer parts (docs/sheet.md, "The week"), which planner.mjs draws through weekParts.
// The page's script imports this module, so its code sits in the page's chunk, not the planner's.
import { SHEET } from "../site.mjs";
import { plural, weekDays } from "./logic.mjs";
import { chipsLabel, dayChips, lateNap } from "./oura-day.mjs";
import { el, icon, render, state, weekParts } from "./planner.mjs";
import { pickTips } from "./tips.mjs";

// Today's summary line, the progress ring and count, is the button that opens the rest of today's
// header (Oura, wind-down, the week's count, and Next while there is a Now).
weekParts.summary = (progress) => {
  const b = el("button", { type: "button", className: "sheet-today-sum sheet-today-toggle" },
    progress ?? el("span", { className: "sheet-progress", textContent: "Today" }),
    el("span", { className: "visually-hidden", textContent: ", more about today" }), icon("chevron-right"));
  b.setAttribute("aria-expanded", String(weekParts.open));
  b.setAttribute("aria-controls", "sheet-today-more");
  b.onclick = () => { weekParts.open = !weekParts.open; render(); document.querySelector(".sheet-today-toggle")?.focus(); };
  return b;
};

// A week with nothing on it says so once, in the middle, with the one thing to do: Plan today on
// this week, else a task on the day in view.
weekParts.empty = () => {
  const plan = weekDays(state.week).includes(state.today);
  const go = el("button", { type: "button", className: "sheet-btn primary lg", textContent: plan ? "Plan today" : "Add a task" });
  if (plan) go.dataset.act = "plan";
  else go.onclick = () => document.querySelector(`.sheet-add[data-day="${state.focus}"]:not([data-also])`)?.focus();
  return el("div", { className: "sheet-week-empty" },
    el("p", { className: "sheet-week-empty-title", textContent: "Nothing planned this week" }),
    el("p", { textContent: "Add a task to any day, or tell Claude what's coming up." }), go);
};

// Oura (oura-day.mjs): a past day's or today's "☾ 82 · ⚡ 86 · 7h 40m", a button that opens the
// day's numbers; nothing on future days or without a row.
// Today's also says a late nap ("late nap 5:10–6:20 pm") and "1 tip" when there is one.
weekParts.oura = (day, when) => {
  const chips = dayChips(state.sleepDays.find((r) => r.day === day));
  if (!chips.length) return null;
  const today = day === state.today;
  const nap = today ? lateNap(state.sleep, day, SHEET.timeZone) : null;
  const tips = today ? pickTips(state.sleepDays, day).length : 0;
  const extra = [nap, tips ? plural(tips, "tip") : null].filter(Boolean);
  const kids = chips.flatMap((c, i) => [
    i ? el("span", { className: "sheet-oura-sep", textContent: "·" }) : null,
    c.icon ? icon(c.icon) : null,
    el("span", { className: c.band ? `is-${c.band}` : "", textContent: c.text }),
  ]);
  if (extra.length) kids.push(el("span", { className: "sheet-oura-note", textContent: extra.join(" · ") }));
  const label = `${chipsLabel(chips, when).replace(/\. Open details$/, "")}${extra.length ? `; ${extra.join("; ")}` : ""}. Open details`;
  const button = el("button", { type: "button", className: "sheet-oura", ariaLabel: label }, ...kids);
  button.dataset.act = "oura-day";
  button.dataset.day = day;
  return button;
};

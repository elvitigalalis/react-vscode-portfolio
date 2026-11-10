// Student load on screen (docs/sheet-glance.md, "School load"): above the week, one bar of the
// week's school hours due against its free hours, which opens to the items with a one-tap
// estimate for each that has none; and "Crunch week" on the week title when the work won't fit.
// Loaded after sign-in (plan/index.astro), so /plan's first load carries none of it; its styles
// come with it as text (Vite's ?inline, as lookback-view.mjs does).
import css from "../styles/school-load.css?inline";
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { formatMinutes, localNow, weekDays, weekdayName } from "./logic.mjs";
import { el, state, render, renderHooks, eventsOn, dayStart, shutdownAt, workloadCap, offerUndo, failed } from "./planner.mjs";
import { freeOn, weekLoad, QUICK_EST } from "./school-load.mjs";

// Free minutes on each day of the week on screen, from the day's start (now, on today) to its
// shutdown line, less his busy events and fixed-time tasks, at most the workload cap
// (school-load.mjs, freeOn).
function freeByDay(days, today, nowMin) {
  const tasks = [...state.tasks.values()];
  return Object.fromEntries(days.filter((d) => d >= today).map((d) => {
    const from = Math.max(dayStart(d), d === today ? nowMin : 0);
    return [d, freeOn(eventsOn(d), tasks.filter((t) => t.day === d), from, shutdownAt(d), workloadCap())];
  }));
}

// Sets an estimate at once and saves it behind; a failed save puts the old one back.
async function setEstimate(id, est_min) {
  const t = state.tasks.get(id);
  if (!t) return;
  const before = t.est_min;
  state.tasks.set(id, { ...t, est_min });
  render();
  try {
    state.tasks.set(id, await api.updateTask(id, { est_min }));
    offerUndo(`Estimate ${formatMinutes(est_min)}.`, async () => { state.tasks.set(id, await api.updateTask(id, { est_min: before })); });
  } catch (err) {
    const now = state.tasks.get(id);
    if (now) state.tasks.set(id, { ...now, est_min: before });
    failed(err, `save the estimate for "${t.title}"`, () => setEstimate(id, est_min));
    render();
  }
}

function itemRow({ task, due, minutes, guess }) {
  const when = el("span", { className: "sheet-school-due", textContent: due < state.today ? "overdue" : weekdayName(due) });
  const est = guess
    ? el("span", { className: "sheet-school-est is-guess", title: "A guess from the title. Pick one to set it.", textContent: `~${formatMinutes(minutes)}` })
    : el("span", { className: "sheet-school-est", textContent: formatMinutes(minutes) });
  const li = el("li", { className: "sheet-school-item" }, when, el("span", { className: "sheet-school-title", textContent: task.title }), est);
  li.dataset.id = task.id;
  if (guess) {
    li.append(el("span", { className: "sheet-school-picks", role: "group", ariaLabel: `Estimate for ${task.title}` },
      ...QUICK_EST.map((m) => {
        const b = el("button", { type: "button", className: "sheet-school-pick", textContent: formatMinutes(m), ariaLabel: `${formatMinutes(m)} for ${task.title}` });
        b.dataset.est = String(m);
        return b;
      })));
  }
  return li;
}

export function setupSchoolLoad(root) {
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
  // One section that render() doesn't own, so whether it is open survives a redraw.
  const box = el("details", { className: "sheet-school", hidden: true });
  box.dataset.school = "";
  root.querySelector("[data-week]").before(box);

  box.addEventListener("click", (e) => {
    const b = e.target.closest(".sheet-school-pick");
    if (!b) return;
    const li = b.closest("[data-id]");
    // Focus goes on to the next item still to estimate, else back to the summary.
    const next = [...box.querySelectorAll(".sheet-school-item")].slice([...box.querySelectorAll(".sheet-school-item")].indexOf(li) + 1)
      .find((x) => x.querySelector(".sheet-school-pick"))?.dataset.id;
    setEstimate(li.dataset.id, Number(b.dataset.est)).catch(failed);
    (next ? box.querySelector(`[data-id="${CSS.escape(next)}"] .sheet-school-pick`) : box.querySelector("summary"))?.focus();
  });

  renderHooks.push(() => {
    const local = localNow(new Date(), SHEET.timeZone);
    const days = weekDays(state.week);
    const w = weekLoad([...state.tasks.values()], days, local.day, freeByDay(days, local.day, local.minutes));
    const title = root.querySelector("[data-week-title]");
    title.querySelector(".sheet-crunch")?.remove();
    if (!w || !w.items.length) { box.hidden = true; box.replaceChildren(); return; }
    if (w.crunch) title.append(el("span", { className: "sheet-crunch", textContent: " · Crunch week" }));

    const fill = el("span", { className: `sheet-meter-fill is-${w.level}` });
    fill.style.width = `${w.pct}%`;
    const words = `${formatMinutes(w.need)} due · ${formatMinutes(w.free)} free${w.crunch ? ` · ${formatMinutes(w.short)} short` : ""}`;
    const summary = el("summary", { className: "sheet-school-sum" },
      el("span", { className: "sheet-school-label", textContent: "School this week" }),
      el("span", { className: `sheet-load-chip is-${w.level}`, textContent: words }),
      // The title carries "Crunch week" for screen readers; phones hide the title, so it shows here.
      w.crunch ? el("span", { className: "sheet-school-crunch", ariaHidden: "true", textContent: "Crunch week" }) : null,
      el("span", { className: "sheet-meter", ariaHidden: "true" }, fill));
    summary.title = `${formatMinutes(w.need)} of school work due by Sunday against ${formatMinutes(w.free)} free around your calendar and fixed-time tasks, from now to each day's shutdown.`;
    const note = w.guessed
      ? `${w.guessed === 1 ? "1 item has" : `${w.guessed} items have`} no estimate; ~ marks a guess from the title. One tap sets it.`
      : "Every item has an estimate.";
    box.replaceChildren(summary, el("p", { className: "sheet-school-note", textContent: note }),
      el("ul", { className: "sheet-school-list" }, ...w.items.map(itemRow)));
    box.hidden = false;
  });
  // The hook may go on after the first draw (this module loads beside the first load).
  if (state.settings) render();
}

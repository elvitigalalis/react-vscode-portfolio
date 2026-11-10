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
import { courseCodes, freeOn, weekLoad, QUICK_EST } from "./school-load.mjs";

// Free minutes on each day of the week on screen, from the day's start (now, on today) to its
// shutdown line, less his busy events and fixed-time tasks, at most the workload cap, less the
// day's other planned work (school-load.mjs, freeOn).
function freeByDay(days, today, nowMin, codes) {
  const tasks = [...state.tasks.values()];
  return Object.fromEntries(days.filter((d) => d >= today).map((d) => {
    const from = Math.max(dayStart(d), d === today ? nowMin : 0);
    return [d, freeOn(eventsOn(d), tasks.filter((t) => t.day === d), from, shutdownAt(d), workloadCap(), codes)];
  }));
}

// Saves an estimate and keeps the stored row. Throws on failure, so failed()'s Retry can say so.
async function saveEstimate(id, est_min) {
  state.tasks.set(id, await api.updateTask(id, { est_min }));
}

// The items with a save in flight: a tap on one of them waits for it (ignored), so two quick
// taps never race two PATCHes.
const saving = new Map();

// Sets an estimate at once and saves it behind. Undo is offered at once too: it waits for the
// save in flight, then puts the old estimate back. A failed save puts the old one back and offers
// Retry (saveEstimate itself, which throws again if it fails again).
async function setEstimate(id, est_min) {
  const t = state.tasks.get(id);
  if (!t || saving.has(id)) return;
  const before = t.est_min;
  state.tasks.set(id, { ...t, est_min });
  render();
  const save = saveEstimate(id, est_min);
  saving.set(id, save);
  offerUndo(`Estimate ${formatMinutes(est_min)}.`, async () => { await save.catch(() => {}); await saveEstimate(id, before); });
  try {
    await save;
  } catch (err) {
    const now = state.tasks.get(id);
    if (now) state.tasks.set(id, { ...now, est_min: before });
    failed(err, `save the estimate for "${t.title}"`, () => saveEstimate(id, est_min));
    render();
  } finally {
    saving.delete(id);
  }
}

function itemRow({ task, due, minutes, guess }) {
  const when = el("span", { className: "sheet-school-due", textContent: due < state.today ? "overdue" : weekdayName(due) });
  // A guess reads "about 2h" to a screen reader; the eye gets "~2h".
  const est = guess
    ? el("span", { className: "sheet-school-est is-guess", title: "A guess from the title. Pick one to set it." },
      el("span", { className: "visually-hidden", textContent: "about " }), el("span", { ariaHidden: "true", textContent: "~" }), formatMinutes(minutes))
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
  // One section that render() doesn't own, so whether it is open survives a redraw. Its summary,
  // note and list are made once and updated in place, so a redraw never drops the focus on the
  // summary or makes a screen reader read it as new.
  const fill = el("span", { className: "sheet-meter-fill" });
  const chip = el("span", { className: "sheet-load-chip" });
  // The title carries "Crunch week" for screen readers; phones hide the title, so it shows here.
  const crunch = el("span", { className: "sheet-school-crunch", ariaHidden: "true", textContent: "Crunch week", hidden: true });
  const summary = el("summary", { className: "sheet-school-sum" },
    el("span", { className: "sheet-school-label", textContent: "School this week" }), chip, crunch,
    el("span", { className: "sheet-meter", ariaHidden: "true" }, fill));
  const note = el("p", { className: "sheet-school-note" });
  const list = el("ul", { className: "sheet-school-list" });
  const box = el("details", { className: "sheet-school", hidden: true }, summary, note, list);
  box.dataset.school = "";
  root.querySelector("[data-week]").before(box);

  box.addEventListener("click", (e) => {
    const b = e.target.closest(".sheet-school-pick");
    if (!b) return;
    const li = b.closest("[data-id]");
    // Focus goes on to the next item still to estimate, else back to the summary.
    const next = [...box.querySelectorAll(".sheet-school-item")].slice([...box.querySelectorAll(".sheet-school-item")].indexOf(li) + 1)
      .find((x) => x.querySelector(".sheet-school-pick"))?.dataset.id;
    setEstimate(li.dataset.id, Number(b.dataset.est));
    (next ? box.querySelector(`[data-id="${CSS.escape(next)}"] .sheet-school-pick`) : box.querySelector("summary"))?.focus();
  });

  function draw() {
    const local = localNow(new Date(), SHEET.timeZone);
    const days = weekDays(state.week);
    const tasks = [...state.tasks.values()];
    const codes = courseCodes(tasks);
    const w = weekLoad(tasks, days, local.day, freeByDay(days, local.day, local.minutes, codes), codes);
    const title = root.querySelector("[data-week-title]");
    title.querySelector(".sheet-crunch")?.remove();
    if (!w || !w.items.length) { box.hidden = true; list.replaceChildren(); return; }
    if (w.crunch) title.append(el("span", { className: "sheet-crunch", textContent: " · Crunch week" }));

    fill.className = `sheet-meter-fill is-${w.level}`;
    fill.style.width = `${w.pct}%`;
    chip.className = `sheet-load-chip is-${w.level}`;
    chip.textContent = `${formatMinutes(w.need)} due · ${formatMinutes(w.free)} free${w.crunch ? ` · ${formatMinutes(w.short)} short` : ""}`;
    crunch.hidden = !w.crunch;
    summary.title = `${formatMinutes(w.need)} of school work due by Sunday against ${formatMinutes(w.free)} free around your calendar, fixed-time tasks and other planned work, from now to each day's shutdown.`;
    note.textContent = w.guessed
      ? `${w.guessed === 1 ? "1 item has" : `${w.guessed} items have`} no estimate; ~ marks a guess from the title. One tap sets it.`
      : "Every item has an estimate.";
    // The list is drawn new; a focused pick or item gets its focus back on the new one.
    const had = list.contains(document.activeElement) ? document.activeElement : null;
    const at = had && { id: had.closest("[data-id]")?.dataset.id, est: had.dataset?.est };
    list.replaceChildren(...w.items.map(itemRow));
    if (at?.id) {
      const item = list.querySelector(`[data-id="${CSS.escape(at.id)}"]`);
      (item?.querySelector(at.est ? `.sheet-school-pick[data-est="${at.est}"]` : ".sheet-school-pick") ?? summary).focus();
    }
    box.hidden = false;
  }
  // A fault here must not stop the hooks after it or the week: the bar hides instead.
  renderHooks.push(() => {
    try { draw(); } catch (err) { console.error(err); box.hidden = true; }
  });
  // The hook may go on after the first draw (this module loads beside the first load).
  if (state.settings) render();
}

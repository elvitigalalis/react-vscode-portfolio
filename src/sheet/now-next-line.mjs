// The Now/Next line on /plan (research U18): one quiet line in today's stamps row, "Now: OS homework
// until 3:30 pm · Next: Gym 5:30 pm", from the rows already loaded, with ✓ for what's running. It
// redraws with the week and each minute. Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import { formatClock, localNow } from "./logic.mjs";
import { nowNext, rowTitle } from "./now-next.mjs";
import { actHooks, el, icon, render, renderHooks, rowsOn, state, toggleDone, toggleEventTodo } from "./planner.mjs";

function draw(root) {
  root.querySelector(".sheet-nownext")?.remove();
  const stamps = root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-stamps-row`);
  if (!stamps) return;
  const { minutes } = localNow(new Date(), SHEET.timeZone);
  const { now, next } = nowNext(rowsOn(state.today), minutes);
  if (!now && !next) return;
  const line = el("p", { className: "sheet-nownext" });
  if (now) {
    const title = rowTitle(now);
    const done = el("button", { type: "button", className: "sheet-nownext-done", ariaLabel: `Complete ${title}` }, icon("check"));
    done.dataset.act = "now-done";
    if (now.kind === "task") done.dataset.task = now.task.id;
    else done.dataset.key = now.key;
    line.append(el("span", { className: "sheet-nownext-part", title: title }, el("b", { textContent: "Now: " }), `${title} until ${formatClock(now.end)}`), done);
  }
  if (next) line.append(el("span", { className: "sheet-nownext-part", title: rowTitle(next) }, el("b", { textContent: "Next: " }), `${rowTitle(next)} ${formatClock(next.start)}`));
  stamps.prepend(line);
}

export function setupNowNext(root) {
  renderHooks.push(() => draw(root));
  setInterval(() => { if (state.week) draw(root); }, 60_000);
  actHooks["now-done"] = (e) => {
    const b = e.target.closest("[data-act]");
    return b.dataset.key ? toggleEventTodo(b) : toggleDone(b.dataset.task).then(render);
  };
}

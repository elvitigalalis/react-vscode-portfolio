// Draws the public week on /now: one column per day, public tasks by title, private ones as
// black bars. Text goes in through textContent only.
import { barWidth, byPosition, dayLabel, rowCount } from "./logic.mjs";

const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null));
  return node;
};

function taskRow(t, writeups) {
  if (!t.public) {
    const bar = el("span", { className: "sheet-bar" });
    bar.style.width = `${barWidth(t.bar)}ch`;
    bar.setAttribute("aria-hidden", "true");
    return el("li", { className: `sheet-row${t.done ? " is-done" : ""}` }, bar, el("span", { className: "visually-hidden", textContent: t.done ? "Private task, done" : "Private task" }));
  }
  const text = t.done && writeups.has(t.tag)
    ? el("a", { href: `/projects/${t.tag}/`, textContent: t.title })
    : el("span", { textContent: t.title, title: t.title });
  const li = el("li", { className: `sheet-row${t.done ? " is-done" : ""}` }, text);
  if (t.done) li.append(el("span", { className: "visually-hidden", textContent: " (done)" }));
  return li;
}

// When the week scrolls sideways (tablets), start at today.
export function scrollToToday(week) {
  const today = week.querySelector(".is-today");
  if (today && week.scrollWidth > week.clientWidth) week.scrollLeft = today.offsetLeft - week.offsetLeft;
}

export function renderPublicWeek(root, { days, today, tasks, stamps, writeups }) {
  const byDay = Object.fromEntries(days.map((d) => [d, tasks.filter((t) => t.day === d).sort(byPosition)]));
  const rows = rowCount(byDay);
  const stampOf = Object.fromEntries(stamps.map((s) => [s.day, s]));
  root.replaceChildren(...days.map((day) => {
    const { weekday, date } = dayLabel(day);
    const list = byDay[day];
    const allDone = day === today && list.length > 0 && list.every((t) => t.done);
    const s = stampOf[day];
    const marks = [s?.planned && "Planned ✓", s?.shutdown && "Shut down ✓"].filter(Boolean).join(" · ");
    const ul = el("ul", { className: "sheet-rows" }, ...list.map((t) => taskRow(t, writeups)));
    for (let i = list.length; i < rows; i++) ul.append(el("li", { className: "sheet-row is-empty" }));
    return el("section", { className: `sheet-day${day === today ? " is-today" : ""}` },
      el("h2", { className: "sheet-head" },
        el("span", { className: "sheet-wd", textContent: weekday }), " ",
        el("span", { className: "sheet-dt", textContent: date }),
        allDone ? el("span", { className: "sheet-alldone", textContent: " ✓", title: "Everything done today" }) : null,
        day === today ? el("span", { className: "visually-hidden", textContent: " (today)" }) : null),
      el("p", { className: "sheet-stamps", textContent: marks }),
      ul);
  }));
}

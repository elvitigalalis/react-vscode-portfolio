// A day's Oura numbers in a dialog (docs/sheet-v5.md, "Day numbers"), opened from the chips in a
// day's header. planner.mjs imports it on the first tap, so /plan's first-load script stays
// small. The dialog closes on Close, Escape and a backdrop click (dismiss.mjs, wired for every
// dialog on /plan). Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import { dayLabel } from "./logic.mjs";
import { dayMetrics, sparkPath } from "./oura-day.mjs";
import { el, state } from "./planner.mjs";

const SVG = "http://www.w3.org/2000/svg";

function spark(values) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "sheet-spark");
  svg.setAttribute("viewBox", "0 0 48 14");
  svg.setAttribute("aria-hidden", "true");
  const d = values ? sparkPath(values) : "";
  if (d) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

export function openOuraDay(root, day) {
  const dialog = root.querySelector("[data-oura-day]");
  const { weekday, date } = dayLabel(day);
  dialog.querySelector("h2").textContent = `Oura · ${weekday} ${date}`;
  const rows = dayMetrics(day, state.sleepDays, state.sleep, SHEET.timeZone).flatMap((m) => [
    el("dt", { textContent: m.label }),
    el("dd", { className: m.band ? `is-${m.band}` : "", textContent: m.value, ariaLabel: m.aria }),
    el("dd", { ariaHidden: "true" }, spark(m.spark)),
  ]);
  dialog.querySelector("[data-oura-list]").replaceChildren(...rows);
  dialog.showModal();
}

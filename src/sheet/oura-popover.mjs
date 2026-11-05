// A day's Oura numbers in a dialog (docs/sheet-v5.md, "Day numbers"), opened from the chips in a
// day's header. planner.mjs imports it on the first tap, so /plan's first-load script stays
// small. The dialog closes on Close, Escape and a backdrop click (dismiss.mjs, wired for every
// dialog on /plan). Text goes in through textContent only.
import { SHEET } from "../site.mjs";
import { dayLabel } from "./logic.mjs";
import { dayMetrics, sleepStrip, sparkPath, spreadLine, stripLayout } from "./oura-day.mjs";
import { bedtimeFor, tonight } from "./bedtime.mjs";
import { pickTips, tipContext } from "./tips.mjs";
import { GYM_HABIT } from "./ring.mjs";
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

const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

// The week's bedtime and wake bars against the target bedtime (oura-day.mjs, stripLayout), with
// the hour ticks; described in words by its label and the spread line under it.
function strip(day, target) {
  const s = sleepStrip(state.sleep, day, SHEET.timeZone);
  const l = stripLayout(s, target);
  const box = svgEl("svg", { class: "sheet-sleepweek", viewBox: "0 0 280 100", role: "img" });
  box.setAttribute("aria-label", l ? `Bedtime and wake, the 7 nights to ${dayLabel(day).weekday} ${dayLabel(day).date}${target != null ? ", against your bedtime target" : ""}` : "No nights synced this week");
  if (!l) return { box, spread: "A few more nights to show your week." };
  for (const r of l.rows) {
    box.append(Object.assign(svgEl("text", { x: 0, y: r.y + 9, class: "sheet-sleepweek-day" }), { textContent: r.label }));
    if (r.x1 != null) box.append(svgEl("rect", { x: r.x1, y: r.y + 2, width: Math.max(2, r.x2 - r.x1), height: 8, rx: 4, class: "sheet-sleepweek-bar" }));
  }
  for (const t of l.ticks) box.append(Object.assign(svgEl("text", { x: t.x, y: 98, class: "sheet-sleepweek-tick", "text-anchor": "middle" }), { textContent: t.label }));
  if (l.target != null) box.append(svgEl("line", { x1: l.target, x2: l.target, y1: 0, y2: 86, class: "sheet-sleepweek-target" }));
  return { box, spread: spreadLine(s.spread) ?? "" };
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
  // Tips (tips.mjs): 1-2 for the day's lowest contributors, under the score they help, each with
  // its Oura source as a small "why" link.
  const tz = SHEET.timeZone;
  const bed = bedtimeFor(day, { settings: state.settings, sleep: state.sleep, sleepTimes: state.sleepTimes, tz });
  const gym = (state.habits ?? []).find((h) => GYM_HABIT.test(h.name ?? ""));
  const tips = pickTips(state.sleepDays, day, tipContext(bed, gym?.ideal ?? null));
  dialog.querySelector("[data-oura-tips]").hidden = !tips.length;
  dialog.querySelector("[data-oura-tip-list]").replaceChildren(...tips.map((t) => el("li", {},
    el("span", { className: "sheet-oura-tip-for", textContent: `${t.score === "sleep" ? "Sleep" : "Readiness"} · ${t.label} ${t.value}` }), " ",
    t.text, " ", el("a", { href: t.source, className: "sheet-link small", textContent: "why", target: "_blank", rel: "noopener", ariaLabel: `Why: Oura on ${t.label}` }))));
  const target = bedtimeFor(tonight(new Date(), tz), { settings: { ...state.settings, bedtime_ease: false }, sleep: [], sleepTimes: state.sleepTimes, tz })?.minutes ?? null;
  const { box, spread } = strip(day, target);
  dialog.querySelector("[data-oura-strip]").replaceChildren(box);
  dialog.querySelector("[data-oura-spread]").textContent = spread;
  dialog.showModal();
}

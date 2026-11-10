// Readiness note (docs/sheet.md, "Readiness note"): on a day Oura's readiness is low, today shows
// one calm line, "Readiness 64 today · consider a lighter day · Push some to tomorrow · Dismiss".
// A fixed threshold and a fixed sentence, worked out here in the browser from today's sleep_days
// row. Oura data never reaches Claude (docs/adr/0005): nothing on the server or on an AI path
// imports this module, and test/readiness-note.test.mjs checks that.
import { el, state, render, renderHooks, shutdownAt } from "./planner.mjs";
import { calmReady, movePicker } from "./plan-today.mjs";
import { zonedIso } from "./logic.mjs";
import { SHEET } from "../site.mjs";

// Under 70 is below Oura's "good" band (ouraring.com/blog/readiness-score), the same line
// sleep.mjs's dayCap uses for a lighter day.
export const LOW_READINESS = 70;

// Today's readiness when it is low, else null.
export function lowReadiness(sleepDays, day) {
  const r = sleepDays.find((x) => x.day === day)?.readiness;
  return Number.isInteger(r) && r < LOW_READINESS ? r : null;
}

export const readinessLine = (r) => `Readiness ${r} today · consider a lighter day`;

// Dismissing it hides it for the rest of that day, in this browser.
const KEY = "sheet.readiness-dismissed";
// Reading localStorage itself throws when storage is blocked, so it is read inside the try.
export const dismissedOn = (day, store) => { try { return (store ?? globalThis.localStorage).getItem(KEY) === day; } catch { return false; } };
export const dismiss = (day, store) => { try { (store ?? globalThis.localStorage).setItem(KEY, day); } catch {} };

let open = false;
let gone = null; // the day dismissed, if storage is unavailable

function note(d) {
  const r = lowReadiness(state.sleepDays, d);
  if (r == null || gone === d || dismissedOn(d) || state.days[d]?.shutdown) return null;
  if (Date.now() >= Date.parse(zonedIso(d, shutdownAt(d), SHEET.timeZone))) return null;
  if (!calmReady()) return null;
  const line = el("p", { className: "sheet-over" }, `${readinessLine(r)} · `);
  // When the over-commit note already offers the same list, this line doesn't repeat it.
  if (!document.querySelector('[data-over="week"]')) {
    const push = el("button", { type: "button", className: "sheet-link", textContent: "Push some to tomorrow" });
    push.setAttribute("aria-expanded", String(open));
    push.onclick = () => { open = !open; render(); document.querySelector('[data-over="ready"] .sheet-link')?.focus(); };
    line.append(push, " · ");
  } else open = false;
  const x = el("button", { type: "button", className: "sheet-link", textContent: "Dismiss", ariaLabel: "Dismiss readiness note" });
  x.onclick = () => {
    gone = d; dismiss(d); open = false; render();
    const head = document.querySelector(".sheet-day.is-today .sheet-head");
    head?.setAttribute("tabindex", "-1");
    head?.focus();
  };
  line.append(x);
  const out = open ? el("div", { className: "sheet-over-wrap" }, line, movePicker(d, "ready")) : line;
  out.dataset.over = "ready";
  return out;
}

export function setupReadinessNote(root) {
  renderHooks.push(() => {
    const n = note(state.today);
    if (!n) open = false;
    else root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-stamps-row`)?.append(n);
  });
}

// Shutdown (docs/sheet.md): the Shut down button, `O`, and Telegram's ?open=shutdown. The dialog
// itself is shutdown-view.mjs, loaded on demand. To open it at once, its code and its reads are
// warmed ahead: when the button shows (at idle), and on hover, focus or a press of the button.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { localNow, weekDays } from "./logic.mjs";
import { state, keyHooks, actHooks, renderHooks, failed, render } from "./planner.mjs";
import { shutdownAt } from "./plan-today.mjs";
// shutdown-close.mjs's shutdownDay is habitDay; imported straight from habit-rate.mjs so the
// first load doesn't carry the rest of shutdown-close.mjs.
import { habitDay as shutdownDay } from "./habit-rate.mjs";

let root;
let view = null;
let warmedOn = null; // the day the idle warm-up ran
// Whether a day off the week on screen is shut down (state.days holds only that week): read once
// per day, and set when Shutdown closes one.
const outside = new Map();

// Before 4 am Shutdown is for the day before (shutdown-close.mjs, shutdownDay).
const today = () => shutdownDay(new Date(), SHEET.timeZone);
const closedOn = (day) => Boolean(state.days[day]?.shutdown) || outside.get(day) === true;
const loadView = () => (view ??= import("./shutdown-view.mjs").then((m) => { m.setupView(root, { closed: (day) => outside.set(day, true) }); return m; }, (e) => { view = null; throw e; }));
const warm = () => loadView().then((m) => m.prefetch(today())).catch(console.error);
// Not before settings has answered, nor for an account that can't open the planner (no settings).
const open = () => (state.settings ? loadView().then((m) => m.open(today()), failed) : null);
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1500));

export function setupShutdown(node) {
  root = node;
  actHooks.shutdown = open;
  keyHooks.push((e) => { if (e.key === "o" || e.key === "O") { open(); return true; } return false; });
  const button = root.querySelector('[data-act="shutdown"]');
  for (const type of ["pointerenter", "focus", "pointerdown"]) button.addEventListener(type, warm, { passive: true });
  // The button shows from two hours before shutdown until the day is shut down; after midnight
  // (before 4 am) it stays up for the day before until that is shut down.
  renderHooks.push(() => {
    const now = localNow(new Date(), SHEET.timeZone);
    const day = today();
    if (state.week && !weekDays(state.week).includes(day) && !outside.has(day)) {
      outside.set(day, null);
      api.rest(`days?select=day,shutdown&day=eq.${day}`).then((rows) => { outside.set(day, Boolean(rows[0]?.shutdown)); render(); }, console.error);
    }
    button.hidden = closedOn(day) || (day === now.day && now.minutes < shutdownAt(day) - 120);
    if (!button.hidden && warmedOn !== day) { warmedOn = day; idle(warm); }
  });
}

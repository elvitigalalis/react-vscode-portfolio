// Shutdown (docs/sheet.md): the Shut down button, `O`, and Telegram's ?open=shutdown. The dialog
// itself is shutdown-view.mjs, loaded on demand. To open it at once, its code and its reads are
// warmed ahead: when the button shows (at idle), and on hover, focus or a press of the button.
import { SHEET } from "../site.mjs";
import { localNow } from "./logic.mjs";
import { state, keyHooks, actHooks, renderHooks, failed } from "./planner.mjs";
import { shutdownAt } from "./plan-today.mjs";

let root;
let view = null;
let warmedOn = null; // the day the idle warm-up ran

const today = () => localNow(new Date(), SHEET.timeZone).day;
const loadView = () => (view ??= import("./shutdown-view.mjs").then((m) => { m.setupView(root); return m; }, (e) => { view = null; throw e; }));
const warm = () => loadView().then((m) => m.prefetch(today())).catch(console.error);
const open = () => loadView().then((m) => m.open(today()), failed);
const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 5000 }) : setTimeout(fn, 1500));

export function setupShutdown(node) {
  root = node;
  actHooks.shutdown = open;
  keyHooks.push((e) => { if (e.key === "o" || e.key === "O") { open(); return true; } return false; });
  const button = root.querySelector('[data-act="shutdown"]');
  for (const type of ["pointerenter", "focus", "pointerdown"]) button.addEventListener(type, warm, { passive: true });
  // The button shows from two hours before shutdown until the day is shut down.
  renderHooks.push(() => {
    const now = localNow(new Date(), SHEET.timeZone);
    button.hidden = Boolean(state.days[now.day]?.shutdown) || now.minutes < shutdownAt(now.day) - 120;
    if (!button.hidden && warmedOn !== now.day) { warmedOn = now.day; idle(warm); }
  });
}

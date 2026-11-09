// Swipes on /plan's phone layout (research U10, P12; the rules are in docs/sheet.md, "On the phone").
// Who takes a gesture is decided by axis and by where it starts:
// - Axis. CSS gives the day and Someday lists touch-action: pan-y, so the browser keeps every
//   vertical pan (it fires pointercancel, which ends us) and only sideways moves reach here.
//   https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action
// - Hold. Holding still for HOLD_MS picks a task up (planner.mjs). A finger that moved first drops
//   the hold; one that held first shows .is-held, and we step aside.
// - Start. An open row takes its own swipe (done, tomorrow). Anywhere else in the focused day (the
//   heading, Now/Next, an empty add row, a done row) steps the day, as the arrows do.
// Not from the left screen edge (Safari's back swipe), with a second finger or while zoomed in.
import { NARROW, state, taskAction, checkOff, toggleEventTodo } from "./planner.mjs";
import { dayStep, lockAxis, rowArmed, swipeActions } from "./swipe.mjs";

const EDGE = 24;
const calm = () => matchMedia("(prefers-reduced-motion: no-preference)").matches;

function begin(e) {
  const t = e.target;
  if (t.closest("dialog, .sheet-edit")) return null;
  const field = t.closest("input, textarea");
  if (field && (field.value || field === document.activeElement)) return null;
  const li = t.closest(":is(.sheet-day, .sheet-list) :is(.sheet-task, .sheet-evtodo)");
  if (li) {
    const actions = swipeActions({ kind: li.dataset.id ? "task" : "event", done: li.classList.contains("is-done"), day: li.closest("[data-day]")?.dataset.day ?? null, today: state.today });
    if (actions) return { li, actions };
  }
  const day = t.closest(".sheet-day.is-focus");
  return day ? { day } : null;
}

// Done plays the ✓ on the row (planner.mjs, checkOff); a move dims it until the redraw.
function run(li, act) {
  const id = li.dataset.id;
  if (!id) return toggleEventTodo(li);
  if (act === "done") return checkOff(id, { li });
  li.classList.add("is-leaving");
  return taskAction(id, act);
}

export function setupSwipe(root) {
  let g = null;
  let swipedAt = 0;
  const reset = () => {
    if (!g) return;
    g.li?.classList.remove("is-swiping", "is-armed", "is-swipe-left");
    g.day?.classList.remove("is-day-swiping");
    g = null;
  };
  root.addEventListener("pointerdown", (e) => {
    reset();
    if (e.pointerType !== "touch" || !e.isPrimary || e.clientX < EDGE || !matchMedia(NARROW).matches || (window.visualViewport?.scale ?? 1) > 1.01) return;
    const b = begin(e);
    if (b) g = { ...b, pointer: e.pointerId, x: e.clientX, y: e.clientY, axis: null };
  });
  document.addEventListener("pointermove", (e) => {
    if (!g || e.pointerId !== g.pointer) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.axis) {
      if (g.li?.matches(".is-held, .is-ghost")) return reset();
      g.axis = lockAxis(dx, dy);
      if (!g.axis) return;
      if (g.axis === "y") return reset();
    }
    g.dx = dx;
    g.dy = dy;
    if (g.day) {
      g.day.classList.add("is-day-swiping");
      g.day.style.setProperty("--swipe", `${dx * 0.6}px`);
      return;
    }
    const action = dx > 0 ? g.actions.right : g.actions.left;
    // A side with no action gives a little and no more.
    const shown = action ? dx : dx * 0.15;
    g.action = action && rowArmed(dx, g.li.clientWidth) ? action : null;
    g.li.classList.add("is-swiping");
    g.li.classList.toggle("is-swipe-left", dx < 0);
    g.li.classList.toggle("is-armed", Boolean(g.action));
    g.li.dataset.swipe = action?.label ?? "";
    g.li.style.setProperty("--swipe", `${shown}px`);
    g.li.style.setProperty("--swipe-w", `${Math.abs(shown)}px`);
  });
  document.addEventListener("pointerup", (e) => {
    if (!g || e.pointerId !== g.pointer) return;
    const { axis, li, day, action, dx = 0, dy = 0 } = g;
    reset();
    if (!axis) return;
    if (li && action) run(li, action.act);
    const step = day ? dayStep(dx, dy) : null;
    if (step) {
      root.querySelector(`[data-act="${step}"]`).click();
      if (calm()) root.querySelector(".sheet-day.is-focus")?.animate([{ transform: `translateX(${step === "next" ? 40 : -40}px)`, opacity: 0.4 }, { transform: "none", opacity: 1 }], { duration: 160, easing: "ease-out" });
    }
    swipedAt = Date.now();
  });
  document.addEventListener("pointercancel", reset);
  // A finger lifted over ✓ or a title after a swipe is not a tap.
  root.addEventListener("click", (e) => { if (Date.now() - swipedAt < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
}

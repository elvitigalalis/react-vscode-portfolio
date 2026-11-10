// Focus mode's full-screen view (docs/sheet-focus.md), loaded on the first Start: the task, the
// block's first step, a large countdown to the block's end with the time since Start, and Done,
// +15 min and Stuck. Leaving (Back to plan, or Escape) keeps the session; /plan shows Resume.
// No sound and no animation beyond the bar's one-second step, which reduced motion turns off.
import { SHEET } from "../site.mjs";
import { focusClock, focusActual, extendFocus, startSession, stuckMessage, EXTEND_MIN } from "./focus.mjs";
import { el, state, render, checkOff } from "./planner.mjs";

let io, dialog, parts, timer;

export function setupFocusView(deps) {
  io = deps;
  const button = (text, cls, onClick) => {
    const b = el("button", { type: "button", className: `sheet-btn ${cls}`.trim(), textContent: text });
    b.addEventListener("click", onClick);
    return b;
  };
  parts = {
    title: el("h2", { id: "sheet-focus-title", className: "sheet-focus-title" }),
    first: el("p", { className: "sheet-focus-first" }),
    left: el("p", { className: "sheet-focus-left", role: "timer" }),
    sub: el("p", { className: "sheet-focus-sub" }),
    fill: el("span", { className: "sheet-focus-fill" }),
    note: el("p", { className: "sheet-focus-note", role: "status" }),
    stuck: button("Stuck", "", stuck),
  };
  dialog = el("dialog", { className: "sheet-focus" },
    button("Back to plan", "sheet-focus-leave", () => dialog.close()),
    el("div", { className: "sheet-focus-body" },
      el("p", { className: "sheet-focus-kicker", textContent: "Focus" }),
      parts.title, parts.first, parts.left, parts.sub,
      el("span", { className: "sheet-focus-bar", ariaHidden: "true" }, parts.fill),
      el("div", { className: "sheet-focus-actions" },
        button("Done", "primary", done), button(`+${EXTEND_MIN} min`, "", extend), parts.stuck),
      parts.note));
  dialog.setAttribute("aria-labelledby", "sheet-focus-title");
  dialog.addEventListener("close", () => { clearInterval(timer); render(); });
  document.body.append(dialog);
}

// Opens the running session, or starts one on `blockId`. A session already running stays the one
// shown, so a stray deep link never throws away time counted.
export function open(blockId) {
  let s = io.getSession();
  if (!s) {
    const b = state.blocks.find((x) => x.id === blockId);
    if (!b || !state.tasks.get(b.task_id)) return;
    s = startSession(b, new Date());
    io.setSession(s);
  }
  const task = state.tasks.get(s.task_id);
  const b = state.blocks.find((x) => x.id === s.block_id);
  parts.title.textContent = task?.title ?? "Focus";
  parts.first.textContent = b?.first_step ? `First: ${b.first_step}` : "";
  parts.first.hidden = !b?.first_step;
  parts.note.textContent = "";
  parts.stuck.disabled = false;
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
  if (!dialog.open) dialog.showModal();
}

function tick() {
  const s = io.getSession();
  if (!s) return;
  const c = focusClock(s, new Date());
  parts.left.textContent = c.left;
  parts.left.setAttribute("aria-label", `${c.over ? `${c.left.slice(1)} past the block's end` : `${c.left} left`}`);
  parts.sub.textContent = c.over ? `past the block's end · ${c.elapsed} in` : `left · ${c.elapsed} in`;
  parts.fill.style.width = `${(c.share * 100).toFixed(2)}%`;
}

// Done: the minutes since Start into actuals, then the task done, in that order (the outbox).
// The task's row in the week plays its ✓ while the outbox saves (planner.mjs, checkOff).
function done() {
  const s = io.getSession();
  if (!s) return dialog.close();
  const task = state.tasks.get(s.task_id);
  const row = task ? focusActual(s, task, new Date(), SHEET.timeZone) : null;
  io.setSession(null);
  // Today's progress line counts the minutes at once; the next load reads what was saved.
  if (row) state.actuals.push({ day: row.d, minutes: row.minutes });
  dialog.close();
  const save = () => io.queue(...(row ? [{ op: "actual", row }] : []), { op: "done", task: s.task_id });
  if (task) checkOff(s.task_id, { save, focusMin: row?.minutes ?? null }).catch(console.error); else save();
}

// +15 min: the block's end moves when the time is free; the timer follows it.
function extend() {
  const s = io.getSession();
  if (!s) return;
  const b = state.blocks.find((x) => x.id === s.block_id) ?? null;
  const busy = state.events.filter((e) => e.busy && !e.allDay);
  const out = extendFocus(s, b, [...state.blocks, ...busy], SHEET.timeZone);
  if (out.why) { parts.note.textContent = `${out.why}.`; return; }
  io.setSession(out.session);
  if (out.ends_at) { b.ends_at = out.ends_at; io.queue({ op: "extend", block: b.id, ends_at: out.ends_at }); }
  parts.note.textContent = `+${EXTEND_MIN} min.`;
  tick();
}

// Stuck: a message to Claude through /plan's message box, so its smaller steps land as to-dos
// under Recent messages, each with Undo (message-box.mjs).
function stuck() {
  const s = io.getSession();
  const task = s && state.tasks.get(s.task_id);
  const form = document.querySelector("[data-message-form]");
  if (!task || !form || form.hidden) { parts.note.textContent = "Messages to Claude aren't available right now."; return; }
  const box = form.querySelector("textarea");
  box.value = stuckMessage(task, state.blocks.find((x) => x.id === s.block_id), state.today);
  box.dispatchEvent(new Event("input"));
  form.requestSubmit();
  parts.stuck.disabled = true;
  parts.note.textContent = "Asked Claude for 2-4 smaller steps. They'll show as to-dos under Recent messages to Claude, each with Undo.";
}

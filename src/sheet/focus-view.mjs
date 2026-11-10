// Focus mode's full-screen view (docs/sheet-focus.md), loaded on the first Start: the task, the
// block's first step, where he left off last time, a large countdown to the block's end with the
// time since Start, and Done, +15 min, Stuck and Stop. Leaving (Back to plan, or Escape) keeps
// the session; /plan shows Resume. Stop ends it without finishing the task: it asks where he left
// off, credits the minutes to the task, and the next Start shows both (focus-notes.mjs).
// No sound and no animation beyond the bar's one-second step, which reduced motion turns off.
import { SHEET } from "../site.mjs";
import { focusClock, focusActual, extendFocus, startSession, stuckMessage, EXTEND_MIN } from "./focus.mjs";
import { stopRow, doneRow, sessionMinutes, creditMinutes, NOTE_MAX } from "./focus-notes.mjs";
import { formatMinutes } from "./logic.mjs";
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
    resume: el("p", { className: "sheet-focus-resume" }),
    left: el("p", { className: "sheet-focus-left", role: "timer" }),
    sub: el("p", { className: "sheet-focus-sub" }),
    fill: el("span", { className: "sheet-focus-fill" }),
    note: el("p", { className: "sheet-focus-note", role: "status" }),
    stuck: button("Stuck", "", stuck),
    leftOff: el("input", { type: "text", id: "sheet-focus-leftoff", maxLength: NOTE_MAX, autocomplete: "off", placeholder: "Next: …" }),
    credit: el("input", { type: "number", id: "sheet-focus-credit", min: "0", max: "960", step: "1", inputMode: "numeric" }),
    creditWords: el("span", { className: "sheet-focus-credit-words" }),
  };
  parts.actions = el("div", { className: "sheet-focus-actions" },
    button("Done", "primary", done), button(`+${EXTEND_MIN} min`, "", extend), parts.stuck, parts.stopButton = button("Stop", "", askStop));
  // Stop's question, in place of the actions until he saves or keeps going. Enter saves.
  parts.stop = el("form", { className: "sheet-focus-stop", hidden: true },
    el("label", { htmlFor: "sheet-focus-leftoff", textContent: "Where did you leave off?" }),
    parts.leftOff,
    // The minutes to credit, held to the block's end; he can change them.
    el("p", { className: "sheet-focus-credit" },
      el("label", { htmlFor: "sheet-focus-credit", textContent: "Credit" }), parts.credit,
      el("span", { textContent: "min" }), parts.creditWords),
    el("div", { className: "sheet-focus-actions" },
      el("button", { type: "submit", className: "sheet-btn primary", textContent: "Save and stop" }),
      button("Keep going", "", () => keepGoing(true))));
  parts.stop.addEventListener("submit", (e) => { e.preventDefault(); stop(); });
  parts.credit.addEventListener("input", creditWords);
  dialog = el("dialog", { className: "sheet-focus" },
    button("Back to plan", "sheet-focus-leave", () => dialog.close()),
    el("div", { className: "sheet-focus-body" },
      el("p", { className: "sheet-focus-kicker", textContent: "Focus" }),
      parts.title, parts.first, parts.resume, parts.left, parts.sub,
      el("span", { className: "sheet-focus-bar", ariaHidden: "true" }, parts.fill),
      parts.actions, parts.stop,
      parts.note));
  dialog.setAttribute("aria-labelledby", "sheet-focus-title");
  dialog.addEventListener("close", () => { clearInterval(timer); render(); });
  // Escape while Stop's question is open goes back to the actions, keeping the view and session.
  dialog.addEventListener("cancel", (e) => {
    if (parts.stop.hidden) return;
    e.preventDefault();
    keepGoing(true);
  });
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
  // Where he left off last time, and what earlier sessions on it came to.
  const p = io.progressFor(s.task_id);
  parts.resume.replaceChildren(...(p?.note ? [el("strong", { textContent: "Where you left off: " }), p.note] : []));
  parts.resume.hidden = !p?.note;
  keepGoing();
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
  const prior = io.progressFor(s.task_id)?.minutes;
  const total = prior ? ` · ${formatMinutes(prior + Math.floor((Date.now() - s.started_at) / 60_000))} on this task` : "";
  parts.sub.textContent = `${c.over ? "past the block's end" : "left"} · ${c.elapsed} in${total}`;
  parts.fill.style.width = `${(c.share * 100).toFixed(2)}%`;
}

// Done: the minutes since Start into actuals, then the task done, in that order (the outbox).
// The task's row in the week plays its ✓ while the outbox saves (planner.mjs, checkOff).
function done() {
  const s = io.getSession();
  if (!s) return dialog.close();
  const task = state.tasks.get(s.task_id);
  const now = new Date();
  // With focus_log read, the task's open rows' credit goes into the actuals row and Done's
  // focus_log row closes exactly those. Unread (offline since load), neither: a closing row then
  // could hide credit this page never counted.
  const known = io.isLogLoaded();
  const earlier = known ? io.progressFor(s.task_id) : null;
  const row = task ? focusActual(s, task, now, SHEET.timeZone, earlier?.minutes ?? 0) : null;
  const closing = known ? doneRow(s, now, SHEET.timeZone, crypto.randomUUID(), earlier?.ids ?? []) : null;
  if (closing) io.addLog(closing);
  io.setSession(null);
  // Today's progress line counts this session's minutes at once (not the earlier credit in
  // `row`); the next load reads what was saved.
  if (row) state.actuals.push({ day: row.d, minutes: sessionMinutes(s, now) });
  dialog.close();
  const save = () => io.queue(...(row ? [{ op: "actual", row }] : []), ...(closing ? [{ op: "log", row: closing }] : []), { op: "done", task: s.task_id });
  // The early check (celebrate.mjs) weighs the whole time the task took against its estimate.
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

// Stop: ask where he left off, in place of the actions.
function askStop() {
  parts.actions.hidden = true;
  parts.stop.hidden = false;
  parts.leftOff.value = "";
  const s = io.getSession();
  parts.credit.value = s ? String(creditMinutes(s, new Date())) : "0";
  creditWords();
  parts.leftOff.focus();
}
// "(2h10)" beside the minutes, from an hour on.
function creditWords() {
  const m = Math.round(Number(parts.credit.value));
  parts.creditWords.textContent = Number.isFinite(m) && m >= 60 ? `(${formatMinutes(Math.min(m, 960))})` : "";
}
// Back to the actions; from Keep going or Escape, with focus on Stop again.
function keepGoing(refocus = false) {
  parts.stop.hidden = true;
  parts.actions.hidden = false;
  if (refocus) parts.stopButton.focus();
}

// Save and stop: the minutes and the note go to focus_log (credited to the task, shown at its next
// Start), the session ends and the task stays open. A blank note still credits the minutes.
function stop() {
  const s = io.getSession();
  if (!s) return dialog.close();
  const row = stopRow(s, parts.leftOff.value, new Date(), SHEET.timeZone, crypto.randomUUID(), parts.credit.value);
  io.setSession(null);
  if (row) { io.addLog(row); io.queue({ op: "log", row }); }
  dialog.close();
}

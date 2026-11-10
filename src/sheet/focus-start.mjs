// Focus mode (docs/sheet-focus.md), the part /plan loads at once: the Start (or Resume) button on
// today's current or next block, the ?focus=<block id> deep link, the session and outbox kept in
// this browser, and the retried writes. The full-screen view is focus-view.mjs, loaded on first
// Start. Logic is in focus.mjs.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { focusTarget, readSession, readOutbox, drainOutbox, focusClock, outboxAfter, serialDrain } from "./focus.mjs";
import { progressByTask, progressText, closeFinished } from "./focus-notes.mjs";
import { addDays } from "./logic.mjs";
import { el, state, render, renderHooks, actHooks, completeTask } from "./planner.mjs";
import { saveBlock } from "./plan-today.mjs";

const SESSION_KEY = "sheet.focus";
const OUTBOX_KEY = "sheet.focus.outbox";

// Storage can be off (a private window); focus then lasts as long as the page.
let memory = { [SESSION_KEY]: null, [OUTBOX_KEY]: null };
const get = (k) => { try { return localStorage.getItem(k); } catch { return memory[k]; } };
const put = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { memory[k] = v; } };

export const getSession = () => readSession(get(SESSION_KEY));
export const setSession = (s) => put(SESSION_KEY, s ? JSON.stringify(s) : null);

let root, note;

// focus_log's rows (focus-notes.mjs) from the last LOG_DAYS, read after the first draw and read
// again on each sync until a read lands (logLoaded). A row Stop or Done adds goes in here at once,
// so the credit shows before it saves. Until the read lands, Done counts no earlier credit and
// closes nothing, since it can't know which rows there are.
const LOG_DAYS = 120;
let logRows = [];
let progress = new Map();
let logLoaded = false;
let reading = null;
export const progressFor = (taskId) => progress.get(taskId) ?? null;
export const isLogLoaded = () => logLoaded;
export function addLog(row) {
  logRows = [...logRows, row];
  progress = progressByTask(logRows);
}
function readLog() {
  if (logLoaded || reading) return;
  reading = api.listFocusLog(addDays(state.today, -LOG_DAYS)).then((rows) => {
    // Rows added here while the read was out are kept, once each.
    const seen = new Set(rows.map((r) => r.id));
    logRows = [...rows, ...logRows.filter((r) => !seen.has(r.id))];
    progress = progressByTask(logRows);
    logLoaded = true;
    render();
  }, console.error).finally(() => { reading = null; });
}

// One write, as Done or +15 min queued it. Each can run again safely: record_focus counts a task
// once, done stays done, and an end is set, not added to.
async function run(op) {
  if (op.op === "actual") return api.recordFocus(op.row);
  if (op.op === "log") return api.logFocus(op.row);
  if (op.op === "done") {
    if (state.tasks.has(op.task)) { if (!state.tasks.get(op.task).done) await completeTask(op.task); return; }
    return api.updateTask(op.task, { done: true });
  }
  if (op.op === "extend") {
    const b = state.blocks.find((x) => x.id === op.block);
    return b ? saveBlock(b, { ends_at: op.ends_at }) : api.updateBlock(op.block, { ends_at: op.ends_at });
  }
}

// Ops queued while a drain runs stay in the outbox (outboxAfter) for the next one.
const drain = serialDrain(async () => {
  const taken = readOutbox(get(OUTBOX_KEY));
  const left = outboxAfter(taken, await drainOutbox(taken, run), readOutbox(get(OUTBOX_KEY)));
  put(OUTBOX_KEY, left.length ? JSON.stringify(left) : null);
  note.hidden = !left.length;
  render();
});
export const sync = () => { readLog(); return drain.sync(); };

// Queues writes behind any still waiting, then tries them all: in a fresh drain after one already
// running, so the promise settles once these ops have been tried (focus Done's check-off waits
// on it).
export function queue(...ops) {
  put(OUTBOX_KEY, JSON.stringify([...readOutbox(get(OUTBOX_KEY)), ...ops]));
  return drain.after();
}

let view = null;
const loadView = () => (view ??= import("./focus-view.mjs").then((m) => { m.setupFocusView({ getSession, setSession, queue, progressFor, addLog, isLogLoaded }); return m; }, (e) => { view = null; throw e; }));
export const openFocus = (blockId) => loadView().then((m) => m.open(blockId));

export function setupFocus(node) {
  root = node;
  note = el("p", { className: "sheet-notice", role: "status", textContent: "Focus changes are saved on this device and will sync when you're back online." });
  note.hidden = true;
  root.querySelector("[data-status]")?.after(note);
  actHooks["focus-start"] = (e) => openFocus(e.target.closest("[data-block]").dataset.block).catch(console.error);
  let first = true;
  // Writes wait for the planner's first draw (signed in, the week loaded), then for each return
  // online.
  addEventListener("online", () => { if (!first) sync(); });
  renderHooks.push(() => {
    if (first) {
      first = false;
      sync();
      // The deep link from Telegram's start nudge or a bookmark: /plan/?focus=<block id>.
      const id = new URLSearchParams(location.search).get("focus");
      if (id) { history.replaceState(null, "", location.pathname); openFocus(id).catch(console.error); }
    }
    let s = getSession();
    // A session whose task was finished elsewhere (the week's ✓, Telegram) ends.
    if (s && state.tasks.get(s.task_id)?.done) { setSession(null); s = null; }
    // So does its credit: a closing row for each done task with open rows (once they're read).
    if (logLoaded) {
      const rows = closeFinished(progress, state.tasks, state.today, new Date(), () => crypto.randomUUID());
      for (const row of rows) addLog(row);
      if (rows.length) queue(...rows.map((row) => ({ op: "log", row }))).catch(console.error);
    }
    const target = s ? { id: s.block_id, task_id: s.task_id } : focusTarget(state.blocks, state.tasks, new Date(), SHEET.timeZone);
    // A Someday task or a project's step can hold a block today without being on today's list
    // (the horizon gives it minutes, the morning plan times them); its Start goes on its row in
    // Someday or under its project. Projects draw after this hook, so the lookup waits a tick.
    queueMicrotask(() => {
      if (target) placeStart(s, target);
      placeProgress();
    });
  });
}

// "40m focused of 1h30" under each open task that Stopped sessions have credited.
function placeProgress() {
  for (const [id, p] of progress) {
    const t = state.tasks.get(id);
    const text = t && !t.done && progressText(p, t.est_min);
    if (!text) continue;
    for (const row of root.querySelectorAll(`.sheet-task[data-id="${id}"]`)) {
      if (row.querySelector(".sheet-focus-progress")) continue;
      const line = row.querySelector(".sheet-focus-line") ?? row.appendChild(el("span", { className: "sheet-focus-line" }));
      line.append(el("span", { className: "sheet-focus-progress", textContent: text }));
    }
  }
}

function placeStart(s, target) {
  if (root.querySelector('[data-act="focus-start"]')) return;
  const row = root.querySelector(`.sheet-day[data-day="${state.today}"] .sheet-task[data-id="${target.task_id}"]`)
    ?? root.querySelector(`:is(.sheet-list, .sheet-project) .sheet-task[data-id="${target.task_id}"]`);
  if (!row) return;
  const label = s ? `Resume · ${focusClock(s, new Date()).left}${s.ends_at <= Date.now() ? " over" : " left"}` : "Start";
  const button = el("button", { type: "button", className: "sheet-focus-start", textContent: label, ariaLabel: `${s ? "Resume" : "Start"} focus on ${state.tasks.get(target.task_id).title}` });
  Object.assign(button.dataset, { act: "focus-start", block: target.id });
  row.append(el("span", { className: "sheet-focus-line" }, button));
}

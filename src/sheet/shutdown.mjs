// Shutdown (docs/sheet.md): Done and Missed for today, one reflection box, then Finish. Nothing
// is saved before Finish; then missed tasks roll to tomorrow and the day is stamped.
import { SHEET } from "../site.mjs";
import * as api from "./api.mjs";
import { localNow, byPosition } from "./logic.mjs";
import { el, state, render, load, completeTask, keyHooks, actHooks, renderHooks, failed } from "./planner.mjs";

let dialog;
let today;
let done;          // id → done, as edited in the dialog
let reflection = "";

const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const shutdownAt = (d) => clock((state.days[d]?.shutdown_at ?? SHEET.shutdownAt).slice(0, 5));
const todays = () => [...state.tasks.values()].filter((t) => t.day === today).sort(byPosition);

function column(title, isDone) {
  const items = todays().filter((t) => done.get(t.id) === isDone);
  return el("section", { className: "sheet-shut-col" },
    el("h3", { textContent: `${title} (${items.length})` }),
    el("ul", {}, ...items.map((t) => {
      const b = el("button", { type: "button", className: "sheet-shut-item", textContent: t.title });
      b.dataset.id = t.id;
      b.setAttribute("aria-label", `${t.title}: move to ${isDone ? "Missed" : "Done"}`);
      return el("li", {}, b);
    })));
}

function draw(finished = false) {
  if (finished) {
    dialog.replaceChildren(
      el("h2", { id: "sheet-shut-title", textContent: "Shutdown complete" }),
      el("p", { textContent: "Missed tasks are on tomorrow. See you then." }),
      el("form", { method: "dialog", className: "sheet-dialog-end" }, el("button", { type: "submit", className: "sheet-btn primary", textContent: "Close" })));
    return;
  }
  const box = el("textarea", { className: "sheet-reflect", rows: 3, value: reflection, ariaLabel: "What went well, what got in the way?", placeholder: "What went well, what got in the way?" });
  box.addEventListener("input", () => { reflection = box.value; });
  dialog.replaceChildren(
    el("h2", { id: "sheet-shut-title", textContent: "Shut down" }),
    el("p", { className: "small", textContent: "Click a task to move it between Done and Missed. Missed tasks go to tomorrow." }),
    el("div", { className: "sheet-shut-cols" }, column("Done", true), column("Missed", false)),
    box,
    el("div", { className: "sheet-dialog-end" },
      el("button", { type: "button", className: "sheet-btn", textContent: "Cancel", onclick: () => dialog.close() }),
      el("button", { type: "button", className: "sheet-btn primary", textContent: "Finish", onclick: finish })));
}

function open() {
  today = localNow(new Date(), SHEET.timeZone).day;
  done = new Map(todays().map((t) => [t.id, t.done]));
  reflection = state.days[today]?.reflection ?? "";
  draw();
  dialog.showModal();
}

async function finish() {
  try {
    for (const t of todays()) if (done.get(t.id) !== t.done) await completeTask(t.id, done.get(t.id));
    await api.shutDown(today, reflection.trim() || null);
    await load();
    draw(true);
  } catch (e) { failed(e); }
}

export function setupShutdown(root) {
  dialog = root.querySelector("[data-shut]");
  actHooks.shutdown = open;
  keyHooks.push((e) => { if (e.key === "o" || e.key === "O") { open(); return true; } return false; });
  dialog.addEventListener("click", (e) => {
    const item = e.target.closest(".sheet-shut-item");
    if (!item) return;
    done.set(item.dataset.id, !done.get(item.dataset.id));
    draw();
    dialog.querySelector(`.sheet-shut-item[data-id="${item.dataset.id}"]`)?.focus();
  });
  dialog.addEventListener("close", () => render());
  // The button shows from two hours before shutdown until the day is shut down.
  renderHooks.push(() => {
    const now = localNow(new Date(), SHEET.timeZone);
    const button = root.querySelector('[data-act="shutdown"]');
    button.hidden = Boolean(state.days[now.day]?.shutdown) || now.minutes < shutdownAt(now.day) - 120;
  });
}

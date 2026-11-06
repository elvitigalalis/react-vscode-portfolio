// A task's details without typed syntax (research U11), from the row menu's Details…: an estimate
// with presets, a native time and date picker, a tag, each with a Clear. Loaded the first time it
// opens. Saving offers the usual Undo. Text goes in through textContent only.
import { formatMinutes } from "./logic.mjs";
import * as api from "./api.mjs";
import { el, offerUndo, render, state } from "./planner.mjs";
import { detailsChange } from "./task-details.mjs";

const PRESETS = [15, 30, 45, 60, 90, 120];
const button = (className, textContent, onClick) => {
  const b = el("button", { type: "button", className, textContent });
  b.addEventListener("click", onClick);
  return b;
};

// A label, its input and a Clear that shows only while there's something to clear.
function field(label, id, props, words = label.toLowerCase(), above = null) {
  const input = el("input", { id, ...props });
  const clear = button("sheet-link", "Clear", () => { input.value = ""; sync(); input.focus(); });
  clear.ariaLabel = `Clear ${words}`;
  const sync = () => { clear.hidden = !input.value; };
  input.addEventListener("input", sync);
  sync();
  return { input, sync, node: el("div", { className: "sheet-details-field" }, el("label", { htmlFor: id, textContent: label }), above, el("div", { className: "sheet-details-row" }, input, clear)) };
}

export function openDetails(root, id) {
  const t = state.tasks.get(id);
  const dialog = root.querySelector("[data-details]");
  const est = field("Estimate (minutes)", "sheet-details-est", { type: "text", inputMode: "numeric", autocomplete: "off", value: t.est_min ?? "" }, "estimate");
  est.node.insertBefore(el("div", { className: "sheet-details-presets" }, ...PRESETS.map((m) => button("sheet-btn", formatMinutes(m), () => { est.input.value = String(m); est.sync(); }))), est.node.lastChild);
  // A Someday task has no day for a fixed time to be on.
  const time = t.day ? field("Fixed time", "sheet-details-time", { type: "time", value: t.at_time?.slice(0, 5) ?? "" }, "fixed time") : null;
  const due = field("Due date", "sheet-details-due", { type: "date", value: t.due ?? "" });
  const tag = field("Tag", "sheet-details-tag", { type: "text", autocomplete: "off", value: t.tag ?? "" });
  const note = el("p", { className: "sheet-details-note", role: "alert" });
  const close = () => { dialog.close(); root.querySelector(`[data-id="${id}"] .sheet-title`)?.focus(); };
  const form = el("form", {},
    el("h2", { id: "sheet-details-title", textContent: t.title }),
    est.node, time?.node, due.node, tag.node, note,
    el("div", { className: "sheet-dialog-end" }, button("sheet-btn", "Cancel", close), el("button", { type: "submit", className: "sheet-btn primary", textContent: "Save" })));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { change, error } = detailsChange(t, { est: est.input.value, time: time?.input.value ?? "", due: due.input.value, tag: tag.input.value });
    if (error) return void (note.textContent = error);
    if (!Object.keys(change).length) return close();
    const before = Object.fromEntries(Object.keys(change).map((k) => [k, t[k]]));
    try { state.tasks.set(id, await api.updateTask(id, change)); } catch (err) { console.error(err); return void (note.textContent = "That didn't save. Try again."); }
    offerUndo("Details saved.", async () => { state.tasks.set(id, await api.updateTask(id, before)); });
    close();
    render();
  });
  dialog.replaceChildren(form);
  dialog.showModal();
  est.input.focus();
}

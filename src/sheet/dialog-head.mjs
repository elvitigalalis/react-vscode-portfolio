// A dialog's header (plan-overlays.css): its title and an icon Close at the right. Close asks the
// dialog to close the way Escape does (requestClose fires cancel), so a dialog that holds Escape
// while it saves (dismiss.mjs, holdEscape) holds this too; without requestClose it just closes.
import { el, icon } from "./planner.mjs";

// The title takes the dialog's first focus (autofocus, tabindex -1: no ring), so a screen reader
// starts there and the next Tab reaches Close, instead of opening on a ringed Close.
export function dialogHead(title) {
  title.tabIndex = -1;
  title.autofocus = true;
  const close = el("button", { type: "button", className: "sheet-btn sheet-icon-btn", ariaLabel: "Close" }, icon("x"));
  close.addEventListener("click", () => {
    const dialog = close.closest("dialog");
    if (typeof dialog?.requestClose === "function") dialog.requestClose();
    else dialog?.close();
  });
  return el("header", { className: "sheet-dialog-head" }, title, close);
}

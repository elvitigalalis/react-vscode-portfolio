// Where /plan's Undo toast lives (planner.mjs, offerUndo). A modal dialog (Plan today, Shut down)
// makes the page under it inert and draws over it, and a popover over it is inert too, so a toast
// left in the page can't be tapped while one is open
// (https://html.spec.whatwg.org/multipage/interaction.html#modal-dialogs-and-inert-subtrees).
// The toast goes inside the open dialog instead, and back when it closes. Plan today redraws its
// dialog's children, so render() calls this again after its hooks. Needs you and Campus show their
// own Undo, so the toast stays out of them.
export function hostToast(root, toast) {
  if (!toast || toast.hidden) return;
  const top = [...root.querySelectorAll("dialog[open]")].at(-1);
  const own = top && [...top.querySelectorAll('[data-act="undo"]')].some((b) => !toast.contains(b));
  const host = top && !own ? top : root;
  if (toast.parentElement !== host) host.append(toast);
}

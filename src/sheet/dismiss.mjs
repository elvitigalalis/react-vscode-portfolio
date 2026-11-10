// Light dismiss for /plan's dialogs: a click or tap on the backdrop closes a dialog the way its
// Close or Cancel button does (dialog.close(), so its "close" listeners reset state the same way),
// never as Save or Done. Escape is the browser's own: it fires the cancel event and then closes the
// dialog, which ends in the same "close" event. Only holdEscape (below) may stop that, and only
// while its dialog says so: Shutdown while Finish saves, focus mode while Stop's question is open
// (docs/sheet.md, docs/sheet-focus.md). Nothing else on /plan listens for cancel. Popover menus
// (the ⋯ menu, the task menu) are popover="auto", which the browser already closes on Escape and
// on a click outside.
// https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/cancel_event
// https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using#auto_state_and_light_dismiss

// Events on the ::backdrop target the dialog itself, as do events on its padding, so a point
// counts as the backdrop only when it is also outside the dialog's box.
export function onBackdrop(dialog, e) {
  if (e.target !== dialog) return false;
  const r = dialog.getBoundingClientRect();
  return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
}

// Both the press and the click must land on the backdrop: a text selection dragged out of the
// dialog ends with a click on it too, and must leave it open.
export function lightDismiss(dialog) {
  let down = false;
  dialog.addEventListener("pointerdown", (e) => { down = onBackdrop(dialog, e); });
  dialog.addEventListener("click", (e) => {
    if (down && onBackdrop(dialog, e)) dialog.close();
    down = false;
  });
}

// Escape that doesn't close `dialog` while `hold(event)` is true: the one way /plan keeps a dialog
// open on Escape (test/dismiss.test.mjs checks no other module listens for cancel). `hold` may do
// what Escape means there instead (focus mode's Keep going) and returns whether it held.
export function holdEscape(dialog, hold) {
  dialog.addEventListener("cancel", (e) => { if (hold(e)) e.preventDefault(); });
}

// Arrow keys in a popover menu (WAI-ARIA APG, menu pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): ↓ and ↑ move to the next and previous item,
// wrapping, Home and End to the first and last. The index to focus, or null for any other key.
export function menuStep(key, index, count) {
  if (!count) return null;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

// Wires menuStep on a popover menu's visible buttons. Left and right arrows stay in the menu too,
// so they don't page the week behind it.
export function menuKeys(menu) {
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button:not([hidden])")];
    const next = menuStep(e.key, items.indexOf(document.activeElement), items.length);
    if (next !== null) { e.preventDefault(); items[next].focus(); }
    if (next !== null || e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
  });
}

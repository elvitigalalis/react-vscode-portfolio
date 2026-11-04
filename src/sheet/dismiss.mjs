// Light dismiss for /plan's dialogs: a click or tap on the backdrop closes a dialog the way its
// Close or Cancel button does (dialog.close(), so its "close" listeners reset state the same way),
// never as Save or Done. Escape is the browser's own: it fires the cancel event and then closes the
// dialog, which ends in the same "close" event, and nothing on /plan cancels it. Popover menus
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

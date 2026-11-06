// What a swipe on the phone means (research U10, P12; docs/sheet.md, "On the phone"): the decisions
// only, swipe-ui.mjs does the fingers. Horizontal distances are signed, right positive.

// Moved far enough to tell, and clearly sideways? Sideways has to win by half again, so a slanted
// flick while scrolling stays a scroll.
const SLOP = 10;
export function lockAxis(dx, dy) {
  if (Math.hypot(dx, dy) < SLOP) return null;
  return Math.abs(dx) > 1.5 * Math.abs(dy) ? "x" : "y";
}

// What a row's swipes do: { right, left }, each { label, act } or null. A done row has none, so a
// swipe starting on it steps the day. "Tomorrow" on tomorrow's list would do nothing, so a later
// day's left swipe moves the task one day on.
export function swipeActions({ kind, done, day, today }) {
  if (done) return null;
  const right = { label: "Done", act: "done" };
  if (kind === "event") return { right, left: null };
  return { right, left: day && day > today ? { label: "Next day", act: "day-after" } : { label: "Tomorrow", act: "tomorrow" } };
}

// A row commits past 35% of its width, or 96 px on a wide row.
export const rowArmed = (dx, width) => Math.abs(dx) >= Math.min(96, width * 0.35);

// A day steps past 60 px, mostly sideways (research P12): "next" when the finger goes left.
export function dayStep(dx, dy) {
  if (Math.abs(dx) < 60 || Math.abs(dx) <= 2 * Math.abs(dy)) return null;
  return dx < 0 ? "next" : "prev";
}

// The Now/Next line above today (research U18): from a day's rows (event-todos.mjs, dayRows), the
// open row running at this minute and the next to start. Rows are in time order. A task's fields
// sit on r.task; an event's on the row. All-day rows and untimed tasks have no start.
export const rowTitle = (r) => (r.kind === "task" ? r.task.title : r.title);
const open = (r) => r.start != null && !(r.kind === "task" ? r.task.done : r.done);

export function nowNext(rows, minutes) {
  const timed = rows.filter(open);
  // In an overlap (a block during a lecture) the one started last is what he just turned to.
  const now = timed.filter((r) => r.start <= minutes && minutes < r.end).sort((a, b) => b.start - a.start)[0] ?? null;
  const next = timed.filter((r) => r.start > minutes).sort((a, b) => a.start - b.start)[0] ?? null;
  return { now, next };
}

// Reflow rest of today (docs/sheet.md, "Reflow rest of today"): the plain logic, with no DOM and
// no network, so node --test covers it. reflow-view.mjs draws the button and saves the moves.
// No AI: the day's unfinished blocks keep their order and length and go after now, around what
// is fixed, and before the shutdown line.

// Starts land on 5-minute marks.
const STEP = 5;
const up = (m) => Math.ceil(m / STEP) * STEP;

// `blocks` are today's blocks in minutes past midnight: { id, task_id, start, end, proposed }.
// `tasks` is the Map of tasks by id. `busy` are today's busy timed events as { start, end }.
// `now` and `shutdown` are minutes past midnight; `keep` holds block ids that must not move (the
// one a focus session is running on).
//
// A block moves when it is an approved task block of an open task with no fixed time (@3pm), and
// it either ended already (missed) or starts later and now clashes with something. One running
// now stays. In their old order, each goes at the first free spot from the end of the one before
// (a later block never earlier than it was), clear of busy events and every block that stays,
// ending by `shutdown`. One that doesn't fit stays where it was and is named in `unfit`.
// Returns { moves: [{ id, task_id, from: { start, end }, to: { start, end } }], unfit: [id] }.
export function reflowPlan({ blocks, tasks, busy, now, shutdown, keep = [] }) {
  const open = (b) => {
    const t = b.task_id && tasks.get(b.task_id);
    return Boolean(t) && !t.done && !t.at_time && !b.proposed && !keep.includes(b.id);
  };
  const movable = blocks.filter((b) => open(b) && (b.end <= now || b.start >= now) && b.start < shutdown)
    .sort((a, b) => a.start - b.start);
  const ids = new Set(movable.map((b) => b.id));
  // Proposed blocks are Claude's suggestions, not plans: they take no time (as +15 min ignores them).
  const taken = [...busy, ...blocks.filter((b) => !b.proposed && !ids.has(b.id))].map(({ start, end }) => ({ start, end }));
  const moves = [];
  const unfit = [];
  let cursor = up(now);
  for (const b of movable) {
    const len = b.end - b.start;
    let at = b.end <= now ? cursor : Math.max(cursor, b.start);
    for (let hit; (hit = taken.find((x) => x.start < at + len && x.end > at));) at = up(hit.end);
    // A later block that can't move still holds its old time, so nothing lands on it.
    if (at + len > shutdown) { unfit.push(b.id); if (b.start >= now) taken.push({ start: b.start, end: b.end }); continue; }
    taken.push({ start: at, end: at + len });
    cursor = at + len;
    if (at !== b.start) moves.push({ id: b.id, task_id: b.task_id, from: { start: b.start, end: b.end }, to: { start: at, end: at + len } });
  }
  return { moves, unfit };
}

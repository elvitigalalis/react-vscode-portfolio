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
// A later block that can't fit keeps its old time, and the others must stay off it: the plan is
// laid again with it pinned there, until no new later block comes back unfit, so a reflow never
// lays one block over another.
// Returns { moves: [{ id, task_id, from: { start, end }, to: { start, end } }], unfit: [id] }.
export function reflowPlan({ blocks, tasks, busy, now, shutdown, keep = [] }) {
  const open = (b) => {
    const t = b.task_id && tasks.get(b.task_id);
    return Boolean(t) && !t.done && !t.at_time && !b.proposed && !keep.includes(b.id);
  };
  // A later block that already runs past shutdown was planned that way: it stays, and isn't
  // reported as one that didn't fit.
  const candidates = blocks.filter((b) => open(b) && (b.end <= now || (b.start >= now && b.end <= shutdown)))
    .sort((a, b) => a.start - b.start);
  const pinned = new Set();
  for (;;) {
    const plan = lay(candidates.filter((b) => !pinned.has(b.id)), blocks, busy, now, shutdown);
    const late = plan.unfit.filter((b) => b.start >= now);
    if (!late.length) return { moves: plan.moves, unfit: [...plan.unfit.map((b) => b.id), ...candidates.filter((b) => pinned.has(b.id)).map((b) => b.id)] };
    for (const b of late) pinned.add(b.id);
  }
}

// One pass: `movable` in order after now, around everything else in `blocks` and `busy`.
function lay(movable, blocks, busy, now, shutdown) {
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
    if (at + len > shutdown) { unfit.push(b); continue; }
    taken.push({ start: at, end: at + len });
    cursor = at + len;
    if (at !== b.start) moves.push({ id: b.id, task_id: b.task_id, from: { start: b.start, end: b.end }, to: { start: at, end: at + len } });
  }
  return { moves, unfit };
}

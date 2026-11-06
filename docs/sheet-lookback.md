# The look-back

What /plan shows Lisul from his own history so he plans better (research items I1, I3, I5, I7
and U14). Pure numbers and lines are in `src/sheet/lookback.mjs` (`test/lookback.test.mjs`);
`lookback-view.mjs` draws them in Plan today and the "Last week" dialog, and
`lookback-shutdown.mjs` in Shutdown. Both load on demand, so /plan's first-load script is
unchanged.

## Rules

- **Sample gates.** Every insight returns null below its gate, and the screen then shows nothing
  at all, not a weak claim.
- **Facts about tasks, not grades.** No scores, percentages, streaks or good/bad colours. Done is
  one colour whatever the day was. Moved work is "moved" or "Tomorrow", never "missed".
- **His own past only**, and every gap names a next move.
- **No Oura.** Nothing here reads sleep data (ADR 0005), and none of it reaches read_planner.

## What shows, and when

| Item | Where | Gate |
| --- | --- | --- |
| Last week (I1): done of planned, 7 paired day bars with the cap tick, moved, didn't start, the week's reflections; the week before beside it | "Last week" link in Plan today (on Monday with the week's line); its own dialog | 3 days with approved task blocks in that week (the week before needs the same) |
| Estimate hint (I3): "Course tasks like this took about 2h05 for a 1h30 estimate (median of 12) · blocks will be 2h" | under each task row in Plan today | the kind's pace gate (5 estimated actuals) and an estimate |
| Kept moving (I5): "X keeps moving. What would make it easier to start?" with Give it a time, Split it, Move to Someday, Not now (hides it for 7 days on this device) | Plan today for that day's tasks, the Last week dialog, Shutdown's Tomorrow step | 2 rolls, a park in Inbox in the last 14 days, or 2 Tomorrow answers in 14 days |
| Due dates (I7): "Due in the last 4 weeks: 6 tasks · 4 done by the due date · …" | Last week dialog | 5 tasks due in the last 28 days with a known finish |
| Did On track hold (I7): "Marked On track about a week out: 9 of 10 finished by that date" | Last week dialog | 10 settled `horizon_calls` rows |
| Shutdown (U14): today's event to-dos with checks, one line (done, moving to tomorrow, suggestions turned down, pace trend), earlier reflections collapsed, then a Tomorrow step with its events, tasks, load against its room and mover prompts | Shutdown | the pace trend needs 10 estimated actuals of a kind and a change; zeros are left out |

## Data

- `tasks.done_at`, set by a trigger when `done` turns true and cleared when it turns false.
  Tasks finished before it existed stay null and are left out of the due look-back; `updated_at`
  changes on any edit, so it is never used as a finish day.
- `horizon_calls (task_id, due, state, called_on)`: the first state a re-flow gave a task 5–7 days
  before its due date, written by a trigger on `horizon_state`, one per task and due date.
  `horizon_state` keeps only the current state and drops done tasks, and it began on 2026-11-06,
  so this table is the only honest record of "On track a week out"; it starts empty and the
  On track look-back stays hidden until 10 calls have settled.

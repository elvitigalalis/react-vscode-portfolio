# Spec: Horizon planning

Today the plan sees one day. A 12-hour project due in three weeks gets nothing until the day it
is "at risk", and then it can't fit. Horizon planning gives every undone task with a due date
planned minutes on each working day from today up to its due date, however far off, and a state
that says whether it will make it. Plain server code places the minutes
([ADR 0006](adr/0006-horizon-planning-in-code.md)); Claude's morning plan and replans only turn
today's minutes into timed blocks, as they do now. Terms are as in [GLOSSARY.md](../GLOSSARY.md);
the research behind the numbers (Motion, Reclaim, Morgen, Sunsama, EDF, Critical Chain) is in
the horizon-scheduling research notes (R1–R12 below).

It ships in two parts. **Part 1** (this branch) is the contract, the engine
(`src/sheet/horizon.mjs`, covered by `test/horizon.test.mjs`) and the tables. Nothing calls them
yet. **Part 2** wires them in: the re-flow on the server, read_planner and checkProposal, /plan,
Telegram and the routine prompt ("Part 2" below).

## The engine: `planHorizon(input)`

Pure, deterministic, no network. Same input, same output.

### Input

| field | what |
| --- | --- |
| `today` | `"YYYY-MM-DD"` in `settings.time_zone` |
| `tasks` | `[{ id, due, minutes, done_min, kind? }]`: every task that is not done, has a `due` and has no `at_time` (a fixed-time task stays on its day). `minutes` is `horizonMinutes(task, paces)`; `done_min` is `confirmedDoneMin(...)[id] ?? 0`. Optional `kind` is `workKind(task)` ("exam", "programming", "writing" or null); without it every task gets the plain rules. |
| `free` | `{ day: minutes }` for every day from today to the latest due date: `dayFree(...)` of that day. A missing day has 0. |
| `locked` | `[{ task_id, day, minutes }]`: today's locked task blocks, past ones too (one row per task, minutes summed). |
| `frozen_days` | `[day]`: tomorrow once today is shut down (`days.shutdown`), else `[]`. |
| `previous` | the stored allocation (`horizon_alloc` rows from today on), for stability. |

Helpers in the same module:

- **`horizonMinutes(task, paces)`**: `est_min ?? 30`, times the kind's pace when it has one
  (`paceByKind`), rounded to 15, at least 15. Unlike `pacedMinutes` there is no 4-hour limit,
  since the minutes spread over days.
- **`confirmedDoneMin(blocks, feedback)`** → `{ task_id: minutes }`: a block answered **More
  time** on its Finished? check counts from its start to that answer (the latest one), at most
  its length. Nothing else counts: an unconfirmed past block is not done (R10). A **Finished**
  answer marks the task done, so it leaves `tasks` anyway.
- **`dayFree({ cap, window_free_min, locked_min })`** = `min(cap − locked_min,
  window_free_min)`, at least 0, rounded down to 15:
  - `cap` is the day's workload cap: `dayCap(settings.workload_cap_min, sleepDay, locked)` today,
    `settings.workload_cap_min` on later days;
  - `window_free_min` is `freeMinutes` over the plan window (`windowStart` to `shutdownFor`, as
    planSnapshot's `window`) after the day's busy times widened by `travel_min` (10) on each side,
    that weekday's habits at their ideal times, and the day's locked blocks;
  - `locked_min` is the minutes of the day's locked task blocks (habits stay out, as in the cap).
- **`workKind(task)`**: `task.kind` when set; GitHub and Jira tasks are `"programming"`; else the
  title: exam, quiz, test, midterm or final (not "final project/paper/report/essay/presentation/
  draft") is `"exam"`, program/coding/code/implement/debug is `"programming"`, essay/paper/report/
  write-up/draft/writing is `"writing"`, anything else `null`. The caller passes the task row
  (`title`, `source`) and puts the result in the input's `kind`.
- **`targetDay(due, today, working, buffer_min = 0, room = () => 0)`**: see "Buffer" below.

### Output

```
{
  allocations: [{ task_id, day, minutes, over_min }],   -- by day, then plan order
  tasks: { [id]: { state, slack_min, short_min, finish_day, target_day, remaining_min } },
  moved_min                                             -- minutes taken off where `previous` had them
}
```

`minutes` on a day includes that task's locked minutes there. `over_min` is the part the rules
couldn't place: past the day's free time or past the task's daily maximum (only ever on the due
day of a task that won't fit).

### Rules

1. **Remaining** = `minutes − done_min`, rounded up to 15, at least 0 (R10). Locked and frozen
   minutes count toward it; locked minutes are kept even past it.
2. **Plan order (EDF):** due date (an overdue one reads as due today), then fewer remaining
   minutes, then id (R3).
3. **Front-loaded fill:** each task in plan order takes free time from today onward, earliest day
   first, never as late as possible (R3). Days after today take at most `FUTURE_FILL` (85%) of
   their free time, rounded down to 15; today takes all of it. The slack absorbs the overruns a
   far-off day's estimate hides (Zauberman & Lynch 2005). A task the plain pass can't finish may
   top up days it already has in 15-minute steps, but only when that places all of what is left.
4. **Chunks (R2):** one task gets at least 30 and at most 90 minutes on a day, the due day too; a task with 60
   minutes or less remaining is never split; no piece under 30 is ever left (90 + 90 + 15 becomes
   90 + 75 + 30). All minutes move in 15-minute steps.
5. **Buffer (R4):** the **target day** is the last working day before the due day when the due
   day is 2 or more days off, else the due day. A **working day** has free time, is frozen, or
   holds a locked block. The buffer (target + 1 to the due day) must also hold `BUFFER_SHARE`
   (20%) of the task's `minutes`, counted in the days' fill room: the target steps back a working
   day at a time until it does, never before today (overruns grow with size: Buehler 1994). So a
   60-minute task keeps a one-day buffer and a 10-hour one on 2-hour days gets two. Fill runs to
   the target day first, then into the buffer.
6. **Earlier deadlines win:** when a task can't reach its target (or then its due day) in free
   time, it takes kept minutes from tasks due later, only as many as it needs: the smallest cut
   first, then one the later task can take back on its other days, then latest due, then latest
   day. Those re-place in their own turn.
7. **Stretch:** before giving up, a `programming` or `writing` task may hold up to `STRETCH_MAX`
   (120) minutes a day, from today to its due day, filling free time and then under rule 6.
   Other kinds never pass 90 (study is better spaced; production work has a fixed start-up
   cost). This replaces the old due-day crunch, which let any task take the whole due day.
8. **Won't fit stays visible (R7):** what is still left goes on the due day as `over_min`, past
   the cap, never dropped.
9. **No new minutes before today, after the due day, or on a frozen day.**

### Stability (R9)

A re-flow starts from `previous` and changes only what the change forces:

- **Frozen:** today's locked blocks and, once today is shut down, all of tomorrow. Frozen minutes
  are kept as they were (cut, latest first, only if they now exceed what is left; a done task's
  go).
- **Kept:** every other previous minute that still holds stays on its day: within today to the
  task's due day, up to what is left (earliest days kept first), within the chunk rule. Last
  run's `over_min` is not kept; it is planned again.
- **Forced moves only:** a day whose free time shrank (a busy time landed) gives back only the
  minutes past its free time, from the task due latest. New or grown work takes free time first
  and displaces kept minutes only under rule 6. Kept minutes past a task's target come forward
  when time before the target is free, so a task doesn't eat its buffer needlessly.
- Re-planning its own output moves nothing (`moved_min` 0), and after one change (a busy time, a
  new task, a done task) a re-flow never moves more minutes than a fresh plan would; the tests
  check both over random inputs.
- **Re-flow only on triggers, never on a timer** ("Part 2"): the server skips a run whose inputs
  key equals `settings.horizon_key`.

### States (R5, R6)

- **`slack_min`**: the running-sum margin at the task's due day: the free minutes from today to
  it, plus the locked and frozen minutes of the tasks due by then, less what those tasks have
  left.
- **`short_min`**: the task's `over_min`, summed.
- **`finish_day`**: its last day with minutes (null with nothing left).
- **`wont_fit`** when `short_min > 0`.
- **`tight`** otherwise when it finishes after its target day, or `slack_min` is under one day's
  chunk (`min(90, remaining)`), or it is overdue.
- **`on_track`** otherwise, and always with nothing left.

## Data model (`supabase/schema.sql`, "Horizon planning"; additive, safe to re-run)

```sql
horizon_alloc  task_id uuid references tasks on delete cascade, day date,
               minutes int > 0, over_min int 0..minutes, updated_at,
               primary key (task_id, day)
horizon_state  task_id uuid pk references tasks on delete cascade,
               state in ('on_track','tight','wont_fit'), slack_min, short_min >= 0,
               remaining_min >= 0, finish_day date, target_day date, updated_at
settings     + horizon_at timestamptz, horizon_key text (<= 128 chars)
replace_horizon(from_day date, key text, allocs jsonb, states jsonb) returns int
```

- Both tables: RLS on with `owner_all` under `is_owner()`, `revoke all … from anon`, in no public
  view. /now never sees them.
- `replace_horizon` (security invoker, `authenticated` and `service_role`): in one transaction it
  deletes allocations from `from_day` on (and those over 30 days old), inserts `allocs`, replaces
  every state with `states`, skips rows whose task no longer exists, and sets `horizon_at` and
  `horizon_key`. Every delete and update has a `where`, for pg-safeupdate. A bad row fails the
  whole call and leaves the last plan as it was. `tools/test-schema.sh` checks this.

## Where it runs

Server code only (ADR 0006). Part 2's re-flow runs in the `telegram` function's minute tick
(service role), beside the replan decision, and in planner-mcp's `read_planner` (the owner's
client) right before it builds the snapshot, so the routine always reads fresh minutes. Each
builds the input, computes the key, and calls `replace_horizon` only when the key changed. The
engine reads the day's workload cap, which on an Oura day follows readiness and sleep; only the
resulting minutes and states ever reach Claude, never the Oura numbers (ADR 0005).

## Part 2: the wiring

1. **`src/sheet/horizon-io.mjs`**: `horizonQueries(today)` (undone tasks with a due date,
   today's blocks, the busy rows and habits for today to the latest due date, `actuals`,
   `feedback` of item `finished` for those tasks' blocks, today's `days` row, today's Oura
   `sleep_days` row, `horizon_alloc` from today) and `horizonInput(rows, now)`, which builds the
   input above, and `horizonKey(input)`: SHA-256 hex of the canonical JSON of every input field
   except `previous`.
2. **The re-flow**, `reflowHorizon(db, now)` in both functions: build, key, skip when equal,
   else `planHorizon` and `replace_horizon(today, key, allocations, states)`. Triggers: the tick
   (cheap thanks to the key: task edits, done tasks, busy syncs, Finished? answers, approved or
   locked blocks, shutdown and the day rolling over all change the key) and read_planner.
3. **read_planner** (`planSnapshot`): each task gains `horizon: { today_min, state, slack_min,
   short_min, finish_day }`, and a task with a `today_min` that isn't on plan_day (a Someday
   task, say) joins `tasks`. Tight and won't-fit tasks come first (R8).
4. **checkProposal**: a block of a task with `today_min` runs `today_min` (less its locked
   minutes today) instead of `paced_min`; such a task is never in `next_day`, so
   `move_to_next_day` leaves it alone (the re-flow moves its minutes instead).
5. **At risk**: `atRisk` (logic.mjs) reads `horizon_state` when the task has a row: at risk is
   `tight` or `wont_fit`. Glance, the brief and planSnapshot follow.
6. **/plan**: a state chip on the task row; one quiet line per task, "OS project · 4h left ·
   Mon 1h, Tue 1h30, Wed 1h30 · done Wed, 1 day spare" (R11); later days' minutes faded in the
   week; won't fit in red with the hours short and the fixes (move the due date, cut the estimate,
   raise one day's cap) (R7).
7. **Telegram**: one nudge when a task goes on track → tight or → won't fit, in the morning
   brief, inside the nudge budget (R12); moved minutes get none. **Tomorrow** on a tight or
   won't-fit task asks to confirm and shows the new state (R8).
8. **The routine prompt** (docs/sheet-morning-task.md): time each task's `today_min` today,
   tight and won't-fit first; it never moves minutes to other days.
9. **Deploy**: run the "Horizon planning" section of `supabase/schema.sql`, then deploy
   `telegram`, `planner-mcp` and the site, then paste the prompt.

Later, not in part 2: a per-task "start after" day and "max per day" (R2, R12).

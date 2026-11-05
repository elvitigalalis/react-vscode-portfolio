# Horizon planning is placed by server code; Claude only times today

Horizon planning ([docs/sheet-horizon.md](../sheet-horizon.md)) gives every task with a due date
planned minutes on each working day up to it. Something has to decide how many minutes go on
which day, re-decide whenever a busy time lands or a task is added or done, and say whether each
task will make it. That could be Claude, through the morning plan's routine
([ADR 0003](0003-the-morning-plan-runs-as-a-cloud-scheduled-task.md)), or plain code.

## Decision

**Placement across days is deterministic server code; Claude only turns today's minutes into
timed blocks.**

- `src/sheet/horizon.mjs` (`planHorizon`) places minutes earliest due first, in 30–90 minute
  chunks, aiming a working day early, and works out each task's state (on track, tight, won't
  fit) and slack. It is pure, so `node --test` covers it, and the same input always gives the
  same plan.
- The server runs it on every change (the telegram tick and read_planner), never on a timer, and
  stores the result in `horizon_alloc` and `horizon_state` through `replace_horizon`.
- Future days hold minutes only: no timed blocks and no Google events.
- read_planner hands the routine today's minutes and each task's state; the routine places them
  as blocks, as it places tasks now. It never moves minutes to another day.
- The day's workload cap, which on an Oura day follows readiness and sleep, is read by code only;
  Claude sees the minutes and states that come out, never the numbers behind them
  ([ADR 0005](0005-oura-data-never-reaches-claude.md)).

## Why

- **Stability needs memory and exactness.** A re-flow must keep yesterday's plan and move only the
  minutes a change forces. Code can compare against the stored allocation minute for minute; a
  model asked again replans from scratch and moves things for no reason, which is the top
  complaint about Motion and Reclaim.
- **Feasibility is arithmetic.** Earliest-deadline-first and the running-sum test are exact and
  cheap. Getting "won't fit, 2h short" wrong because a model added badly is worse than not saying
  it.
- **It runs between routine runs.** Re-flows happen on every busy sync and Finished? answer, many
  times a day; the routine runs a few times a day and costs a run each time. ADR 0001 rules out an
  API key on the server, so the server can't ask Claude anyway.
- **Timing a day is still judgement.** Which hour suits which task, around classes, habits and
  breaks, is what Claude already does well, so today stays Claude's.

## Considered Options

- **Claude plans the whole horizon in each run.** One prompt sees everything, but its plan would
  shift every run, nothing could re-flow between runs, and its arithmetic would be unchecked.
  Rejected.
- **A solver (ILP or constraint programming).** Finds the true fewest-moved-minutes plan, but
  adds a dependency to an Edge Function for a one-person planner whose greedy plan is already
  checked against a fresh plan in the tests. Out of scope (docs/sheet-v5.md); revisit if the
  greedy re-flow is seen to churn.
- **Timed tentative blocks on future days.** Reclaim's approach; it floods the calendar and every
  change moves many blocks. Rejected for minutes per day.

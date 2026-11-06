# Projects that split into steps

A deliverable too big for one sitting ("CSE 416 final project due Dec 10, about 15 hours") is a
**project**: a due date and a total estimate, made of 3 to 10 ordered **steps**. Each step is an
ordinary task, so the horizon spreads it over the days, the morning plan times it, and nudges,
Finished? and pace treat it like any other task. The only new rules are that steps are planned
in order and share the project's buffer. Terms are as in [GLOSSARY.md](../GLOSSARY.md).

## Data model (`supabase/schema.sql`, "Projects"; additive, safe to re-run)

```sql
projects  id, title (1-120), due date not null, est_min 15..6000, done, created_at
tasks   + project_id uuid references projects on delete cascade, step int > 0
          check ((project_id is null) = (step is null))
trigger tasks_project_done: after a step's done changes or a step is deleted, projects.done is
        true exactly when no step is left undone
answer_message(m, new_tasks, new_events, answer, new_projects jsonb) returns text   -- new overload
undo_message_item: a project item deletes the project, and its steps with it
```

`projects` has RLS `owner_all` and no anon access; the public views list tasks' columns by name,
so /now never sees `project_id` or `step`. A step's `due` is the project's `due`, written once
when the project is made. Choices, made without Lisul (he can revisit):

- **A small table plus two columns on tasks**, not a `kind` on tasks: a project row is not a
  task, so the horizon, nudges, Finished? and pace never see it and need no exceptions.
- **`done` is kept by a trigger**, so finishing the last step finishes the project whoever
  marks it (/plan, a Telegram Finished? tap, the routine), and reopening a step reopens it.
- **No project editing yet.** Steps are edited, moved, checked off or deleted as tasks. To change
  the due date, Undo the message and send it again.

## Making one: answer_messages

Lisul texts or types it like any message ([sheet-messages.md](sheet-messages.md)). Each answer
gains `projects: [{ title ≤ 120, due, est_min, steps: [{ title ≤ 120, est_min }], why? }]`, at
most 3. `checkAnswers` (messages.mjs) refuses a project without a real `due`, with `est_min`
outside 60–6000, with fewer than 3 or more than 10 steps, with a step outside 30–240 minutes, or
whose steps add up to more than 20% away from `est_min`. planner-mcp sends a checked project
through the five-argument `answer_message`, which runs the four-argument one for the tasks and
events, then adds each project and its steps as Inbox tasks in order (`source = 'message'`), and
lists the project on the message as one item `{ id, kind: "project", title, due, list, steps }`.
A message that added only a project is done. The receipt (/plan and Telegram) reads "Added: 1
project" and "Project: CSE 416 final project · 7 steps · due Thu Dec 10", with one Undo that
takes the project and its steps off (their blocks' Google events first).

## Planning: the horizon engine

`horizonInput` passes `project` (`project_id`) and `step` on each step; `planHorizon`
([sheet-horizon.md](sheet-horizon.md)) then:

- orders a project's steps together and by step: due date, then the project's (or task's)
  minutes left, then the project, then the step;
- never gives a step minutes before the last day its predecessor holds minutes (the same day is
  allowed); a step's kept minutes before that day are planned again;
- sizes each step's buffer by the whole project's minutes, so the project as a whole keeps a
  buffer before the due date.

`HORIZON_RULES` is 3, so the first tick after the deploy re-flows. Each step gets its own state,
today's minutes and Finished? check as before; the routine needs no new rule.

## /plan

Under the week, a **Projects** heading (hidden with none) lists each open project as one quiet
row, `projectSummary` (project-view.mjs): its title, the worst state of its open steps ("Tight",
"Won't fit · 1h30 short", in the horizon colours) and "3 of 7 steps · 6h left · due Dec 10" (the
open steps' horizon minutes, or their estimate without a state). It opens to its steps as task
rows (project-list.mjs), which work as anywhere else. Steps stay out of the Someday lists; a step
on a day shows on that day too. A finished project leaves the list.

## Deploy

1. Run `supabase/schema.sql` (the "Projects" section and the changed `undo_message_item`, or the
   whole file; safe to re-run). It must run before the functions, which read `project_id`.
2. Deploy `planner-mcp` and `telegram` with `--use-api --no-verify-jwt`.
3. Merge to main, which deploys the site.
4. Paste the prompt from [sheet-morning-task.md](sheet-morning-task.md) (step 2b changed).
5. Check it: send "CSE 416 final project due Dec 10, about 15 hours". The receipt lists the
   project with its steps, /plan shows it under the week, and after the next tick each step has
   a state and minutes, the later steps on or after the earlier ones' last days.

# Focus mode

A Start button on today's current or next block in /plan opens a calm full-screen view for that
block: the task, its first step, where he left off last time, a large countdown to the block's
end with the time since Start, and four actions. Terms are as in [GLOSSARY.md](../GLOSSARY.md); pace and actuals are as in
[sheet-v5.md](sheet-v5.md) ("pace.mjs", "The Finished? answers").

## What it does

- **Start** goes on one block: today's approved task block that is on now, else the next one
  today (`focusTarget`). Habit blocks, proposed blocks and done tasks get none. While a focus is
  running, that task's row shows **Resume · 12:30 left** (or "over") instead.
- **The view** shows the title, `First: <first_step>` when the block has one, the time left to the
  block's end (`+2:05` once past it), "left · 15:30 in", and a 2px bar. No sound, no animation but
  the bar's one-second step, which `prefers-reduced-motion` turns off. Done plays the task row's
  check-off in the week ([sheet.md](sheet.md), "Completion").
- **Done** records the minutes from Start to Done into `actuals` (rounded, 1–960; under a minute
  records nothing), then marks the task done exactly as the week's ✓ does (`completeTask`: the
  block shrinks to now, or goes if it hadn't started; Undo reopens the task).
- **+15 min** moves the block's end 15 minutes on, and the countdown with it, when those minutes
  overlap no other approved block and no busy Google event and end by 11 pm, as Telegram's More
  time checks its 30. Otherwise it says "The next 15 min aren't free." or "Too close to quiet
  hours." The Google event moves too (`saveBlock`), and Telegram's Finished? check follows at the
  new end.
- **Stuck** sends "I'm stuck on "…". Break it into 2-4 smaller to-dos for today…" (with the first
  step, if any) through /plan's message box, so the to-dos Claude adds show under Recent messages
  to Claude, each with its Undo (docs/sheet-messages.md). It is the message box's own send, so it
  fires the morning task the same way and nothing new runs on the server.
- **Stop** ends the session without finishing the task. It asks "Where did you leave off?" (one
  line, up to 280 characters, may be blank) with **Save and stop** and **Keep going**; see "Stop
  and where I left off" below.
- **Back to plan** (or Escape) leaves the view; the timer keeps running and Resume brings it back.
- **Deep link:** `/plan/?focus=<block id>` opens the view for that block once the week loads (a
  focus already running is shown instead, so no counted time is lost).

## Stop and where I left off

Ending a session on an unfinished task leaves attention on it; writing where you are and what's
next before switching cuts that and helps the next task (Leroy 2009; Leroy & Glomb 2018, the
"ready-to-resume plan"). So Stop asks for that one line, and the next Start gives it back.

- **Save and stop** writes a `focus_log` row: the minutes from Start (rounded, 0–960), the note
  (trimmed to one line), the day the session started. Under a minute with a blank note writes
  nothing. The session ends; the task stays open.
- **Credit:** a task's credit is the minutes of its open `focus_log` rows: rows no closing row
  (`done = true`) lists in its `closes`. Its
  row in the week, Someday or a project, and in Plan today's list, reads "40m focused of 1h30"
  ("40m focused" without an estimate). The note isn't shown there.
- **The next Start** on the task shows "Where you left off: …" (the newest note among its open
  rows) under the title, and the line under the clock adds "· 1h05 on this task" (credit plus
  this session).
- **Done** in focus records the credit plus this session into `actuals` (still 1–960), so pace
  and estimate learning see the whole time the task took, and adds a `focus_log` row with
  `done = true` whose `closes` lists exactly the rows it counted; a row this page never read (a
  Stop on another device) stays open. If `focus_log` hasn't been read yet (offline since load),
  Done counts no earlier credit and writes no closing row. A task finished with the week's ✓ or Telegram keeps
  its credit rows but shows none (it is done); reopened, the old credit would show again.
- Writes go through the same outbox as Done (`{ op: "log", row }`), each row with an id made in the
  page, so a retry is a duplicate PostgREST skips. The credit shows at once, before the row saves.
- /plan reads the last 120 days of `focus_log` after the first load, and again on each sync and
  return online until a read lands; until the table exists (404) it reads none.

## Estimates against actuals

The planning fallacy (Buehler, Griffin & Ross 1994): guesses run short, and an overfull plan feeds
the sense that the list is out of control. Plan today shows his own history, never a fixed rule:

- `estimate-learning.mjs`: the median of `minutes / est_min` over his newest 30 `actuals` rows
  with an estimate, to one decimal, held to pace's 0.5–3×. Below **8 rows it shows nothing.**
- The line: "You usually take 1.4× your estimates (median of your last 12 finished tasks).
  Today's 4h of estimates is about 5h35." (the day's undone estimates, times the pace, to 5
  minutes). At 1.0× it reads "Your estimates have been about right (median of …)." and drops the
  day's part.
- It is informational only: blocks keep using per-kind pace (`pace.mjs`, gated at 5 per kind),
  and nothing changes an estimate for him.

## No double counting

Focus time and Telegram's Finished answer write the same `actuals` rows, which pace reads
unchanged. Only one of them ever counts a task:

- Done in focus calls **`record_focus`**, which writes nothing (and returns false) when the task is
  done or already has an actuals row from Start on. So a Finished tap in Telegram during the focus
  wins, and a retried Done never adds a second row.
- Done marks the task done right after, and Telegram's Finished? check skips done tasks and answers
  a late tap with "✓ Done" and no changes.

## Offline

The focus (block, task, Start and end, in epoch ms) is kept in `localStorage` (`sheet.focus`), so
the clock runs with no network and survives a reload. Done and +15 min queue their writes in
`sheet.focus.outbox`, run in order (the actuals row before the task's done) and stop at the first
failure; the rest are tried again on the next load and on the browser's `online` event, with a note
on /plan until they land. Each write is safe to repeat.

## Decided

- **Decided:** minutes are the time from Start to Done, not the block's span: that is the time
  actually spent, and it starts when he starts. Telegram's Finished keeps its block-based count.
- **Decided:** one running focus at a time, per browser. Starting on a phone and finishing on the
  laptop isn't covered (the session is local); the Telegram Finished answer still counts then.
- **Decided:** Undo after Done reopens the task but keeps its actuals row (only the server may
  delete them); a reopened task's next Done in focus records again only for time after that Start.
- **Decided:** the Telegram start nudge keeps its buttons. An "Open focus" link button there would
  change the start, repeat and snooze messages the v4 and v5 verification tests hold fixed, so it is
  left for later; the deep link above is ready for it (`${PLAN_URL}?focus=${b.id}`).

## Code

- `src/sheet/focus.mjs`: the logic (target, session, clock, actuals row, +15, outbox, Stuck text),
  tested in `test/focus.test.mjs`.
- `src/sheet/focus-start.mjs`: on /plan from the first load: the button, deep link, storage and
  retried writes.
- `src/sheet/focus-view.mjs`: the view, loaded on the first Start (a separate chunk, ~3 KB).
- `src/sheet/focus-notes.mjs`: Stop's row, Done's closing row and each task's credit, tested in
  `test/focus-notes.test.mjs`.
- `src/sheet/estimate-learning.mjs`: Plan today's estimates-against-actuals line, tested in
  `test/estimate-learning.test.mjs`.
- `src/styles/sheet-focus.css`.

## Schema

Additive, safe to re-run (also at the end of `supabase/schema.sql`):

```sql
create or replace function record_focus(task uuid, block uuid, d date, kind text, est int, minutes int, since timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'not the owner'; end if;
  perform 1 from tasks t where t.id = task and not t.done for update;
  if not found then return false; end if;
  if exists (select 1 from actuals a where a.task_id = task and a.at >= since) then return false; end if;
  insert into actuals (day, task_id, block_id, kind, est_min, minutes) values (d, task, block, kind, est, minutes);
  return true;
end $$;
revoke execute on function record_focus(uuid, uuid, date, text, int, int, timestamptz) from public, anon;
grant execute on function record_focus(uuid, uuid, date, text, int, int, timestamptz) to authenticated;
```

Stop's notes and credit (also at the end of `supabase/schema.sql`, "Focus notes"):

```sql
create table if not exists focus_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  day date not null,
  task_id uuid not null,
  block_id uuid,
  minutes int not null check (minutes between 0 and 960),
  note text check (char_length(note) between 1 and 280),
  done boolean not null default false,
  closes uuid[]
);
alter table focus_log add column if not exists closes uuid[];
create index if not exists focus_log_task_at on focus_log (task_id, at desc);
alter table focus_log enable row level security;
drop policy if exists owner_all on focus_log;
create policy owner_all on focus_log for all using (is_owner()) with check (is_owner());
revoke all on focus_log from anon;
```

## Deploy

1. In the SQL editor, run the `record_focus` block above, and the `focus_log` block.
2. Deploy the site. No Edge Function changes.

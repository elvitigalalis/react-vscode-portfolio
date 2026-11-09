# Focus mode

A Start button on today's current or next block in /plan opens a calm full-screen view for that
block: the task, its first step, a large countdown to the block's end with the time since Start,
and three actions. Terms are as in [GLOSSARY.md](../GLOSSARY.md); pace and actuals are as in
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
- **Back to plan** (or Escape) leaves the view; the timer keeps running and Resume brings it back.
- **Deep link:** `/plan/?focus=<block id>` opens the view for that block once the week loads (a
  focus already running is shown instead, so no counted time is lost).

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

## Deploy

1. In the SQL editor, run the `record_focus` block above.
2. Deploy the site. No Edge Function changes.

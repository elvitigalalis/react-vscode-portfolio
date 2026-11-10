# Habits as rates

The habits in Settings (gym, reading, a lunch walk; [sheet-v5.md](sheet-v5.md), H1) show under
the week on /plan, one row each: a ✓ for today, the last seven days as dots, and how many of its
last seven scheduled days it was done ("5 of last 7"). It is a rate, never a streak: one missed
day moves the number by one and nothing resets (research: broken streaks lower re-engagement,
rates degrade gracefully, and one miss doesn't derail a habit). Terms are as in
[GLOSSARY.md](../GLOSSARY.md).

## Data model (`supabase/schema.sql`, "Habits as rates"; additive, safe to re-run)

```sql
habit_done  habit_id uuid references habits on delete cascade, day date, created_at
            primary key (habit_id, day); owner-only (RLS owner_all), no anon, in no public view
```

One row means the habit was done that habit day. /plan writes it (upsert, ignore duplicates)
and deletes it on un-tick. The Gym habit (a name with gym, lift or workout) is also ticked by:

- **oura-sync and hevy-sync** (`_shared/gym-tick.ts`): each workout that finishes a Gym habit
  block (ring.mjs `gymDone`, the same match that ends the block) ticks it for the habit day the
  workout ended.
- **Finishing a session on /plan/gym** (gym-ui.mjs `markHabit`), block or not.

The telegram function reads it so the Gym start nudge skips a habit already ticked today.

## Rules (src/sheet/habit-rate.mjs, test/habit-rate.test.mjs)

- **The day turns at 4 am** local (`habitDay`): a 1 am tick counts for the day before. It holds
  across DST changes, since it reads the local clock rather than subtracting hours.
- **Dots:** the seven days ending today, oldest first: done (filled), a scheduled day gone by
  without it (an empty ring in the line colour, never red), today if scheduled and still open
  (an accent ring), and an off day (a small dot). A tick on an off day still shows as done.
- **Rate:** done on how many of the last seven scheduled days. Today counts only once done, so
  a day under way is never a miss. Counting starts the day after the habit was made (it was
  likely made partway through that day), or on that day if it was ticked then; days before
  never count, and nothing shows before its first counted day. A once-a-week habit
  looks back seven weeks.
- **"Back on it today?"** shows when the last scheduled day before today was missed and today is
  scheduled and still open. That is the only thing a miss changes; no "missed", "broke" or
  "lost" anywhere.
- **The ✓** fills at once (a short scale-in, under `prefers-reduced-motion: no-preference`
  only) and saves behind it; a failed save puts it back and shows the usual error.
- The section is hidden while there are no habits, reloads with the week and when Settings
  closes, and loads after first paint (a lazy import). /now never shows habits.

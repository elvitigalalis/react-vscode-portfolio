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

One row means he ticked that habit on that habit day. /plan writes it (upsert, ignore
duplicates) and deletes it on un-tick; nothing else reads it.

## Rules (src/sheet/habit-rate.mjs, test/habit-rate.test.mjs)

- **The day turns at 4 am** local (`habitDay`): a 1 am tick counts for the day before. It holds
  across DST changes, since it reads the local clock rather than subtracting hours.
- **Dots:** the seven days ending today, oldest first: done (filled), a scheduled day gone by
  without it (an empty ring in the line colour, never red), today if scheduled and still open
  (an accent ring), and an off day (a small dot). A tick on an off day still shows as done.
- **Rate:** done on how many of the last seven scheduled days. Today counts only once done, so
  a day under way is never a miss. Days before the habit was made never count ("1 of last 2"
  for a two-day-old habit; nothing at all before its first scheduled day). A once-a-week habit
  looks back seven weeks.
- **"Back on it today?"** shows when the last scheduled day before today was missed and today is
  scheduled and still open. That is the only thing a miss changes; no "missed", "broke" or
  "lost" anywhere.
- **The ✓** fills at once (a short scale-in, under `prefers-reduced-motion: no-preference`
  only) and saves behind it; a failed save puts it back and shows the usual error.
- The section is hidden while there are no habits, reloads with the week and when Settings
  closes, and loads after first paint (a lazy import). /now never shows habits.

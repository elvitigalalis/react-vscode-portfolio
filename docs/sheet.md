# Spec: The Sheet

A weekly to-do planner on lisul-elvi.com. Lisul plans his week on it, plans each day in five
minutes and closes each evening. Visitors see the same week with private tasks blacked out.

It takes the page from TeuxDeux and Tweek, the time slots from Ellie, the rituals from Sunsama
and Cal Newport's student system (one capture list, a five-minute morning plan, a shutdown).
Research that backs each choice is summarised under "Sources" at the end.

## Pages

| Path | Who | What |
|---|---|---|
| `/plan` | Lisul only (Google sign-in) | The planner. `noindex`, not in the sitemap. |
| `/now` | Everyone | The public week. `noindex` in v1, linked from the top bar as "Now". |

Both are pages of this Astro site, built and deployed like every other page. The home page and
write-ups do not change and keep their budgets (no third-party requests, ≤ 5 KB JS).

## Architecture

- **Storage: Supabase** (Postgres + Auth, free tier). The site stays static on GitHub Pages; the
  browser talks to Supabase's REST API directly. No server of our own.
- **Owner sign-in: Supabase Auth with Google.** Row-level security lets only Lisul's account
  (one email, set in config) read or write tasks.
- **Public data: two Postgres views** (`public_week`, `public_now`) readable by anyone. They
  return a private task's length, never its title, so private titles never leave the database.
- **Google Calendar: from the browser,** with the Google access token Supabase hands back at
  sign-in. Scopes: `calendar.app.created` (create and manage one "Time blocks" calendar) and
  `calendar.events.readonly` (show his real events in gray while planning). When the token
  expires (1 h) the planner asks him to sign in again; Google remembers consent, so it is one click.
- **The Sheet writes to Google, never reads its own blocks back.** The database is the source of
  truth for blocks; each block stores its Google event ID.
- **Rollover runs in the database** (`pg_cron`, hourly and idempotent, using the owner's time zone), so `/now` is
  right even on days Lisul never opens the planner.
- **Config** lives in `src/site.mjs` as `SHEET = { supabaseUrl, anonKey, ownerEmail, timeZone,
  publicTags }`; all public values. Empty `supabaseUrl` → both pages say "not set up yet".
- **Inactivity:** Supabase pauses free projects after a week with no requests. A GitHub Actions
  job (`sheet-keepalive.yml`) reads `public_now` twice a week to keep it awake.

## Data

```
tasks   id, title, day (date, null = Someday), list (Someday list name), position,
        est_min (null = no estimate), at_time (time, null = untimed), tag, public (bool),
        done (bool), rolls (int), created_at
blocks  id, task_id → tasks, starts_at, ends_at, gcal_id
days    day (date pk), planned (bool), shutdown (bool), reflection (text, never public)
```

A day is a plain local date string (`2026-10-20`), never a timestamp: Ellie's changelog is full of
tasks jumping days across time zones.

## The page (TeuxDeux, Tweek)

- **Seven equal day columns,** Monday to Sunday. Weekends are full size (a top Tweek complaint).
  Rows sit on 1px ruled lines and **line up across the week:** every column has as many rows as
  the busiest day plus one empty row.
- **Day header:** weekday in bold uppercase with slight letter-spacing, date beside it in muted
  text. **Today is marked by the accent colour only** (header text and its 2px rule).
- **Someday lists sit under the week:** named columns of undated tasks. They are the capture list
  and never roll over.
- **Done:** struck through and faded to 20 % opacity; it stays in place.
- **No notifications, badges or sounds.** Google Calendar does any reminding.
- Week navigation: `←` `→` change week, `T` (or the Today button) jumps to this week.
- Narrow screens (< 48 rem): one day at a time with previous/next buttons, Someday below. No
  page-wide horizontal scroll.
- The site's own colours, system fonts, light and dark mode. Motion is limited to 0.25 s opacity
  fades and is off under `prefers-reduced-motion`.

## Adding and editing (Tweek, Ellie, TeuxDeux)

- **Click an empty row, type, press Enter.** The task goes to the bottom of that day and the next
  row is ready. There is never a form.
- **Typed details,** shown as a chip while typing and stripped from the title on save:
  - `~45m` or `~1h30` → estimate
  - `@3pm` / `@15:00` → fixed time (the task stays on its day and never rolls)
  - `#workit` → tag; tags in `publicTags` make the task public by default
  - `!public` / `!private` → visibility, overriding the tag default
- **Default visibility is private.**
- Click a task to edit its title; a small menu (also on right-click and `.`) has: To today, To
  tomorrow, To next week, To Someday, Public/Private, Delete. This menu is also the keyboard and
  screen-reader way to do everything drag does.
- **Drag** a task within a day, between days, or to and from Someday (Pointer Events, so it works
  on touch). The dragged task leaves a 25 % ghost.
- **Hover** shows a check circle at the row's right end; clicking it completes the task.
- **Undo** (a toast for 6 s, and `⌘Z`) after delete, complete and every move.

## Rollover (Tweek, Sunsama, Ellie, DayDrift)

- Each night, every task that is **undone, untimed and dated before today** moves to today and
  its `rolls` count goes up by one.
- The task shows a small circled count (②, ③), and its text fades a step with each roll.
- **On the 4th roll it goes back to Someday** (list "Inbox") with `rolls` reset, and today shows
  one muted line: "2 tasks moved to Someday". No dialog.
- Tasks with a fixed time, done tasks and Someday tasks never roll.

## Plan today: `P` (Newport, Ellie, Sunsama)

Opens over the week: today's tasks on the left, today's timeline on the right (07:00 to 23:00,
15-minute snap) with his Google events in gray.

- **Load meter** in the header: `3h20 / 5h30`, the sum of today's undone estimates against the
  daily capacity (default 5 h 30). Amber within 15 % of capacity, red over it.
- **Finish line:** "Done ≈ 4:40 pm · shutdown 5:00 pm". The shutdown line on the timeline can be
  dragged; it is saved per day.
- **Drag a task onto the timeline → a block as tall as its estimate** (30 min if none). The block
  is created as an event on the "Time blocks" Google calendar: its title is the task's title if
  public, **"Busy" if private** (Ellie's privacy mode). One task may have several blocks.
- **Resizing a block writes the new length back to the estimate** and the meter updates at once.
- `D` sends the focused task to tomorrow, `Z` to Someday.
- Opening it after 3 pm plans tomorrow instead.
- "Done" closes it and marks the day planned.

**Block rules** (Sunsama): The Sheet only ever edits events it created. Completing a task during
its block shrinks the block to end now; completing it before the block starts deletes the block.
Deleting a task deletes its blocks. Moving a task to another day deletes its blocks. Removing a
block never deletes the task. Changing one block never moves another.

## Shutdown: `O` (Newport, Ellie, Sunsama)

The "Shut down" button appears on today's header from two hours before shutdown time (`O` works
any time).

1. Two columns, **Done** and **Missed**. Clicking a task moves it to the other column.
2. One box: *What went well, what got in the way?* (private, always).
3. **Finish:** nothing is saved before this. Missed tasks move to tomorrow (counted as a roll),
   the day is marked shut down and gets a "Shutdown complete" stamp.

A skipped shutdown costs nothing: the nightly rollover does the same move.

## The public view: `/now`

- The same week, read-only. **Public tasks show their title** (struck through when done).
  **Private tasks show as a black bar the length of their title** (capped at the column width).
- **"Right now"** above the week: during a block of a public task, that task's title; during a
  private task's block, "Heads down"; otherwise nothing. It refreshes every minute.
- Each day can carry **"Planned ✓"** and **"Shut down ✓"** stamps. No times.
- A done public task whose tag matches a write-up (`#workit`, `#micromouse`) links to it.
- A handwritten-style margin note in the site's own type: *P.S. the black bars are life stuff.*
- **Never shown:** times, estimates, Someday lists, rollover counts, reflections, Google events,
  streaks, totals. "Last updated" shows the date only.
- One small reward when every task today is done: the day's header gets a check mark (no
  animation).

## Out of scope for v1

Recurring tasks, notes, subtasks, priorities, more than one tag per task, weekly review, focus
mode, AI, auto-scheduling, notifications, sharing links, reading Google changes back, month view,
a native app.

## Quality bar

- Every existing gate passes. `/plan` and `/now` pass html-validate and axe (WCAG 2.2 AA) and
  are excluded from the sitemap.
- Lighthouse entry for `/plan` and `/now`: performance ≥ 0.95, accessibility 1, best practices 1,
  `is-crawlable` off (they are `noindex`), script ≤ 60 KB, at most 1 third-party origin (Supabase).
  The home and write-up budgets are unchanged.
- The logic that decides things (typed-detail parser, rollover, load meter, block rules, public
  redaction) is plain modules in `src/sheet/` with `node --test` tests.
- Keyboard: every action has a key or menu route; `?` lists them.

## Setup Lisul does once

1. Create a Supabase project. In `supabase/schema.sql`, replace `you@example.com` with the
   Google account he will sign in with, then run the file in the project's SQL editor.
2. Google Cloud: create an OAuth client (type "Web application") with Supabase's callback URL
   (`https://<project>.supabase.co/auth/v1/callback`) as its redirect URI. On the consent
   screen, add the scopes `calendar.app.created` and `calendar.events.readonly`, and add
   himself as a test user.
3. Supabase → Authentication → Providers: enable Google with that client's ID and secret.
   Authentication → URL Configuration: add `https://www.lisul-elvi.com/plan/` (and
   `http://localhost:4321/plan/` for local work) to the redirect URLs.
4. Put the project URL and anon key in `SHEET` in `src/site.mjs`, push, and sign in at `/plan`.

## Sources

Feature teardowns (help centres, changelogs, Hacker News threads, App Store reviews), October
2026: Tweek (help.tweek.so, HN 33641036), TeuxDeux (support.teuxdeux.com, its stylesheet,
swiss-miss.com), Ellie (guide.ellieplanner.com, feedback board vote counts), Sunsama
(help.sunsama.com, HN 24990238). Cal Newport: *How to Become a Straight-A Student*, Deep
Questions episodes 166, 312 and 348, calnewport.com. Privacy patterns: Terence Eden's public
calendar post, WIP.co, Aaron Parecki's /now, Google Calendar free/busy docs.

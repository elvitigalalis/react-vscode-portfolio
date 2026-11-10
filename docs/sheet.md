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
| `/now` | Everyone | The public week. `noindex` in v1, linked from the footer as "Now". |

Both are pages of this Astro site, built and deployed like every other page. The home page and
write-ups do not change and keep their budgets (no third-party requests, ≤ 5 KB JS).

## Architecture

- **Storage: Supabase** (Postgres + Auth, free tier). The site stays static on GitHub Pages; the
  browser talks to Supabase's REST API directly. No server of our own (version 2 adds one Edge
  Function for Telegram; see [sheet-nudges.md](sheet-nudges.md)).
- **Owner sign-in: Supabase Auth with Google.** Row-level security lets only Lisul's account
  (one email, set in config) read or write tasks.
- **Public data: two Postgres views** (`public_week`, `public_now`) readable by anyone. They
  return a private task's length, never its title, so private titles never leave the database.
- **Google Calendar: from the browser,** with the Google access token Supabase hands back at
  sign-in. Scopes: `calendar.app.created` (create and manage one "Time blocks" calendar) and
  `calendar.events.readonly` (show his real events in gray in the week and while planning). The
  token lasts an hour and Supabase never refreshes it, so after that /plan gets one from the
  server's calendar grant (calendar-connect's `/token`, docs/sheet-v5.md). Only when neither
  works does the week keep the last copy of its events (kept in his browser, cleared on
  sign-out) and offer "Reconnect Google Calendar in Settings".
- **The Sheet writes to Google, never reads its own blocks back.** The database is the source of
  truth for blocks; each block stores its Google event ID.
- **Rollover runs in the database** (`pg_cron`, hourly and idempotent, using the owner's time zone), so `/now` is
  right even on days Lisul never opens the planner.
- **Config** lives in `src/site.mjs` as `SHEET = { supabaseUrl, anonKey, ownerEmail, timeZone,
  }`; all public values. Empty `supabaseUrl` → both pages say "not set up yet".
- **Inactivity:** Supabase pauses free projects after a week with no requests. A GitHub Actions
  job (`sheet-keepalive.yml`) reads `public_now` twice a week to keep it awake.

## Data

```
tasks   id, title, day (date, null = Someday), list (Someday list name), position,
        est_min (null = no estimate), at_time (time, null = untimed), tag, public (bool),
        done (bool), rolls (int), due (date, null = none), created_at
blocks  id, task_id → tasks, starts_at, ends_at, gcal_id, proposed (bool: Claude's, not yet approved)
days    day (date pk), planned (bool), shutdown (bool), reflection (text, never public)
settings  owner_email, gcal_calendar_id ("Time blocks"), calendars (extra calendar IDs to read)
```

A day is a plain local date string (`2026-10-20`), never a timestamp: Ellie's changelog is full of
tasks jumping days across time zones.

## The page (TeuxDeux, Tweek)

- **Seven equal day columns,** Monday to Sunday. Weekends are full size (a top Tweek complaint).
  Rows sit on 1px ruled lines and **line up across the week:** every column has as many rows as
  the busiest day plus one empty row. A long title wraps onto more lines, never cut off; on wide
  screens its row grows in every column, so the lines stay level (also on /now).
- **Day header:** weekday in bold uppercase with slight letter-spacing, date beside it in muted
  text. **Today is marked by the accent colour only** (header text and its 2px rule).
- **His calendar sits above each day's tasks** (Things 3, Todoist): small and gray, each event
  as its time range ("8–9:20 am") over its full name, all-day events first, then by time.
  Read-only; a click opens the event in Google. Events that have ended today fade. Past four,
  the rest fold into "+N more" (ended ones fold first). On wide screens the columns share grid
  rows, so the busiest calendar sets where every day's tasks start and task lines stay level.
  Events come from his main calendar plus any extra calendar IDs he pastes into **Calendars** (Settings, Accounts).
  They are read in his browser and never saved to the database, so `/now` never sees them.
- **Day load chip:** the day's undone estimates. Its budget is 5 h 30, or less when his events
  leave less free time between 9:30 am and 10 pm (today: from now). Then it reads `2h45 / 3h10`.
  All-day events and events marked free in Google don't count. Amber within 15 %, red over.
- **Clash mark:** an `@3:45` task that lands inside a busy event shows ⚠ ("Clashes with …").
- **The Log sits under the Someday lists:** a closed section holding finished Someday tasks, newest
  first. Completing one moves it there; ↺ puts it back on its list.
- **Habits sit under the week** ([sheet-habits.md](sheet-habits.md)): a ✓ for today, the last
  seven days as dots and "5 of last 7 sessions", a rate rather than a streak.
- **Someday lists sit under the week:** named columns of undated tasks. They are the capture list
  and never roll over.
- **Done:** struck through and faded to 20 % opacity; it stays in place.
- **Progress** (src/sheet/progress.mjs): counts that say what got done, never points, levels,
  streaks or anything a miss takes away. Today's header line reads "3 of 7 done · 1h40 focused"
  after a small accent ring that closes as today's tasks get done; the focused half (the minutes of
  today's focus sessions: each `focus_log` row's own minutes, Stops and Dones, plus a Done made
  before `focus_log` was read; [sheet-focus.md](sheet-focus.md)) shows only when there is some, and an empty day shows
  nothing. No head start is faked. The week title adds the tasks finished that week by done_at
  ("Week of Nov 9 · 14 done", nothing at 0), Someday ones included. Phones hide the title, so
  there the shown day says "14 done this week" under its stamps.
- **Also did…** under today's "+ Add a task": typing an unplanned win and Enter logs it as a task
  already done today, so it counts. Undo removes it.
- **No badges.** Reminders come from Telegram ([sheet-nudges.md](sheet-nudges.md)). The only sound
  is the optional completion tick (below), off by default.
- Week navigation: `←` `→` change week, `T` (or the Today button) jumps to this week.
- Narrow screens (< 48 rem): one day at a time with previous/next buttons, Someday below. No
  page-wide horizontal scroll.
- The site's own colours and fonts (Fraunces headings, Inter text), light and dark mode, including the top bar's switch. Motion is limited to 0.25 s opacity
  fades, the check-off below and the progress ring closing a step (400 ms), all off under `prefers-reduced-motion`.

### Saving in the background

A tap changes the page at once; the network never stands between a tap and what it does
(src/sheet/optimistic.mjs). Measured on a slow mocked API (writes 800 ms, CPU 4×), a ✓ settles
in about 0.4 s instead of 3.6 s, and a move, reopen or new task shows in under 0.1 s.

- **What:** ✓ and ↺ (tasks and event to-dos), moves (the menu, keys, swipes, drag), edits and
  deletes show at once and save behind it. A typed task shows as a muted row at once and becomes
  a normal row when its save lands; the box is free for the next one meanwhile, and its words
  survive the redraw.
- **Order:** a row's saves run one after another, in the order they were made, so ✓ then ↺
  leaves it open on the server too.
- **Failure:** the row goes back to what the server holds and says "Not saved" under its title
  ("Not deleted" for a delete, which also reloads the week; a failed new task: "Not added" by its
  box, and the words go back in the box if it's empty), and the status line names it with Retry,
  as before. The note stays until the row's next change. A save that finds its task deleted
  elsewhere takes the row away instead, with no message.
- **Deletes stay deleted:** a save still out for a deleted task lands without bringing it back,
  and a reload that read before the delete leaves it out.
- **Reloads:** a reload that read before a save landed keeps what the save wrote, and one that
  reads while a save is out shows the change on top, so the page never flips back.
- **Undo** belongs to the action that made it: a save that lands after a newer action's toast has
  shown offers no Undo, and Undo goes back to the row as the server last confirmed it, not to a
  change still saving or one that failed.
- An edit in place is never redrawn under the cursor: a save that lands meanwhile redraws when
  the edit ends.

### Opening

- **The last copy first:** after each load of this week, /plan keeps a short-lived copy of the
  week in this browser (`sheet.snapshot.v1`), with the signed-in user's id: tasks, blocks, days,
  event to-dos, horizon rows, today's focus minutes and the settings the week reads. No Oura data
  at all, no calendar IDs, no keys or Telegram IDs. On opening, the copy draws at once with
  "Updating…" in the status line, only for the user who stored it (when the token doesn't say
  who is signed in, only once settings shows the account can open the planner, and it is out of
  storage meanwhile). Then the normal load replaces it. A copy that can't be drawn is thrown
  away and the page loads as usual.
- **Changes made on the copy** show at once and save after the first load, so what they save
  (a block to shorten or delete) comes from the fresh rows.
- If the load fails, the status line says the page is the week as last seen, until a load works.
- **It goes** on signing out, when the session has run out, and for an account that can't open
  the planner (which sees nothing of the page).
- **Google's events load beside the tables,** never before the first draw: the week draws with
  the events kept from last time and redraws when Google answers, only if they changed.
- **Coming back** (a reload after a minute away) redraws only when something read has changed;
  the Oura poll already did. Projects and habits still read their own rows again then. A refresh
  of the projects list redraws only that list.

### Completion

Checking something off should feel good every time without getting old (src/sheet/celebrate.mjs).

- **Every ✓** (a row's ✓, X or Space, a swipe, Now/Next ✓, focus Done, an event to-do): the old row
  shows done at once, before the save ends. The ✓ springs (1 → 1.18 → 1, 350 ms) and draws itself
  (250 ms), a strike runs through the title left to right (250 ms, line by line when it wraps) and
  the words go muted. The page redraws when the animation is over, whether or not the save has
  landed (below, "Saving in the background"); any other redraw meanwhile (a reload on coming back,
  say) waits and runs once after. Focus mode's Done still waits for its own save (at most 4 s).
  Reopening (↺) has no motion; taps on the same row within 0.3 s of a ✓ are a double tap and do
  nothing.
- **A Someday row** then fades out and the rows under it slide up (transform only); the Log's count
  pops.
- **A burst when it means something:** eight specks in the site's greens and amber fly from the ✓
  (about 550 ms) on the day's first ✓ (no task has a done_at today yet; once a day, however often
  it is tapped or reopened), a task carried over at least twice, a task focus Done finished
  before its estimate ran out, or the third ✓ within ten minutes. Never by chance, and never from
  a key.
- **Big moments:** a Brightspace task (an assignment), or the last open task of today. Confetti for
  1.2 s on one canvas, loaded only then, and the Undo toast reads "Assignment done." or "Day
  cleared." before "Done: …". Clearing the day also pops the header's ✓.
- **Shutdown complete** and **Approve / Approve all** in Plan today get the small burst.
- **Sound:** Settings, Day, "Completion sound": two quiet rising notes per ✓, a soft chord for a
  big moment. Off by default, kept in this browser, silent under the iPhone's silent switch.
- **Reduced motion:** no spring, strike, specks, confetti or slide; the row fades to done in
  150 ms and the toast's words stay. Effects never take input (`pointer-events: none`) and
  nothing lasts past 1.5 s.

## On the phone

Under 48 rem, one day shows at a time (above). On top of that:

- **Doing view** (Llama Life's one thing now, Tiimo's visual timer; src/sheet/doing-view.mjs,
  logic in doing.mjs). During his day (from the day's start, 30 minutes after his wake or 9:30 am
  without Oura, to the shutdown line, not shut down) a phone opens to one card instead of the week, so the crowded today stamps
  (Now/Next, load bar, strip, Oura, progress, wind-down) and the sections under the week (school
  load, habits, projects, Someday, the Tell Claude box) are out of sight until he asks for them.
  - The card is the task a focus session is running on ("Focusing"), else the open row on now
    ("Now · until 10:45 am", an event too), else the next to start ("Next · 1–2 pm"), else the
    first untimed task ("Up next"). A row that ended undone isn't shown: Reflow rest of today is
    for those, and its line shows on the card when there is something to move.
  - For a session or the row on now, a small ring that empties as its time runs out and "25 min
    left", redrawn every 15 seconds. Under the title, the block's first step or where he left off.
  - **Start** (or **Resume**) opens focus mode on the task's block today ([sheet-focus.md](sheet-focus.md):
    the large shrinking ring, chimes, the screen kept on). **Done** completes it with the usual
    check-off and Undo, and the card moves on.
  - Below the card, "Then": the next two (timed rows still to start, then untimed tasks), each
    with its time. **See the week** shows the week; today's stamps then start with a **Doing view**
    link back. His pick holds for the rest of the day (kept in this browser), and the top bar's
    day arrows and day button also go to the week. Each load of the week (opening, coming back,
    changing week) chooses again, so the default never flips while he is using the page. The
    stored copy of the week chooses too, before it draws (the first draw waits up to a second for
    the module on a phone, but not the first reads), and the load opening the page makes right
    after it keeps that choice (a later load, after that one failed offline, chooses again);
    until a choice is made the week stays hidden on a phone, so neither view flashes before the
    other. Reflow waits for
    fresh rows: it never moves blocks worked out from the stored copy.
  - Outside his day, with nothing open today, or on a wider screen, the week shows as before.
    It loads only on a phone, after the first load.

- **To-dos first.** Today's list sits right under the top bar. The Tell Claude box and Recent
  messages come after the day, before Someday, as one line until the box is in use; the
  "characters left" count shows only within 500 of the limit. A laptop keeps the box on top.
- **Now/Next** (every width): one quiet line under today's header, "Now: OS homework until 3:30
  pm ✓ · Next: Gym 5:30 pm", from the rows already loaded (timed tasks and event to-dos, not done).
  In an overlap the row that started last is Now. ✓ completes it, with Undo. Redrawn each minute.
- **Details…** in a task's ⋯ menu: an estimate (presets 15m to 2h, or minutes), a native time
  and date picker, and a tag, each with Clear. It is the only way to clear an estimate or a
  fixed time (typed syntax only adds details). A Someday task has no fixed time field. One Undo
  puts every field back. Every width.
- **Swipes** (touch screens only; the module loads only there):
  - On an open row: right is Done (a task or an event to-do), left is Tomorrow (a task on a
    later day: Next day; an event: nothing). A row commits past 35 % of its width (at most
    96 px) and says what will happen before you let go; shorter swipes spring back. Undo is the
    usual toast.
  - Anywhere else in the day (the heading, Now/Next, an add row, a done row): left is the next
    day, right the previous, past 60 px and at least twice as sideways as down, like the arrows.
  - Who wins: **by axis**, CSS `touch-action: pan-y` on the lists leaves every vertical pan to
    the browser, and a move counts as sideways only at 1.5× its vertical part after 10 px; **by
    hold**, holding still 300 ms picks a task up to drag (as before), and a finger that moved
    first drops the hold; **by where it starts**, an open row takes its own swipe, so a day swipe
    starts outside one. Not from the left 24 px (Safari's back swipe), with two fingers or zoomed
    in. A tap just after a swipe is ignored.
  - The arrows, ✓ and ⋯ stay: swipes only speed up what the visible buttons already do (NN/g).

## Adding and editing (Tweek, Ellie, TeuxDeux)

- **Click an empty row, type, press Enter.** The task goes to the bottom of that day at once and
  the next row is ready (above, "Saving in the background"). There is never a form. The box grows as a long title wraps, while adding and
  editing. Enter (with or without Shift) saves and Escape cancels an edit. A title is one line
  of text: line breaks in pasted text become spaces, and it is cut at 500 characters, so Google
  events, Telegram nudges and /now's bars never see a break.
- **Typed details,** shown as a chip while typing and stripped from the title on save:
  - `~45m` or `~1h30` → estimate
  - `@3pm` / `@15:00` → fixed time (the task stays on its day and never rolls)
  - `#workit` → tag
  - `!p` (or `!private`) → private; `!public` makes it public again when editing
  - `^fri`, `^10/30` or `^tomorrow` → due date, counted from the task's day (today for Someday):
    a weekday or month/day is its next occurrence on or after that day. It shows as "due Fri"
    (⚠ when at risk; a proposed block doesn't clear that until approved), typing a new one changes it, and the menu's "Clear due date" removes it.
    /now never shows it ([sheet-nudges.md](sheet-nudges.md)).
- **Tasks are public by default.** Private ones carry a small "private" label in the planner.
- Click a task to edit its title; a small menu (also on right-click and `.`) has: To today, To
  tomorrow, To next week, Day before, Day after, To Someday, Public/Private, Clear due date (when
  it has one), Delete. A task carried over twice or more leads with where it could go
  (Rollover). This menu is also the keyboard and screen-reader way to do everything drag does.
- **Drag** a task within a day, between days, or to and from Someday (Pointer Events). On touch,
  hold a task for 0.3 s to pick it up, so a swipe still scrolls. The dragged task leaves a 25 % ghost.
- **Hover** shows a check circle at the row's right end; clicking it completes the task.
- **Undo** (a toast for 6 s, and `⌘Z`) after delete, complete and every move.

## Rollover (Tweek, Sunsama, Ellie, DayDrift)

- Each night, every task that is **undone, untimed and dated before today** moves to today and
  its `rolls` count goes up by one.
- The task shows a neutral "carried over" tag in its details, the same at every roll; the count
  is only in the tag's hover text. Its title keeps full ink: a rolled task isn't made to look worse.
- **Where it could go:** a task carried over twice or more opens its menu with "Carried over a few
  times. Where should it go?" and Tomorrow, Later this week (the week's last day, when that is
  past tomorrow), Someday and Drop. Drop never deletes: the task moves to the Someday list
  "Dropped", with Undo, and can be dragged back any time. Any move to a Someday list resets
  `rolls` to 0 (Undo restores it), so the look-back and shutdown stop counting it as moving.
  A dropped task is out of play everywhere else too (`isDropped`, logic.mjs): Claude's
  `read_planner`, the horizon, the week's school load and Telegram's brief, check-in and
  warnings leave it out.
- **On the 4th roll it goes back to Someday** (list "Inbox") with `rolls` reset, and today shows
  one muted line: "2 tasks moved to Someday". No dialog.
- Tasks with a fixed time, done tasks and Someday tasks never roll.
- Proposed blocks of earlier days are deleted: a proposal lapses at the end of its day.

## Over-commit note (Sunsama, Akiflow)

- When today's planned minutes (undone estimates, plus what is left of blocks no estimate
  counts, such as habit blocks) are more than the day's capacity (the free time left before
  shutdown, held to the workload cap: the same number as Plan today's header), today shows one
  calm line under its strip in muted ink: "Planned 9h · about 6h free · Move some to tomorrow",
  or "room for about 8h" when the cap is the smaller. The capacity is rounded to a quarter hour
  before comparing, so the line never reads "Planned 6h · about 6h free".
- "Move some to tomorrow" opens a list of today's undone untimed tasks under the line (no
  fixed time, no block); a tap moves one to tomorrow, with the usual Undo. The line goes away
  once the plan fits: the Undo toast then reads "Moved. Plan fits now." and takes focus.
- It warns and never blocks: nothing is moved for him, and adding more still works.
- Past the day's shutdown, or once the day is shut down, it doesn't show. Blocks count only up
  to shutdown.

## Readiness note (RISE, Oura guidance)

- When today's Oura readiness (its sleep_days row) is under 70, below Oura's "good" band and
  the same line the lighter-day cap uses, today shows one calm line under its strip in muted
  ink, never red: "Readiness 64 today · consider a lighter day · Move some to tomorrow ·
  Dismiss". The threshold and the sentence are fixed.
- "Move some to tomorrow" (the over-commit note's words) opens that note's list of today's
  undone untimed tasks; a tap moves one to tomorrow, with the usual Undo. When the over-commit note shows, it already
  offers that list, so this line leaves its link out.
- "Dismiss" hides it for the rest of the day in this browser (localStorage). It comes back only
  on another low day. Past shutdown, or once the day is shut down, it doesn't show.
- It is worked out in the browser only (src/sheet/readiness-note.mjs). Per
  [ADR 0005](adr/0005-oura-data-never-reaches-claude.md) no Supabase function, read_planner,
  proposal or Telegram path imports it, and test/readiness-note.test.mjs checks that.

## Reflow rest of today (Structured's Replan, Tiimo's reshuffle)

- When today's plan has slipped, today's stamps row (and the phone's Doing card) shows one muted
  line: "Reflow rest of today · 2 blocks to move". A block has slipped when it ended and its task
  is still open, or when it starts later but now clashes with a busy event or another block.
- One tap lays those blocks after now, with no AI (src/sheet/reflow.mjs): each keeps its length
  and their old order, starts on a 5-minute mark at the first free time after the one before
  (a later block never moves earlier), and stays clear of busy Google events (not all-day or
  free ones), every block that stays put and the shutdown line. What stays put: a block running
  now, the one a focus session is on, habit blocks, done tasks' blocks, blocks of a task with
  a fixed time (`@3pm`) and a later block already planned past shutdown (it isn't reported as
  one that didn't fit). Proposed blocks take no time, as for +15 min in focus.
- Each move saves as a drag in Plan today does (`saveBlock`): the block's Google event moves too,
  and a moved block is his, so no revision moves it again.
- The Undo toast is the receipt: "Reflowed: OS homework 4:30 pm, Email advisor 6 pm." plus
  "Didn't fit before shutdown: Essay." for any that stayed where they were. One tap on Undo
  puts every moved block back.
- Past shutdown, or once the day is shut down, the line doesn't show.

## Plan today: `P` (Newport, Ellie, Sunsama)

Opens over the week: today's tasks on the left, today's timeline on the right (07:00 to 23:00,
15-minute snap) with his Google events in gray.

- **Load meter** in the header: `3h20 / 5h30`, the sum of today's undone estimates against the
  day's budget (5 h 30, or the free time around his events, as in the week). Amber within 15 %
  of it, red over it.
- **Estimates against actuals:** once 8 finished tasks have an estimate and an actual time,
  one line under the meter: "You usually take 1.4× your estimates (median of your last 12
  finished tasks). Today's 4h of estimates is about 5h35." Below 8 it shows nothing
  ([sheet-focus.md](sheet-focus.md), "Estimates against actuals"). A task Stopped sessions have
  credited reads "40m focused of 1h30" in the list.
- **Finish line:** "Done ≈ 4:40 pm · shutdown 5:00 pm". The shutdown line on the timeline can be
  dragged; it is saved per day. Undragged, it sits where wind-down starts (5 pm to 11 pm), else at
  5 pm ([sheet-v5.md](sheet-v5.md), "Shutdown follows wind-down").
- **Over-commit note:** the same line as on the week's today ("Over-commit note" above), under
  the meter, for the day being planned; its list moves a task a day on.
- **Drag a task onto the timeline → a block as tall as its estimate** (30 min if none). The block
  is created as an event on the "Time blocks" Google calendar: its title is the task's title if
  public, **"Busy" if private** (Ellie's privacy mode). One task may have several blocks.
- **Resizing a block writes the new length back to the estimate** and the meter updates at once.
  Dragging a block's body moves it and keeps its length (mouse only: on touch it scrolls).
- **Proposed blocks** ([sheet-nudges.md](sheet-nudges.md)) show as dashed outlines with an
  **Approve** button, and the header reads "Claude proposed 3 blocks, shown dashed. Approve
  all". Approving creates the block's Google event, exactly as dragging a task does; moving or
  resizing a proposed block approves it too, and × turns it down. In the week, each one shows
  dashed under its task with its time and Approve. A proposal has no Google event and never
  reaches /now; one never approved lapses at shutdown or the nightly rollover.
- `D` sends the focused task to tomorrow, `Z` to Someday. A block can be focused: `↑` `↓` move
  it 15 minutes, `A` approves a proposed one, and `Shift+A` approves all.
- It plans today while today has time left before shutdown, and tomorrow once shutdown has
  passed or the day is shut down. (The morning routine still plans tomorrow from 3 pm.)
- "Done" closes it and marks the day planned.

**Block rules** (Sunsama): The Sheet only ever edits events it created. Completing a task during
its block shrinks the block to end now; completing it before the block starts deletes the block.
Completing a task turns down its proposed blocks.
Deleting a task deletes its blocks. Moving a task to another day deletes its blocks. Removing a
block never deletes the task. Changing one block never moves another.

## Shutdown: `O` (Newport, Ellie, Sunsama)

The "Shut down" button appears on today's header from two hours before shutdown time (`O` works
any time).

1. Two columns, **Done** and **Tomorrow**. Clicking a task moves it to the other column.
2. One box: *What went well, what got in the way?* (private, always).
3. **Finish:** nothing is saved before this. Tasks left in Tomorrow move to tomorrow (counted as a roll),
   the day's unapproved proposed blocks are deleted, and the day is marked shut down and gets a
   "Shutdown complete" stamp.

A skipped shutdown costs nothing: the nightly rollover does the same move.

## The public view: `/now`

- The same week, read-only. **Public tasks show their title** (struck through when done).
  **Private tasks show as a black bar the length of their title** (capped at the column width).
- **"Right now"** above the week: during a block of a public task, that task's title; during a
  private task's block, "Heads down"; otherwise nothing. Proposed blocks never count. It
  refreshes every minute.
- Each day can carry **"Planned ✓"** and **"Shut down ✓"** stamps. No times.
- A done public task whose tag matches a write-up (`#workit`, `#micromouse`) links to it.
- A handwritten-style margin note in the site's own type: *P.S. the redacted bars are life stuff.*
- **Never shown:** times, estimates, due dates, Someday lists, rollover counts, reflections, Google events,
  streaks, totals. "Last updated" shows the date only.
- One small reward when every task today is done: the day's header gets a check mark (no
  animation on /now; /plan's check-off is in "Completion" above).

## Out of scope for v1

AI proposals and notifications came in version 2: [sheet-nudges.md](sheet-nudges.md).


Recurring tasks, notes, subtasks, priorities, more than one tag per task, weekly review, focus
mode, auto-scheduling, sharing links, reading Google changes back, month view,
a native app.

## Quality bar

- Every existing gate passes. `/plan` and `/now` pass html-validate and axe (WCAG 2.2 AA) and
  are excluded from the sitemap.
- Lighthouse entry for `/plan` and `/now`: performance ≥ 0.95, accessibility 1, best practices 1,
  `is-crawlable` off (they are `noindex`), script ≤ 60 KB, a few requests to one third-party origin (Supabase).
  The home and write-up budgets are unchanged.
- The logic that decides things (typed-detail parser, rollover, load meter, block rules, public
  redaction) is plain modules in `src/sheet/` with `node --test` tests.
- Keyboard: every action has a key or menu route; `?` lists them.

## Setup Lisul does once

`bash tools/sheet-setup.sh` walks through these steps one screen at a time, checks each one
worked, and writes the values into `src/site.mjs`.

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

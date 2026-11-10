# Spec: /plan at a glance

The Sheet's fourth version, part two: /plan reads at a glance instead of as rows of small grey
words. Today every detail is a word at the same size: the estimate, the time, the due date,
private, proposed, the source, the Telegram state and the feed state. No source looks different
from another, and time and load are written as numbers instead of drawn. This spec adds:
- one icon set;
- one colour per source, always paired with an icon;
- a drawn load bar and free-time strip;
- clearer proposals;
- a calmer top bar.

It also fixes the bug where a task title collapses to one letter per line. Research (2026-11-03:
screenshots of the current page, Things 3, Akiflow, Sunsama, Motion, Structured, NN/g, WCAG)
is summarised under "Why" in each section. Terms are as in [GLOSSARY.md](../GLOSSARY.md);
the base spec is [sheet.md](sheet.md).

## Contracts

### Pure functions (`src/sheet/glance.mjs`, new; `node --test` covers them)

- `sourceOf(task)` returns:
  - `'course'` when `source === 'brightspace'`;
  - `'campus'` when `tag === 'campus'`;
  - otherwise `null`.
- `campusSummary(events)` returns `{ n, food }`: how many events, and how many with free food
  (`freeFood` in campus.mjs).
- `dueLevel(task, blocks, today, timeZone)` returns:
  - `'overdue'`: undone, and `due` is before `today`;
  - `'risk'`: `atRisk` holds and it isn't overdue;
  - otherwise `null`. A done task is always `null`.
- `loadShare(minutes, capacity)` returns `{ pct, level }`.
  - `pct` is `round(100 × minutes / capacity)`, capped at 100 for drawing.
  - `level` is `load`'s rule: `'over'` above capacity, `'near'` from 85 %, else `'ok'`.
  - A capacity of 0 gives `{ pct: 100, level: 'over' }` when minutes > 0, else `{ pct: 0, level: 'ok' }`.
- `stripSegments(events, blocks, day, timeZone, from = 7 * 60, to = 23 * 60)` returns
  `[{ from, to, kind }]`:
  - `from` and `to` are percentages of the window, rounded to 0.1;
  - `kind` is `'busy'` (a calendar event), `'block'` (an approved block) or `'proposed'`;
  - it is sorted by `from`;
  - parts outside the window are clipped, and anything entirely outside is dropped;
  - all-day events (`allDay`) and events marked free (`busy === false`) are left out. Events
    have the shape `loadEvents` in api.mjs returns.
- `feedAlert(feedRows)` returns the sources whose `ok === false`, as `['campus']` for example,
  or `[]`.

### The icon set

- **Format:** an inline `<svg>` sprite of `<symbol id="i-…">` elements in `plan/index.astro`,
  drawn from Lucide (ISC). Its licence notice is kept as one HTML comment.
- **Icons:** `lock`, `clock`, `flag`, `alert-triangle`, `graduation-cap`, `ticket`,
  `utensils`, `sparkles`, `bell`, `bell-off`, `circle-check`, `circle-alert`, `mail`, `check`,
  `more-horizontal`, `chevron-left`, `chevron-right`.
- **The helper:** `icon(name, label?)` in planner.mjs builds `<svg aria-hidden="true"
  class="sheet-icon"><use href="#i-name"></svg>` with `createElementNS`, never innerHTML.
  - With a `label`, the icon gets `title` text for hover, and the row's `aria-label` still
    carries the words.
  - Icons use `currentColor`, drawn in `--muted`, `--accent`, `--warn` or `--danger`, which
    all meet 3:1 or better.
- `?` help gets a short legend of what each icon means.

## Changes

1. **Rows never collapse.**
   - A task title always gets at least 8 characters of width.
   - When a row's details don't fit beside the title, they move to a second line in 0.75rem.
     This happens through a container query on the day column.
   - A row with a proposal puts the proposal on its own line.
   - *Why:* at 1440 px, "OS homework" rendered one letter per line once the row carried an
     estimate, a due date, private and a proposal.
2. **Icons instead of words.**
   - The word "private" becomes the lock icon, with "Only you see this" as its hover text.
   - "due Wed" becomes the flag icon and "Wed".
   - A fixed time becomes the clock icon and "5:30 pm", in 12-hour time like the rest of the UI.
     (v5: on a day, a timed task shows its span in the title instead, "5:30–6 pm · Title".)
   - ✓ and ⋯ become the check and more icons.
   - *Why:* NN/g says icons need labels, which we keep, except for well-known marks. Things 3
     is about 95 % neutral, with colour and icons only for meaning.
3. **Sources look like sources.**
   - **Course tasks:** a 3px `--stem` left edge and the graduation-cap icon.
   - **Campus tasks:** the ticket icon.
   - **Blocks** take their task's edge colour on the timeline and in the week.
   - **The day's campus row:** a chip with the ticket icon and "2", plus the utensils icon and
     its count when any event has free food (`campusSummary`).
   - *Why:* Akiflow colours a slot by its project, and Sunsama users ask for whole-tile colour.
     WCAG 1.4.1 requires an icon with every tint.
4. **Load and free time, drawn.**
   - **Load bar:** each day header gets a 4px bar from `loadShare`. It is filled in `--accent`
     for ok, `--warn` for near and `--danger` for over, on a `--line` track. The "3h30" text
     stays.
   - **Day strip:** under the bar, a 6px strip from `stripSegments`. Busy times are grey, blocks
     are sage, and proposed blocks are dashed. Today's strip has a now tick.
   - **Plan today:** the header gets the same bar at full width, with a marker at "Done ≈".
   - *Why:* Sunsama and Ellie compare planned time with capacity, and Structured draws the day.
     The text stays, so the bar adds to the page and passes 1.4.1 and 1.4.11.
5. **Proposals and the timeline.**
   - **Proposed blocks:** the sparkles icon in place of the "(proposed)" suffix.
   - **Approve:** a small accent button with the check icon and the word "Approve".
   - **Blocks under 30 minutes:** one line, ellipsis, with the full title on hover.
   - **The now line:** 2px `--danger`, with a dot and a time label. It draws beneath block text.
   - **The header sentence** becomes a banner: sparkles, "Claude proposed 2 blocks" and
     [Approve all].
   - **The two-line keyboard hint** becomes "Drag tasks onto the timeline · ? for keys".
   - **In the week**, a proposal reads sparkles, "2–3:30 pm", [Approve].
   - **Keys:** `A` and `Shift+A` are unchanged.
6. **A calmer top bar.**
   - **Left:** ‹ Today ›, which reads "‹ Tue Nov 3 ›" on phones.
   - **Then:** Plan today as the one primary button, and Shut down only in its window, as now.
   - **Into a "⋯" menu:** Calendars, Settings, Sign out and Help.
   - **Telegram:** becomes a bell or bell-off toggle with the text "Nudges" and `aria-pressed`.
   - **Feed failed:** when `feedAlert` isn't empty, a circle-alert "Feed failed" chip opens
     Settings. In Settings, each feed row gets a check or an alert icon.
   - **On phones**, the top bar fits on one row at 390 px. Below 30rem, words that have an icon
     go to screen readers only: Needs you shows its icon and count, Nudges its bell, and Plan
     today reads "Plan".
   - *Why:* at 390 px the top bar wrapped to 3 rows.
7. **Overdue vs at risk, and empty states.**
   - **Due levels** (`dueLevel`): overdue is red, with the word "overdue"; at risk is amber.
     Both keep the ⚠ shape. Amber text never sits on a `--chip` background, which is 4.0:1 in
     light mode.
   - **An empty today** shows one muted line: "Nothing planned. Press P to plan today".
   - **An empty Someday list** always shows its "+ Add a task" placeholder.
8. **/now, safe polish only.**
   - It gets the row fix.
   - "Right now" gets a small accent dot.
   - Public `#workit` and `#micromouse` tasks get their project's icon.
   - Nothing new is revealed: no times, estimates, totals or streaks.

## School load

Shovel's "time cushion" and Sunsama's workload threshold, for one student: is the school work due
this week less than the time he has? Logic in `src/sheet/school-load.mjs` (covered by
`test/school-load.test.mjs`); the view in `school-load-view.mjs` with `src/styles/school-load.css`,
both loaded after sign-in, so /plan's first load doesn't carry them.

- **School work** is an undone task from the Brightspace feed (`source = 'brightspace'`, pace.mjs's
  "course"), or one tagged with a course code (`#cse316`, `#ams-261`) or `#school`, that has no
  `at_time` and is not a project step. A timed Brightspace item (an exam, a class meeting) is an
  event he goes to, so it takes free time instead.
- **Due this week:** its `due`, else its `day`, falls in the week on screen. In the current week,
  overdue work counts too.
- **Hours due:** each item's `est_min`, or a guess from its title when it has none: project, paper,
  essay or report 4h; exam or midterm 3h; homework, problem set, assignment or lab 2h; quiz 1h;
  discussion, post, reading or survey 30m; anything else 1h. A guess shows as "~2h".
- **Free hours:** for each day from today on, the calendar's free time from the day's start (now, on
  today) to its shutdown line, less the fixed-time tasks on it (`at_time`, `est_min` long, 30m
  without one) where no event already covers them. Each day is held to the Settings workload cap,
  as the day chips are, so the week's free hours are hours he would really give to work.
- **The bar** sits above the week: "School this week · 8h45 due · 33h free" with a 6px meter in
  the day load's colours (`loadShare`: near from 85%, over above 100%). It is hidden when nothing
  is due and for past weeks. It opens to the items, earliest due first; one with no estimate shows
  one-tap picks (30m, 1h, 2h, 4h, 8h) that set `est_min` at once, save behind with Undo, and put
  the guess back if the save fails.
- **Crunch week:** when hours due exceed free hours, the week title reads "Week of Nov 2 · Crunch
  week" and the bar adds "· 16h35 short". Phones hide the title, so the bar shows "Crunch week".

## Out of scope

- New colours beyond the site's palette. A colour switch like Todoist's is out: the one
  dimension is source.
- Animation beyond the existing 0.25 s fades, the check-off in [sheet.md](sheet.md)
  ("Completion") and today's progress ring ("Progress"), and none under `prefers-reduced-motion`.
- Streaks, totals or rewards on /now.

## Quality bar

- Verification tests for every function in `glance.mjs` come first, written by hand from
  this contract. They must pass unchanged.
- All existing tests stay green, including the aria-label and public-redaction tests.
- `npm run check` passes: html-validate, axe (icons `aria-hidden`, toggles `aria-pressed`),
  Lighthouse, and /plan's script at or under 60 KB.
- **Screenshot checks** in headless Chrome, with the stubbed fixture from the research
  (`tools/shoot-plan.mjs`, added by the first ticket). They run at 1440, 1280 and 390 px, in
  light and dark:
  - no task title is more than 3 lines tall;
  - the top bar is one row at 390 px;
  - the now line doesn't cover block text.

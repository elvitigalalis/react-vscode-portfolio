# Spec: Proposals and nudges

The Sheet's second version. Claude proposes when to do today's tasks, Lisul approves the
proposal in /plan, and Telegram nudges him when each approved block starts. It is for the
problem of forgetting what he meant to do at a given time. Terms are defined in
[GLOSSARY.md](../GLOSSARY.md); the main spec is [sheet.md](sheet.md).

## Why this shape

Research, October 2026: no mainstream app learns when to remind you. Reclaim moved away from
auto-scheduling in 2.0 (May 2026), and Morgen proposes plans for you to approve. Reminders
tied to a plan you made yourself (implementation intentions, d = 0.65, Gollwitzer & Sheeran
2006) work better than reminders that guess, and more than a few a day breeds fatigue. Hence:
the AI suggests, Lisul decides, and the nudges follow only what he decided.

## Architecture

- **Claude runs in Lisul's own Claude app**, never on a server, and needs no API key
  ([ADR 0001](adr/0001-claude-through-mcp-not-an-api-key.md)).
  - Claude uses Supabase's MCP connector, limited to the planner's project, and its own Google
    Calendar connector.
  - It works in a Claude Project called "The Sheet". The project's instructions are
    [sheet-claude.md](sheet-claude.md), and the copy in the repo is the master.
- **One Edge Function, `telegram`,** is The Sheet's only server code. It does two jobs:
  - **Sending:** `pg_cron` calls it every minute (through `pg_net`). It works out what's due
    with the same module /plan's tests cover (`src/sheet/nudges.mjs`), sends it through the
    Telegram Bot API, and logs each message so none is sent twice.
  - **Taps:** it is the bot's webhook for Done and Snooze, and ignores any chat that isn't
    Lisul's (the chat ID is in `settings`).

  The bot token is a function secret. Messages are fixed templates.
- **Google Calendar is still edited only from the browser.** When /plan opens, it brings Google
  in line with any change made away from it, such as a block a Done tap shortened.
- **The "Time blocks" events have no alerts** while Telegram is on, so nothing pings twice.

## Data

```
tasks     + due (date, null = no due date)
blocks    + proposed (bool, default false)
settings  + telegram_chat_id, nudges_on (bool)
nudges    id, block_id → blocks (null for the brief and check-in), kind (brief | start |
          repeat | snooze | checkin), day, send_at, sent_at
```

Rows with `proposed = true` never reach `public_week`, `public_now` or Google. Rollover and
shutdown delete the proposed blocks for their day.

## Typing a due date

`^fri`, `^10/30` or `^tomorrow` sets the due date, shown as a chip while typing and stripped on
save, like the other typed details (`parseEntry`). The task shows it as "due Fri". /now never
shows due dates. `atRisk` decides at risk: due within two days (or past due), not done, and no
block starting before the due day ends in the owner's time zone; the week marks it ⚠.

## Proposals

1. Lisul tells Claude "plan my day". After 3 pm, Claude plans tomorrow instead, the same rule
   as Plan today.
2. Claude reads:
   - the day's undone tasks, at-risk tasks and their estimates (30 min if there's none);
   - the existing blocks and the shutdown time;
   - his calendar, through its own connector.
3. Claude writes proposed blocks:
   - inside free time between 07:00 and the shutdown time, never over an event or a block;
   - in order: at-risk tasks first, then tasks with a fixed time, then the rest.
   - Its reply names what didn't fit.
4. In /plan, proposed blocks are dashed outlines on the timeline and in the week. Each has an
   **Approve** button, and the timeline header has **Approve all**. Approving one clears
   `proposed` and creates its Google event, as dragging does. Dragging or resizing a proposed
   block approves it.
5. A proposal that is never approved lapses at the end of its day.

Claude never approves, never edits or deletes real blocks, and never touches done tasks or
other days.

## Messages

All times are in the owner's time zone. Nothing is sent from 11 pm to 8 am. Messages go out
every day, weekends included.

| Kind | When | Text (template) | Buttons |
|---|---|---|---|
| Morning brief | 8:00 | "Today: 5 tasks, 3 blocks. At risk: OS homework (due Fri). Nothing planned yet: say "plan my day" to Claude." With more than 6 blocks: "8 blocks, nudging the first 6." On an empty day: "Nothing on today." | Open /plan |
| Nudge | The start of an approved block | "▶ 2:00 pm · OS homework (45 min)" | Done, Snooze 10 min |
| Repeat | 10 min after a nudge, if the task isn't done or snoozed | "Still on: OS homework" | Done, Snooze 10 min |
| Check-in | Shutdown time, unless the day is already shut down | "Shutdown time. 4 done, 2 left." | Open /plan |

- **Nudge budget:** six a day, counting nudges, repeats and snoozes; the brief and the check-in
  don't count. The first six by time get sent. Blocks that start before 8 am get no nudge.
- **Done** marks the task done and applies the block rules (the block ends now). /plan updates
  the Google event when it next opens. The message is edited to read "✓ Done".
- **Snooze 10 min** sends the nudge again 10 minutes later in place of the repeat. The block
  doesn't move.
- **Private tasks** show their real titles: messages go only to Lisul.
- Moving or deleting a block before it starts moves or cancels its nudge. Nudges are worked out
  from the blocks each minute, not booked ahead.

## Rules file: `sheet-claude.md`

The Claude Project's instructions:
- the tables and the columns Claude may write (`blocks` with `proposed = true` only);
- the order above, and how to fit blocks around events;
- the 3 pm rule;
- what not to touch;
- the reply format: the proposed blocks as a list, then what didn't fit.

## Out of scope

- Writing messages or planning without Lisul asking (that would need an API key; see ADR 0001).
- Brain-dump capture and "Break it down" (later).
- A chat bot inside Telegram, priority scores and automatic rescheduling (not planned).

## Quality bar

- Every existing gate passes, and /plan stays within its 60 KB script budget.
- The logic that decides things is plain modules in `src/sheet/` with `node --test` tests:
  - due-date parsing and at-risk;
  - which nudges are due at a given minute (budget, quiet hours, repeat, snooze, check-in);
  - the message templates.
- Taps from any chat other than Lisul's are ignored, and the webhook checks Telegram's secret
  token header.

## Build order

Each step ships on its own and leaves the planner working:

1. **Due dates:** the `due` column, `^fri` parsing, the "due Fri" chip and at-risk in the week.
2. **Proposed blocks:** the `proposed` column, dashed rendering, Approve and Approve all,
   lapsing at rollover and shutdown, and keeping proposals off /now.
3. **Rules file and Claude Project:** `sheet-claude.md`, and a test run of "plan my day"
   through Supabase's connector.
4. **Telegram sending:** the bot, the `nudges` log, `src/sheet/nudges.mjs` and the per-minute
   job: nudges, repeats, the brief and the check-in, within the budget and quiet hours.
5. **Telegram taps:** the `telegram` Edge Function for Done and Snooze, and /plan syncing Google
   on open.

## Setup Lisul does once

`tools/sheet-setup.sh` gains a Telegram step:
1. Message @BotFather, create a bot and paste its token in as the function's secret.
2. Send the bot one message, so the script can read the chat ID.
3. Add Supabase's MCP connector to Claude, limited to the planner's project, and create "The
   Sheet" Claude Project with the instructions from `sheet-claude.md`.

Claude never handles the token.

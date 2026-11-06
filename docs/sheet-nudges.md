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
  - **Taps:** it is the bot's webhook for Done and Snooze. It checks Telegram's
    `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET` (a function
    secret, given to `setWebhook` as its `secret_token`) and ignores, without a reply, any chat
    that isn't Lisul's (the chat ID is in `settings`). The same module reads the tap (`readTap`) and decides what it changes
    (`handleTap`); the function writes it, answers the tap and edits the message.
    It also takes Lisul's texts to the bot, which are messages to Claude
    ([sheet-messages.md](sheet-messages.md), "From Telegram").

  The bot token is a function secret. Messages are fixed templates.

  The function lives in `supabase/functions/telegram/` and imports `src/sheet/nudges.mjs`
  straight from `src/`, so it is deployed with server-side bundling (`supabase functions deploy
  telegram --use-api --no-verify-jwt`), which follows imports outside `supabase/functions`. The
  cron job proves itself with a shared secret header (`SHEET_CRON_SECRET`, a function secret);
  the job reads the function's URL and that secret from Supabase Vault, so neither is in the repo.
- **Google Calendar is still edited only from the browser.** When /plan opens, it brings Google
  in line with any change made away from it, such as a block a Done tap shortened: a tap that
  shortens or deletes a block with an event leaves a `gcal_pending` row, which /plan applies and
  deletes once Google is connected.
- **The "Time blocks" events have no alerts** while Telegram is on, so no block is announced
  twice, and Google's default alert while it is off. The **Telegram on/off** button in /plan's
  top bar, beside Calendars, sets `nudges_on` and patches the alerts of the events of today's
  and later blocks to match (only with Google connected).

## Data

```
tasks     + due (date, null = no due date)
blocks    + proposed (bool, default false)
settings  + telegram_chat_id, nudges_on (bool)
nudges    id, block_id (null for the brief and check-in), kind (brief | start | repeat |
          snooze | checkin), day, send_at, sent_at; unique (block_id, kind, day, send_at)
gcal_pending  gcal_id (primary key), ends_at (null = delete the event)
```

The function claims a `nudges` row before sending (`sent_at` stays null until Telegram accepts
it), so two runs in the same minute can't both send. A Snooze tap logs its nudge ahead, with
`send_at` ten minutes after the tap and `sent_at` null; the function claims that row by filling in
`sent_at`. `block_id` has no foreign key: the log keeps
rows for blocks deleted later, so the day's budget still counts them.

Rows with `proposed = true` never reach `public_week`, `public_now` or Google. Rollover and
shutdown delete the proposed blocks for their day.

## Typing a due date

`^fri`, `^10/30` or `^tomorrow` sets the due date, shown as a chip while typing and stripped on
save, like the other typed details (`parseEntry`). The task shows it as "due Fri". /now never
shows due dates. `atRisk` decides at risk. A task is at risk when all three hold:
- it is not done;
- its due date is at most two days after today, or already past (an overdue task counts);
- it has no approved block that starts before its due day ends (midnight after the due date, in
  the owner's time zone). A block at any time on the due day clears it, as does any earlier
  block, even one already over. Proposed blocks don't count.

The week marks an at-risk task ⚠.

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
| Morning brief | 8:00, or the first run after it if one was missed | One line each: "Today: 5 tasks, 0 blocks." "At risk: OS homework (due Fri)." "Nothing planned yet: say "plan my day" to Claude." With more than 6 blocks that can be nudged (see the budget below) the first line reads "Today: 5 tasks, 8 blocks, nudging the first 6." On an empty day (no tasks, blocks or at-risk tasks): "Nothing on today." When the ring has seen him up today, it opens "Good morning! Up at 8:50 am. First up: OS homework at 7:15 pm." | Open /plan |
| Nudge | The start of an approved block | "▶ 2:00 pm · OS homework (45 min)" | Done, Snooze 10 min |
| Repeat | 10 min after a nudge, if the task isn't done or snoozed | "Still on: OS homework" | Done, Snooze 10 min |
| Check-in | Shutdown time (10:55 pm if the shutdown line is at 11 pm or later), unless the day is already shut down | "Shutdown time. 4 done, 2 left." | Open /plan |

- **Nudge budget:** six a day, counting nudges, repeats and snoozes; the brief and the check-in
  don't count. A block can be nudged when it is approved, its task isn't done, and it starts
  between 8 am and 11 pm (so blocks that start before 8 am get no nudge). The nudges at the start
  of the first six such blocks are kept for them; repeats, snoozes and later blocks' nudges use
  only the slots left after those, so a repeat in the morning never costs an afternoon block its
  nudge. A snooze waiting to go out holds its slot.
- **Done** marks the task done and applies the block rules (the block ends now). /plan updates
  the Google event when it next opens. The message is edited to read "✓ Done".
- **Snooze 10 min** sends the nudge again 10 minutes later in place of the repeat. The block
  doesn't move. The message reads "Snoozed until 2:13 pm · OS homework", or "No nudges left
  today · OS homework" when no slot is free, or "Too close to quiet hours · OS homework" when
  the nudge would come back at 11 pm or later; neither logs anything.
- A repeat that would fall in quiet hours is not sent.
- A tap on a block that has since been deleted changes nothing; the message reads "That block is
  no longer on the plan."
- **Private tasks** show their real titles: messages go only to Lisul.
- Moving or deleting a block before it starts moves or cancels its nudge. Nudges are worked out
  from the blocks each minute, not booked ahead.
- A late run still sends what it missed, for the minute it was due: a nudge or repeat while its
  block is still on, the brief and the check-in until 11 pm.
- A day with no tasks gets its brief ("Nothing on today.") and no check-in.

## The pinned Now message

One message pinned at the top of the chat says what's on: "Now: OS homework until 3:40 pm ·
Next: Gym at 4:00 pm", "Next: Gym at 4:00 pm" between blocks, "Next: Gym tomorrow at 8:00 am"
when the next block is on a later day, or "Nothing scheduled". It reads the approved blocks
(proposed ones aren't on the plan), each named by its task or habit (`nowText`).

- The minute tick (`pinStep`, then `pinTick` in the `telegram` function) makes it once, silently
  (`sendMessage` with `disable_notification`), pins it (`pinChatMessage`, also silent), and keeps
  its id and words in `settings.now_message_id` and `now_text`. After that it only edits it
  (`editMessageText`), and only when the words change, so it never notifies. It follows /plan
  within a minute.
- It is made only while he's up: not in quiet hours or before his wake (the brief's rule). Edits
  go at any hour, since they are silent. Nothing happens while Telegram is off.
- If he deletes it, the next edit finds it gone, the id is forgotten, and a new one is made and
  pinned once he's up.

Deploying it: the schema (adds `settings.now_message_id` and `now_text`), then `telegram`.

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

`tools/sheet-setup.sh` gains a Telegram step (`bash tools/sheet-setup.sh telegram` runs only
it, after re-running the schema):
1. Message @BotFather, create a bot and paste its token into the script (hidden), which checks
   it and puts it on the clipboard to paste in as the function's secret, with a random
   `SHEET_CRON_SECRET` and `TELEGRAM_WEBHOOK_SECRET` it makes.
2. Send the bot one message, so the script can read the chat ID.
3. Deploy the function; the script then registers it as the bot's webhook (`setWebhook` with
   the webhook secret as `secret_token`). Run the SQL the script copies, which puts the
   function's URL and the cron secret in Vault and saves the chat ID.
4. Add Supabase's MCP connector to Claude, limited to the planner's project, and create "The
   Sheet" Claude Project with the instructions from `sheet-claude.md`.

Claude never handles the token.

## Quieter messages and health (2026-11-06)

- **Silent messages:** Finished?, the check-in, replan and horizon messages and receipts go out
  with `disable_notification` (no sound, still in the chat). The brief, the plan, start nudges,
  repeats, snoozes, wind-down, bedtime and health alerts ring (`silent` in `nudges.mjs`).
- **Links:** Open /plan carries `?open=plan` under a plan, `?open=shutdown` under the check-in and
  `?open=needs` under a brief that counts open Needs you rows ("Needs you: 2.").
- **The folded brief:** what to act on stays in view (counts, at risk, won't fit, Monday's Last
  week line, the plan, a missed plan, Needs you, any health issue). Sleep score, tip, cap,
  weather, calendar, Awaiting reply and "Sheet: all green." fold into one `expandable_blockquote`
  entity (UTF-16 offsets, no `parse_mode`).
- **Mondays:** "Last week: 18h30 done of 24h planned. Course tasks ran 1.4× estimate. Due this
  week: Essay (tight)." Skipped with fewer than 3 planned days last week. No sleep numbers.
- **Texts to the bot:** the bot reacts 👀 (Claude is reading) or ✍ (queued), and 👌 once the
  receipt goes out; it sends the old text ack only when rate limited or if the reaction is
  refused. A voice note, photo or file gets "I can only read text for now…" at most once an hour
  (`settings.media_reply_at`).

### Health

`src/sheet/health.mjs` works out what is broken from rows the minute tick reads: a feed failing
or stale (3 of its intervals, 30 min at least), a mail, calendar or Oura account needing
reconnecting, Telegram's webhook missing or not delivering, today's newest replan failing or
rate limited, the morning plan's retry failing, replans paused at the daily cap with a weighty
change waiting, and messages to Claude whose one re-fire failed.

- **The brief** ends with "Sheet: all green." (folded), or the issues in view: "Sheet: Gmail sync
  failing (see Settings)."
- **Alerts:** one `health` message per incident, only after the brief, only while messages go
  out (from his wake, never before 8:00, until 23:00), at most **2 a day**. They sit **beside
  the nudge budget**, like the brief: they use none of its six slots and have their own cap.
  `settings.health_told` holds the keys told and still open; a key that clears is dropped, so it
  is told again only if it comes back. Issues the brief listed count as told.
- **Self-repair:** a missing webhook is set again at the function's own URL; a morning plan
  missing at 6:40 am is fired once more (a `replans` row with reason `morning_retry`); a message
  whose fire failed is fired once more after 5 minutes or its 429's retry time (`messages.
  fire_error`, `retry_at`, `refired_at`). A replan revision with the same blocks as the one
  before doesn't count toward the daily cap of 8.
- **Expiries** (`credentials`, dates only, never a secret): a token or grant ending within 14
  days is an issue keyed by its date ("GitHub token expires Thu Nov 19 (make a new one and set
  SHEET_GITHUB_TOKEN)"), so it is in each brief until renewed and alerted once. `github_pat` is
  filled in by work-sync from GitHub's `GitHub-Authentication-Token-Expiration` header.
  `jira_token` has no date: Atlassian's API doesn't report one, so its note says so; set it with
  `update credentials set expires_at = '2027-…' where name = 'jira_token'`. While the row
  `google_testing` exists, each Gmail account and the calendar is taken to end 7 days after its
  `connected_at` (Google's Testing rule; about Nov 10 and Nov 11 for today's grants). Once the
  consent screen says In production, `delete from credentials where name = 'google_testing'`.
- **Kept outcomes:** `health_log` keeps 30 days of what failed: each non-2xx or timed-out pg_net
  response (copied hourly by `sheet-keep-http`, before pg_net's 6-hour TTL drops it), one count
  row an hour, and any failed step of the telegram tick. No external heartbeat: it needs an
  account and a ping-URL secret.
- **Live check:** `sheet_checks()` runs in the database (no Mac needed): cron jobs on, Vault
  URLs set (sheet-ical left out), no failed cron runs in 24 h, replans settled, `busy_as_of`
  fresh, pg_net failures in 24 h. The tick calls it hourly; a `fail` row is an issue, and an
  all-green brief says "Sheet: all green (live check passed)."

### At a block boundary, stale buttons, and the thumb keyboard

- A Finished? and the next block's start due within 5 minutes go as **one message**: the
  Finished? line, then "Next: ▶ 10:15 am · Gym (45 min)", with the four answers in one row and
  Done/Snooze in a second. It rings (a Finished? alone is silent). Both log rows are written, so
  the budget, the repeat and the next Finished? hold.
- **Dead buttons:** each sent message's id is kept (`nudges.tg_message_id`). A block's newer
  message, and any answer to it but Snooze, takes the buttons off its older messages
  (`editMessageReplyMarkup`); the text stays.
- **Thumb keyboard:** a persistent reply keyboard, Now · Done · +15 min · Today, sent once
  (`settings.keys_sent_at`) and again on /start or /keys. Now gives the pinned line and the
  running block's Done/Snooze; Done marks it done; +15 min extends it (or one that ended under
  30 min ago); Today lists today's open tasks with a Done each (`td:<task id>`). The labels and
  /now, /done, /today are matched exactly before capture, so they never reach Claude; any other
  text is captured as before.

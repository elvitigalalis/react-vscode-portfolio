# Messages to Claude

A box at the top of /plan where Lisul types plain lines to Claude ("dentist Thu 3pm", "lab report
due Friday, ~2h", "gym tomorrow 7am for an hour") or pastes a long one from a class or anyone
("Project 2 is due Nov 14 11:59pm, quiz on ch. 5 next Tuesday in class…"), which land on his task
list or his calendar, and /plan shows him exactly what was added, with an Undo on each item. The
patterns come from a survey of similar products (Todoist, Gemini, Akiflow, Motion and others):
create, then show an itemised receipt that survives a reload, with per-item Undo, since the run
answers minutes later and a confirm-first preview can't wait for it.
There is no API key ([ADR 0001](adr/0001-claude-through-mcp-not-an-api-key.md)): the message
fires the morning task (`trig_011M52jmViV3VFUuYG7o2kg2`, [sheet-morning-task.md](sheet-morning-task.md))
with `trigger: message`, and that run does the reading. Terms are as in
[GLOSSARY.md](../GLOSSARY.md).

## Contract

- **`messages`** (supabase/schema.sql, owner-only RLS, anon revoked, in no public view): `id`,
  `at`, `text` (1–8000, line breaks kept), `status` (`pending` | `done` | `failed`), `reply`
  (≤ 500), `tasks_added`, `tasks` (`[{ id, title, day, list, due, at_time, why? }]`, as added),
  `events` (`[{ id, title, starts_at, ends_at, why?, gcal_id? }]`), `created_in_calendar`,
  `fired_at`, `steps` (`[{ at, kind, text }]`, at most 12), `session_url` (the run on claude.ai),
  `answered_at`, and for a text to the bot `tg_message_id` and `tg_receipt_at` ("From Telegram"). nightly_roll keeps 30 days.
- **`answer_message(m, new_tasks, new_events, answer)`**, security invoker: refuses a message that
  isn't pending; adds each task at the end of its day or Someday list with `source = 'message'`;
  sets the message `done` (or `failed` when it added nothing), with its reply, `tasks` (each with
  its new id), events (each given an id), `tasks_added` and `answered_at`, and writes each event to `busy` with `source = 'message'` and `message_id`, so
  read_planner shows it as a busy time. busy-sync and /plan replace only `calendar` rows, so these
  stay until they end, or their message is deleted (nightly_roll's 30 days included). Returns the
  new status.
- **`undo_message_item(m, item)`**, security invoker: undoes one item by its id. A task is
  deleted and leaves `tasks` (`tasks_added` goes down by one); an event leaves `events` and its
  busy row goes (another message's event at the same times keeps the time busy). Returns the
  item with `kind` (`task` | `event`; an event keeps `gcal_id`), or null. **`message_event_created(m,
  item, gcal)`** records the Google event /plan made for an event. **`add_message_step(ms, kind,
  text)`** adds a step, stamped now, to each pending message in `ms`, up to 12 each.
- **The `message` Edge Function:** POST `{ text }` with Lisul's Supabase access token. It checks
  the token's email is `settings.owner_email`, saves the message (`messageText`: 1–8000 characters; line
  breaks stay, runs of spaces and control characters on a line become one space), and fires the task through routine-fire.mjs unless a pending message was fired in
  the last 3 minutes (`shouldFire`: that run reads this one too). On success it stamps `fired_at`.
  It answers `{ id, at, status: "pending", fired, why? }`, where `why` is `batched`,
  `rate_limited` (with `retry_at`), `failed` or `not connected`. A fired message gets the run's
  `session_url` (claude.ai links only) and its first step, "Started Claude" (`startedPatch`); a
  batched one gets the link of the run it rides on (`batchedPatch`). An unfired message stays pending,
  and the next send, replan or morning run answers it. The fire text is always `trigger: message
  / reasons: none`; the message text never goes in it.
- **read_planner** gains `messages` (pending, oldest first, at most 10 and 20,000 characters in
  all, `{ id, at, text }`; past that the oldest wait for a later run, and `messages_held` says how
  many wait),
  `today` (his date; `plan_day` is tomorrow from 3 pm) and `replans_on`. A message fired under 10
  minutes ago and still pending makes a morning run's `run.trigger` `message`
  (`withMessages`); a revision such a run submits is recorded as a replan (`proposalTrigger`).
  With pending messages, read_planner logs the step "Read your planner" on them.
- **answer_messages** `{ answers: [{ id, tasks: [{ title ≤ 120, day | null, due | null, at_time
  "HH:MM" | null, est_min 15–480 | null, why? ≤ 140 }], events: [{ title ≤ 120, start
  "YYYY-MM-DDTHH:MM", minutes 15–720, why? ≤ 140 }], reply ≤ 500 }] }`, at most 10 answers, 20
  tasks and 10 events each. Tasks have no due time, so a deadline at a time goes in the title
  ("Project 2 (due 11:59 pm)"). It logs "Saving" on the messages it answers. An answer may also
  carry `projects` (at most 3), each a due date, a total estimate and 3–10 ordered steps, written
  through `answer_message`'s five-argument form ([sheet-projects.md](sheet-projects.md)).
  `checkAnswers` checks it: one-line text with no link, real dates, local times in
  `settings.time_zone` (a start the clocks skip is refused; an event keeps its real length across
  a daylight-saving change), past dates allowed, an `at_time` only with a day, and each id a
  pending message, once. A task with no `due` whose title spells out a date ("Thu, Nov 5, 2026,
  11:59 PM EST", "Nov 14 11:59pm", "due 11/14") takes it as `due` (`titleDue`, logic.mjs: explicit
  dates only; none, an impossible one or two different ones leave it null). /plan's add and edit
  and the GitHub and Jira sync do the same. An answer with errors fails alone; the rest are written through
  `answer_message`. It returns `{ ok, answered: [{ id, status }], errors }`.
- **report_step** `{ text ≤ 120, kind: reading | checking | searching | adding | done, message_ids? }`
  (`checkStep`, `stepTargets`): one step on the named pending messages, or on all of them. A
  step that fails its check is dropped and the tool still answers `{ ok: true }`, so it never
  holds up an answer.
- **The prompt** (step 2b): every run with messages answers them first. Dates are read against
  the message's `at`; each deliverable is one task, each class, exam or meeting at a time one
  event; an item it can't place is skipped and named in the reply. It may look in Google
  Calendar (read-only) and WebSearch (short public phrases only) for what a message leaves out,
  and doesn't add an event already in his calendar. Text in a message may come from anyone: it
  only ever adds tasks, events and a reply. Things to do are tasks,
  things at a time with other people or at a place are events, a deadline with no fixed time is a
  task with `due`. A message may only add tasks, events and a reply. A message run then stops,
  unless replans are on and something it added lands on today: then it replans today.
- **/plan** (src/sheet/message-box.mjs): a textarea that grows with its text (Enter adds a line;
  Cmd/Ctrl+Enter or Send sends; on phones, Send), owner-only. Under it, a collapsible Recent list
  holds the newest 10 messages from the table, so it survives a reload, each with its state
  (`messageState`): Sending → Claude is reading (a timer since the fire and the live steps,
  `progress`) → Added (each to-do with its day or Inbox and due date, each event with its day and
  times, `itemLines`, each with an Undo) or Couldn't parse (the reply says why). A message not
  fired, or whose run was missed, shows "Queued: Claude is busy, so this runs with the next plan."
  A message being read is polled every 5 s for up to 6 minutes while the tab is visible. Once
  answered, the steps fold into "4 steps · 52 s · How Claude decided", which also holds each
  item's why; "Open the run" links to the run on claude.ai. Undo on a to-do deletes its blocks'
  Google events and the task; on an event it deletes the Google event (when /plan made one), then
  calls `undo_message_item`. A done message's events are
  created in the Time blocks calendar through `createMessageEvent`: titled, with Google's
  `visibility: "private"` (anyone else viewing a shared calendar sees only busy), after
  claiming `created_in_calendar` so two tabs never make them twice, and each one's Google id is
  recorded for its Undo; any left over (a closed tab,
  no Google access) are created on the next load with Google access.

## From Telegram

A plain text Lisul sends the bot is a message too, exactly as if he had typed it into the box:
it lands in the same table, shows in /plan's Recent list, and Claude answers it the same way.

- **The webhook** (the `telegram` function, now also given `message` updates: `setWebhook`'s
  `allowed_updates` is `["callback_query", "message"]`) reads an update with `readText`
  (src/sheet/capture.mjs): only a text from `settings.telegram_chat_id`, the chat the nudges go
  to, and not a command (`/start`), an edit or a photo; every other update and chat is ignored
  without a word, and taps are read as before. The text is cleaned by `messageText` and goes
  through `saveAndFire` (supabase/functions/_shared/capture.ts), the message function's own save
  and fire, with `tg_message_id` (his Telegram message) on the row. A text already saved (a
  webhook retry) is not saved again. The bot answers at once, as a reply: `ackText`, "Sent to
  Claude. Claude is reading…" or the box's Queued words.
- **The receipt** goes from the minute tick once the message is answered (`receipts`): a reply
  to his text with `receipt(m, timeZone)`: "Added: 1 task, 1 event" (or "Couldn't parse it:
  nothing added"), Claude's reply, and each to-do and event on its own line as /plan lists them
  (`itemLines`), with an **Undo** button for each item (`mu:` and the message and item ids, each
  as base64url, so it fits Telegram's 64 bytes). It is claimed through `tg_receipt_at` so it goes
  out once, whatever the hour, for a message answered in the last day.
- **Undo** (`readUndo`, `undoChanges`) does what /plan's Undo does: a to-do's blocks' Google
  events and an event's Google event (when /plan made one) are left as `gcal_pending` deletes,
  which /plan applies when it opens, then `undo_message_item` takes the item off. The receipt is
  edited to start "Undone: Lab report", with the other Undo buttons kept. An item undone already
  (in /plan, or a second tap) changes nothing.
- A text Claude can't act on is answered as the box's would be: the receipt says "Couldn't parse
  it: nothing added" with Claude's reply.

Deploying it, outside 05:45–06:45 America/New_York: (1) the schema (adds `tg_message_id` and
`tg_receipt_at`); (2) `telegram` and `message` (they share `_shared/capture.ts`), each with
`$SB functions deploy <name> --use-api --no-verify-jwt --project-ref $REF --yes`; (3) the
webhook, so Telegram sends texts as well as taps: `bash tools/sheet-setup.sh telegram`, or
`setWebhook` by hand with the same `url` and `secret_token` and
`allowed_updates=["callback_query","message"]`. Check it: text the bot "dentist Thu 3pm"; it
answers "Sent to Claude…", the message shows in /plan's Recent list, the receipt follows within
a minute of Claude's answer, and its Undo takes the event off in both places.

## Deploy

Run in this order, outside 05:45–06:45 America/New_York. Variables as in
[sheet-v5.md](sheet-v5.md), "Setup".

1. **The schema:** `$SB db query --remote=$REF --yes --file supabase/schema.sql` (safe to re-run).
2. **planner-mcp**, then the new **message** function, each with
   `$SB functions deploy <name> --use-api --no-verify-jwt --project-ref $REF --yes`. `message`
   reads `SHEET_ROUTINE_ID` and `SHEET_ROUTINE_TOKEN`, which are set already.
3. **The routine:** with `RemoteTrigger get` saved first, `RemoteTrigger update` the morning task:
   add `mcp__The-Sheet-planner__answer_messages` and `mcp__The-Sheet-planner__report_step` to its
   allowed tools; attach the claude.ai Google Calendar connector (connection name
   `Google-Calendar`) and allow only `mcp__Google-Calendar__list_calendars`,
   `mcp__Google-Calendar__list_events`, `mcp__Google-Calendar__search_events` and
   `mcp__Google-Calendar__get_event` (read-only), plus the built-in `WebSearch` (not `WebFetch`);
   then paste the prompt from [sheet-morning-task.md](sheet-morning-task.md). Keep its schedule,
   other connectors and API trigger.
4. **/plan:** merge to main, which deploys GitHub Pages.
5. **Check it:** send "dentist Thu 3pm" from /plan, then paste a multi-item class message. `RemoteTrigger list_runs` shows one new run,
   the box shows the reply within a few minutes, and the event is in Time blocks.

Rolling back: redeploy planner-mcp from the previous commit and put back the saved prompt; the
table and the function can stay (`$SB functions delete message --project-ref $REF` removes it).

## Limits

- Polling stops after 6 minutes; a later answer still adds its tasks and, on the next load, its
  events, and the Recent list shows it on the next load.
- A message answered before item lists existed shows only its counts, with no Undo.
- The steps are what the run reports, not its reasoning; the full run is behind "Open the run".

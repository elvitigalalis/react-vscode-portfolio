# Messages to Claude

A box at the top of /plan where Lisul types plain lines to Claude ("dentist Thu 3pm", "lab report
due Friday, ~2h", "gym tomorrow 7am for an hour"), which land on his task list or his calendar.
There is no API key ([ADR 0001](adr/0001-claude-through-mcp-not-an-api-key.md)): the message
fires the morning task (`trig_011M52jmViV3VFUuYG7o2kg2`, [sheet-morning-task.md](sheet-morning-task.md))
with `trigger: message`, and that run does the reading. Terms are as in
[GLOSSARY.md](../GLOSSARY.md).

## Contract

- **`messages`** (supabase/schema.sql, owner-only RLS, anon revoked, in no public view): `id`,
  `at`, `text` (1–500), `status` (`pending` | `done` | `failed`), `reply` (≤ 280), `tasks_added`,
  `events` (`[{ title, starts_at, ends_at }]`), `created_in_calendar`, `fired_at`. nightly_roll
  keeps 30 days.
- **`answer_message(m, new_tasks, new_events, answer)`**, security invoker: refuses a message that
  isn't pending; adds each task at the end of its day or Someday list with `source = 'message'`;
  sets the message `done` (or `failed` when it added nothing), with its reply, events and
  `tasks_added`, and writes each event to `busy` with `source = 'message'` and `message_id`, so
  read_planner shows it as a busy time. busy-sync and /plan replace only `calendar` rows, so these
  stay until they end, or their message is deleted (nightly_roll's 30 days included). Returns the
  new status.
- **The `message` Edge Function:** POST `{ text }` with Lisul's Supabase access token. It checks
  the token's email is `settings.owner_email`, saves the message (`messageText`: one line, 1–500
  characters), and fires the task through routine-fire.mjs unless a pending message was fired in
  the last 3 minutes (`shouldFire`: that run reads this one too). On success it stamps `fired_at`.
  It answers `{ id, at, status: "pending", fired, why? }`, where `why` is `batched`,
  `rate_limited` (with `retry_at`), `failed` or `not connected`. An unfired message stays pending,
  and the next send, replan or morning run answers it. The fire text is always `trigger: message
  / reasons: none`; the message text never goes in it.
- **read_planner** gains `messages` (pending, oldest first, at most 10: `{ id, at, text }`),
  `today` (his date; `plan_day` is tomorrow from 3 pm) and `replans_on`. A message fired under 10
  minutes ago and still pending makes a morning run's `run.trigger` `message`
  (`withMessages`); a revision such a run submits is recorded as a replan (`proposalTrigger`).
- **answer_messages** `{ answers: [{ id, tasks: [{ title ≤ 120, day | null, due | null, at_time
  "HH:MM" | null, est_min 15–480 | null }], events: [{ title ≤ 120, start "YYYY-MM-DDTHH:MM",
  minutes 15–720 }], reply ≤ 280 }] }`, at most 10 answers, 10 tasks and 5 events each.
  `checkAnswers` checks it: one-line text with no link, real dates, local times in
  `settings.time_zone` (a start the clocks skip is refused; an event keeps its real length across
  a daylight-saving change), past dates allowed, an `at_time` only with a day, and each id a
  pending message, once. An answer with errors fails alone; the rest are written through
  `answer_message`. It returns `{ ok, answered: [{ id, status }], errors }`.
- **The prompt** (step 2b): every run with messages answers them first. Things to do are tasks,
  things at a time with other people or at a place are events, a deadline with no fixed time is a
  task with `due`. A message may only add tasks, events and a reply. A message run then stops,
  unless replans are on and something it added lands on today: then it replans today.
- **/plan** (src/sheet/message-box.mjs): one line and Send, owner-only. A sent message shows
  "Sending to Claude…", then its row is polled every 5 s for up to 3 minutes while the tab is
  visible, and the reply shows with "Added: 2 tasks, 1 event". A done message's events are
  created in the Time blocks calendar through `createMessageEvent`: titled, with Google's
  `visibility: "private"` (anyone else viewing a shared calendar sees only busy), after
  claiming `created_in_calendar` so two tabs never make them twice; any left over (a closed tab,
  no Google access) are created on the next load with Google access.

## Deploy

Run in this order, outside 05:45–06:45 America/New_York. Variables as in
[sheet-v5.md](sheet-v5.md), "Setup".

1. **The schema:** `$SB db query --remote=$REF --yes --file supabase/schema.sql` (safe to re-run).
2. **planner-mcp**, then the new **message** function, each with
   `$SB functions deploy <name> --use-api --no-verify-jwt --project-ref $REF --yes`. `message`
   reads `SHEET_ROUTINE_ID` and `SHEET_ROUTINE_TOKEN`, which are set already.
3. **The routine:** with `RemoteTrigger get` saved first, `RemoteTrigger update` the morning task:
   add `mcp__The-Sheet-planner__answer_messages` to its allowed tools, and paste the prompt from
   [sheet-morning-task.md](sheet-morning-task.md). Keep its schedule, connectors and API trigger.
4. **/plan:** merge to main, which deploys GitHub Pages.
5. **Check it:** send "dentist Thu 3pm" from /plan. `RemoteTrigger list_runs` shows one new run,
   the box shows the reply within a few minutes, and the event is in Time blocks.

Rolling back: redeploy planner-mcp from the previous commit and put back the saved prompt; the
table and the function can stay (`$SB functions delete message --project-ref $REF` removes it).

## Limits

- Polling stops after 3 minutes; a later answer still adds its tasks and, on the next load, its
  events, but the reply isn't shown.

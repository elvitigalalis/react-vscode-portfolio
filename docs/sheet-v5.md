# Spec: A plan that keeps up all day

The Sheet's fifth version: one rough plan for the day, kept current, with Lisul still approving
every change. Busy times sync on the server, approved blocks are locked, each plan is a numbered
revision, plain code decides when a replan is worth a run, Finished? checks teach The Sheet his
pace, the day keeps breaks, travel time and a workload cap, and new read-only sources (GitHub,
Jira, Slack, Handshake, the academic calendar, weather) reach the planner. The product spec is
issue 47 and the tickets are issues 48–63. Terms are as in [GLOSSARY.md](../GLOSSARY.md). This
builds on [sheet-morning.md](sheet-morning.md) and [sheet-glance.md](sheet-glance.md). The
server-side decisions are in ADR 0004.

## Contracts

The tickets are built in parallel, so they share the exact names below. A ticket may add to a
contract, but must not change it without updating this section in the same commit. Lines marked
**Decided** settle a detail spec 47 left open.

### Rules shared by every ticket

- **v4 stays green.** Every v5 rule in `checkProposal` applies only to a snapshot with
  `version: 5`, which v5's `planSnapshot` always sets. A snapshot without it (the hand-built
  fixtures in test/v4-*.verify.test.mjs) is checked, and its rows shaped, exactly as in v4. In
  nudges.mjs the v5 plan buttons, plan taps and brief lines key off the fields that carry them
  (`proposal.rev`, `snapshot.weather`, …); a snapshot without them reads as v4. **Decided:** this
  keeps the v4 verification tests passing unchanged.
- **Local times** are "HH:MM", 24-hour, in `settings.time_zone`, on the day named. Stored times
  are `timestamptz` and travel as ISO strings; computed ones are `toISOString()` UTC.
- **Free text from outside** (mail, feeds, GitHub, Jira, Slack, NWS) reaches Telegram only after
  `linkish` (proposal.mjs) says no, or as a fixed word. Titles from sources are cut with
  `cutTitle` and kept to one line.
- **Pace kinds** are `course` (source `brightspace`), `campus` (tag `campus`), `github`
  (source `github`), `jira` (source `jira`) and `other` (everything else, including `mail`).

### Schema (`supabase/schema.sql`: appended in one "v5" section per ticket, safe to re-run)

Every new table has RLS on, the `owner_all` policy under `is_owner()`, `revoke all … from anon`,
and appears in no public view. Tables only a server function writes also
`revoke insert, update, delete … from authenticated`.

```
proposals  + rev int not null default 1 check (rev between 1 and 999)
             primary key (day, rev)                      -- was (day): drop proposals_pkey, add it back
           + run_trigger text not null default 'morning' check (run_trigger in ('morning','replan'))
           + reasons text[] not null default '{}'        -- REASON_WORDS names only (replan.mjs)
           + couldnt_fit uuid[] not null default '{}'    -- task ids
           + suggested jsonb not null default '[]'       -- [{ account, message_id, title, due, kind }]
           + blocks jsonb not null default '[]'          -- the revision's proposed blocks, as written:
                                                         --   [{ task_id | habit_id, starts_at, ends_at }]
             status check adds 'superseded'
days       + turned_down uuid[] not null default '{}'    -- task ids turned down on this day
blocks     + habit_id uuid references habits on delete cascade
             task_id drops not null; check ((task_id is null) <> (habit_id is null))
busy       + source text not null default 'calendar' check (source in ('calendar','handshake'))
             primary key (source, starts_at, ends_at)    -- was (starts_at, ends_at)
tasks      + link text check (link is null or link ~ '^https://')   -- GitHub/Jira page; never public
needs_you  + source text not null default 'mail' check (source in ('mail','slack'))
           + not_needed boolean not null default false   -- done = true as well
           + from_address text                           -- lowercased From address, set by the server
nudges     kind adds 'finished', 'replan'
mail_accounts + history_id text                          -- the mail sync's Gmail history position
settings   + replans_on boolean not null default false
           + workload_cap_min int not null default 360 check (workload_cap_min between 60 and 960)
           + enrollment_at timestamptz                   -- spring enrollment opens
           + weather_point text not null default '40.9126,-73.1234'
               check (weather_point ~ '^-?\d{1,2}\.\d{1,4},-?\d{1,3}\.\d{1,4}$')
           + github_orgs text[] not null default '{}'
           + plan_edited_at timestamptz                  -- /plan's last write (see replans)

calendar_account   id boolean pk default true check (id), email text not null,
                   vault_secret_id uuid, connected_at timestamptz not null default now(),
                   last_error text                       -- browser: select, delete only
changes    id uuid pk default gen_random_uuid(), at timestamptz not null default now(),
           kind text not null check (kind in ('mail','busy','course','campus','github','jira','slack','handshake')),
           reason text not null,                         -- one of REASON_WORDS (replan.mjs)
           weight int not null check (weight between 1 and 10),
           ref text check (char_length(ref) <= 200),     -- an id in the source; never a title
           replan_id uuid references replans on delete set null,   -- the replan it started (create replans first)
           consumed_day date, consumed_rev int           -- the revision that read it
replans    id uuid pk default gen_random_uuid(), at timestamptz not null default now(),
           day date not null, reasons text[] not null, counts jsonb not null,   -- { kind: n }
           result text check (result in ('started','failed','rate_limited')),  -- null while sending
           retry_after timestamptz, session_id text, error text check (char_length(error) <= 300)
actuals    id uuid pk default gen_random_uuid(), at timestamptz not null default now(),
           day date not null, task_id uuid not null, block_id uuid,  -- no foreign keys: outlives both
           kind text not null check (kind in ('course','campus','github','jira','other')),
           est_min int, minutes int not null check (minutes between 1 and 960)
habits     id uuid pk default gen_random_uuid(), name text not null check (char_length(name) between 1 and 40),
           days int[] not null check (days <@ '{1,2,3,4,5,6,7}' and cardinality(days) > 0),  -- ISO, 1 = Monday
           ideal time not null, minutes int not null check (minutes between 15 and 240 and minutes % 5 = 0),
           flex_min int not null default 30 check (flex_min between 0 and 240),
           defence text not null default 'flexible' check (defence in ('flexible','firm')),
           position double precision not null default 0, created_at timestamptz not null default now()
feedback   id uuid pk default gen_random_uuid(), at timestamptz not null default now(),
           item text not null check (item in ('proposal','block','needs_you','finished')),
           action text not null check (action in ('approve','skip','turn_down','done','not_needed',
                                                  'undo','finished','more','nostart','tomorrow')),
           ref jsonb not null                            -- ids only (below); append-only:
                                                         -- revoke update, delete from authenticated
triage_rules id uuid pk default gen_random_uuid(),
           match text not null check (match in ('address','domain')),
           pattern text not null check (pattern = lower(pattern) and char_length(pattern) between 3 and 254),
           action text not null check (action in ('always','never')),
           created_at timestamptz not null default now(), unique (match, pattern)
known_senders hash text pk check (hash ~ '^[0-9a-f]{64}$'), last_sent_at timestamptz not null
message_senders account text, message_id text, thread_id text not null,
           from_address text not null, at timestamptz not null, primary key (account, message_id)
reply_state account text, thread_id text, primary key (account, thread_id),
           state text not null check (state in ('owed','awaiting')),
           since timestamptz not null,                   -- the newest message's date
           message_id text not null,                     -- the newest message
           who text not null check (char_length(who) <= 80),   -- display name only, never an address
           updated_at timestamptz not null default now()
academic_days day date pk, entries jsonb not null default '[]',   -- academicEntries for the day (SRC3)
           fetched_at timestamptz not null default now()
weather_cache id boolean pk default true check (id), point text not null,
           forecast_url text,                            -- the point's forecastHourly, cached
           periods jsonb not null default '[]',          -- weatherPeriods output
           alerts jsonb not null default '[]',           -- weatherAlerts output
           fetched_at timestamptz
```

- **Feedback `ref`s:** proposal `{ day, rev }`; block `{ day, task_id }`; needs_you
  `{ account, message_id, from_address }`; finished `{ block_id, task_id }`.
- **Writers.** Server functions (service key) write `calendar_account`, `changes`, `replans`,
  `known_senders`, `message_senders`, `reply_state`, `weather_cache` and `academic_days`; the browser may read
  them, and delete `calendar_account`. `apply_proposal` runs as the owner (`security invoker`),
  so `changes` keeps `grant update (consumed_day, consumed_rev) … to authenticated` for it to
  mark the changes a revision read. /plan writes `habits` and `triage_rules`. Telegram and
  /plan insert `feedback`; nobody updates or deletes it but `nightly_roll`. Telegram inserts
  `actuals`.
- **Vault, the calendar grant** (as `mail_account_save` and `mail_refresh_token`, revoked from
  `public, anon, authenticated`):
  - `calendar_account_save(account text, refresh text) returns void` stores the token as
    `calendar_refresh:<account>`, reusing the secret on reconnect;
  - `calendar_refresh_token() returns text` returns it, or null;
  - deleting the row deletes its Vault secret (trigger `calendar_account_forget`).
  - `busy_sync_save(from_at timestamptz, to_at timestamptz, rows jsonb, change jsonb default null)
    returns void` (S1, service key only) is busy-sync's one call: it replaces the `calendar` busy
    rows overlapping `from_at` to `to_at`, sets `busy_as_of = from_at`, and inserts `change` into
    `changes` when given and the table exists.
  - `handshake_sync_save(from_at timestamptz, to_at timestamptz, rows jsonb) returns void`
    (SRC3, service key only) is ical-sync's Handshake write: it replaces the `handshake` busy rows
    overlapping `from_at` to `to_at`, and when that set changed inserts `{ kind: 'handshake',
    reason: 'handshake_change', weight: 3, ref: null }` into `changes` when the table exists.
- **Revisions.** Each function is `security invoker`, takes a row lock on `d`'s proposals
  rows, and raises with the exact text shown:
  - `apply_proposal(d date, replaces int, blocks jsonb, habit_blocks jsonb default '[]',
    needs jsonb default '[]', picks jsonb default '[]', note text default null,
    couldnt_fit uuid[] default '{}', suggested jsonb default '[]',
    run_trigger text default 'morning', reasons text[] default '{}') returns int` writes
    revision `coalesce(replaces, 0) + 1` and returns it.
    - It refuses `'the newest revision for % is %, not %'` (d, newest or 0, replaces or 0) unless
      `replaces` is d's newest revision (null when d has none).
    - It refuses `'the plan for % is already %'` when the newest is `skipped` or `lapsed`, or
      `days.shutdown` is true for d (then: `lapsed`).
    - It marks a `pending` newest revision `superseded`. An `approved` one stays approved.
    - It deletes d's proposed blocks and inserts `blocks` (`[{ task_id, starts_at, ends_at }]`)
      and `habit_blocks` (`[{ habit_id, starts_at, ends_at }]`) with `proposed = true`. It never
      touches a block with `proposed = false`.
    - It inserts the revision `pending` with `created_at = clock_timestamp()`, its `blocks` (both
      lists, in start order), `couldnt_fit`, `suggested`, `run_trigger` and `reasons`.
    - Needs you is as in v4: open items for d are replaced, `(account, message_id)` already there
      is skipped.
      **Decided (SRC2):** only `source = 'mail'` items are replaced; Slack items stay until done.
    - It sets `consumed_day = d, consumed_rev = <new rev>` on every `changes` row with both null
      and `at <= read_at`. **Fix:** `apply_proposal` takes a last argument `read_at timestamptz
      default null`, read_planner's `read_at` passed back by submit_proposal; null (an older
      prompt) means `now()`, as before, and a time after now reads as now. The revision keeps it
      in `proposals.read_at`, so a change logged while the run worked waits for the next replan.
    - The v4 `apply_proposal(date, jsonb, jsonb, jsonb, text)` is dropped, and V1 moves the v4
      apply_proposal checks in tools/test-schema.sh to this signature.
  - `approve_proposal(d date, rev int) returns int` refuses `'revision % of % is not the pending
    one'` unless `rev` is d's newest revision and it is `pending`. It then clears `proposed` on
    d's proposed blocks, sets the revision `approved`, and (A1) creates its suggested tasks. It
    returns the number of blocks approved.
  - `skip_proposal(d date, rev int) returns void` refuses the same way, then deletes d's proposed
    blocks and sets the revision `skipped`.
  - **Suggested tasks (A1)**, created by `approve_proposal`: one task per suggestion in the
    "Inbox" list, with `title`, `due`, `public = false`, `source = 'mail'` and
    `source_uid = account || ':' || message_id`. `feed_seen ('mail', source_uid)` is recorded, and
    a uid already in it is skipped, so a message makes one task, ever, even after he deletes it.
  - `lapse_proposals_on` and `nightly_roll` lapse every `pending` revision, not one row per day.
  - `turn_down(d date, task uuid) returns void` (owner, `security invoker`) deletes d's proposed
    blocks of `task` and appends it to `days.turned_down`, inserting the days row if needed.
    /plan's × on a proposed block calls it.
- **`nightly_roll()`** also deletes `changes`, `replans`, `reply_state` and `message_senders` rows
  older than 14 days, and `actuals` and `feedback` older than 120 days.
- **Cron jobs** (each as `sheet-brightspace`: an Edge Function URL and `sheet_cron_secret` from
  Vault, doing nothing until both exist):

  | Job | Schedule | Function | Vault URL name |
  |---|---|---|---|
  | `sheet-busy` | `*/10 * * * *` | `busy-sync` | `sheet_busy_url` |
  | `sheet-mail` | `2-59/5 * * * *` | `mail-sync` | `sheet_mail_url` |
  | `sheet-work` | `40 * * * *` | `work-sync` (GitHub, Jira) | `sheet_work_url` |
  | `sheet-slack` | `42 * * * *` | `slack-sync` | `sheet_slack_url` |
  | `sheet-ical` | `25 * * * *` | `ical-sync` (Handshake, academic) | `sheet_ical_url` |
  | `sheet-weather` | `50 * * * *` | `weather` | `sheet_weather_url` |

  The replan decision runs inside `sheet-telegram`'s minute tick. **Decided:** one function per
  ticket, so parallel tickets don't edit one file.
- **Decided:** the Handshake and academic calendar links are function secrets
  (`SHEET_HANDSHAKE_ICS`, `SHEET_ACADEMIC_ICS`), as `SHEET_BRIGHTSPACE_ICS` is, so no settings
  column holds them and the client never sees them.

### Pure modules (`src/sheet/`, no network, `node --test` covers them)

#### `freebusy.mjs`, new (S1)

- `freeBusyRequest(settings, now)` returns the body for `freebusy.query`
  (https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query):
  `{ timeMin, timeMax, items: [{ id }] }`.
  - `timeMin` is `now`, `timeMax` is `now` + 7 days, both `toISOString()`.
  - `items` is `settings.owner_email` (his main calendar's id), then `settings.calendars`, in
    order, once each, leaving out `settings.gcal_calendar_id` ("Time blocks").
- `freeBusyRows(response, now, blocksCalendar)` returns `{ rows, failed }`.
  - `rows` are `[{ starts_at, ends_at }]` from every calendar's `busy` list except
    `blocksCalendar`. They are `toISOString()` UTC, clipped to nothing: kept whole when they
    overlap `now` to `now` + 7 days, dropped otherwise, once per pair, sorted by start then end.
    Spans are not merged, as `busyRows` doesn't merge them.
  - `failed` lists the calendar ids whose entry has `errors`, in response order. A failed
    calendar adds no rows.
  - **Decided:** all-day events count as busy here, since free/busy can't tell them apart. Events
    marked free never appear in free/busy.
- `busyChange(before, after, blocks, now, timeZone)` returns one `changes` row
  `{ kind: 'busy', reason, weight, ref: null }`, or null when `after` equals `before` as sets:
  - `busy_overlap`, weight 10: a span in `after` and not in `before` overlaps a block (approved
    or proposed) today that ends after `now`;
  - `time_freed`, weight 4: otherwise, when busy minutes from `now` to midnight today fell by 60
    or more;
  - `busy_change`, weight 2: otherwise.

#### `replan.mjs`, new (R1)

- `REASON_WORDS`, the fixed reason names a `changes` row carries, and their words for Telegram.
  They are finer than the change kinds that routine-fire.mjs's `REASONS` lists (R0, landed):

  | reason | kind | weight | words |
  |---|---|---|---|
  | `busy_overlap` | busy | 10 | a busy time landed on a block |
  | `time_freed` | busy | 4 | time freed up |
  | `busy_change` | busy | 2 | busy times changed |
  | `course_due_soon` | course | 8 | a course task is due within 48 hours |
  | `course_change` | course | 3 | course tasks changed |
  | `campus_change` | campus | 3 | campus events changed |
  | `mail_owed` | mail | 8 | a known sender is waiting on a reply |
  | `mail_new` | mail | 2 | new mail |
  | `github_due_soon` / `github_change` | github | 8 / 3 | a GitHub item is due within 48 hours / GitHub items changed |
  | `jira_due_soon` / `jira_change` | jira | 8 / 3 | a Jira ticket is due within 48 hours / Jira tickets changed |
  | `slack_new` | slack | 3 | new Slack mentions |
  | `handshake_change` | handshake | 3 | Handshake events changed |

  A due date counts as "within 48 hours" when it is today, tomorrow or the day after.
- `shouldReplan(changes, state, now)` returns `{ fire: true, reasons, counts, ids }` or
  `{ fire: false, hold }`.
  - `changes` are the rows with `replan_id` and `consumed_rev` null. Rows with `at` after `now`,
    or at or before `state.seen_until`, are ignored (the plan already saw them, and the run's
    own proposal never counts). **Fix:** `seen_until` is the newest revision's `read_at`, or its
    `created_at` without one; a state without `seen_until` reads `last_plan_at` instead.
  - `state` is `{ settings: { time_zone, replans_on, morning_on }, day: today's days row | null,
    shutdown: "HH:MM", plans_today, last_plan_at, last_edit_at }`:
    - `plans_today`: 1 when today has a `morning` revision, plus today's `replans` rows that
      fired (result `started`, or null while sending); a `failed` or `rate_limited` row never
      ran and counts for nothing;
    - `last_plan_at`: the later of the newest revision's `created_at` and the newest such
      `replans.at`, today, or null;
    - `seen_until`: today's newest revision's `read_at ?? created_at`, or null;
    - `closed`: today's newest revision is `skipped` or `lapsed`;
    - `last_edit_at`: `settings.plan_edited_at`.
  - The holds, checked in this order, give `hold`:
    `replans_off`, `morning_off`, `quiet` (before 8:00 or from 23:00), `shut_down`
    (`day.shutdown`), `closed` (fix: `state.closed`, today's newest revision is `skipped` or
    `lapsed`, which apply_proposal would refuse anyway), `after_shutdown` (at or after the shutdown line), `daily_cap`
    (`plans_today` ≥ 8), `too_soon` (under 60 minutes since `last_plan_at`), `editing` (under 10
    minutes since `last_edit_at`).
  - Then the rules, over the changes left: fire when one has weight ≥ 8; or the weights add to
    ≥ 4 and the oldest is ≥ 15 minutes old; or any is ≥ 45 minutes old. With no changes, `hold`
    is `nothing`; with changes and no rule met, `waiting`.
  - On fire: `reasons` are the distinct reasons, highest weight first, then by name; `counts` is
    `{ kind: n }` for the kinds present; `ids` are the changes' ids.
- The fire text is routine-fire.mjs's `fireText("replan", counts)` (R0, landed), built from
  `counts` alone: `"trigger: replan\nreasons: mail 3, busy 1"`. The reason names stay on the
  server, in `replans.reasons` and the revision.
- `reasonWords(reasons)` returns their words joined with ", ", for the replan message.
- (R1 adds) `changeRow(reason, ref)` gives the `changes` row `{ kind, reason, weight, ref }` for a
  reason; `replanState({ settings, day, proposals, replans })` builds `state` from today's rows;
  `rateLimited(replans, now)` is true while a `retry_after` is ahead. feeds.mjs gains
  `courseChanges(out, tasks, today)` (one row per inserted or updated course task) and
  `campusChange(before, after, now, timeZone)`. **Decided:** a campus change counts only when
  the events left today differ, since the 14-day window changes almost every hour.

#### `pace.mjs`, new (P1)

- `paceKind(task)` returns the pace kind (see "Rules shared by every ticket").
- `PACE_SAMPLES = 5`, `PACE_WINDOW = 20`, `PACE_LIMITS = [0.5, 3]`.
- `paceByKind(actuals)` returns `{ course, campus, github, jira, other }`, each `{ pace, n }`:
  - per kind, the newest `PACE_WINDOW` rows (by `at`) with `est_min > 0`;
  - `n` is how many that is, and `pace` is the median of `minutes / est_min` over them (the mean
    of the middle two for an even count), clamped to `PACE_LIMITS` and rounded to 2 decimals;
  - `pace` is null when `n < PACE_SAMPLES`.
  - **Decided:** pace is computed here, not in SQL, so one function serves read_planner,
    Settings and the tests.
- `pacedMinutes(task, paces)` returns the minutes a block for `task` must have:
  `est = task.est_min ?? 30`, times the kind's pace when it isn't null, rounded to the nearest 15
  (half up), then held to 15–240. **Decided:** "est_min when pace has too few samples" is read
  as est_min rounded the same way, which is what the morning task already does.
- `plannedVsDone(blocks, tasks, day, timeZone)` returns `[{ day, planned_min, done_min }]` for
  the 14 days before `day`, oldest first, leaving out days with no approved block: `planned_min`
  sums approved blocks' minutes on that day, `done_min` those whose task is done.

#### `proposal.mjs`, extended

- **`planSnapshot(rows, now)`** takes v4's rows plus `actuals`, `habits`, `turnedDown` (plan_day's
  `days.turned_down`), `replan` (the newest `replans` row today, or null), `changes` (rows with
  `at` after the newest revision's `created_at`), `triage`, `replyState`, `weather` (the
  `weather_cache` row or null) and `academic` (plan_day's academic calendar entries); a row set
  that isn't given reads as none. It returns v4's fields plus (the v4 shape test pins only v4's):
  ```
  version: 5,
  run: { trigger: "morning" | "replan", reasons: [reason], changes: { kind: n } },
  window: { from: "HH:MM", to: "HH:MM" },
  day_rules: { workload_cap_min, travel_min: 10, break_after_min: 90, break_min: 10 },
  tasks[] + paced_min,                 -- pacedMinutes
  pace: paceByKind(actuals),
  planned_vs_done: plannedVsDone(...),
  turned_down: [task_id],              -- and those tasks leave `tasks`
  habits: [{ id, name, ideal: "HH:MM", minutes, flex_min, defence }],   -- plan_day's weekday;
                                       -- firm ones first, then flexible, each by ideal, then position
  triage_rules: [{ match, pattern, action }],
  reply_state: { owed: [{ account, thread_id, who, since }], awaiting: [ … ] },
  weather: weatherHours(...),          -- [] without a cache
  academic: [{ title, all_day }],
  proposal: { rev, status, created_at, run_trigger } | null   -- the newest revision
  ```
  - `run.trigger` is `replan` when `replan` exists with result `started`, its `at` is after the
    newest revision's `created_at`, and it is under 30 minutes old; its `reasons` are then the
    replan's. Otherwise `morning` with `reasons: []`.
  - **plan_day of a replan run** (fix): `rows.plan_day`, when given, is the day planned.
    planner-mcp sets it with `planDayOf(now, time_zone, replan, todayRevision)`: today when
    today's newest `replans` row is `started`, under 30 minutes old and after today's newest
    revision, so a replan from 3 pm to shutdown plans the rest of today; otherwise v4's 3 pm
    rule. `snapshotQueries`, `paceQueries` and `replanQueries` take that plan_day, and
    `todayReplanQueries(now, time_zone)` reads the two rows it is decided from. A `replan` row
    of another day never makes a replan run.
  - `window.from` is 07:00, or, when plan_day is today, the later of 07:00 and now rounded up
    to the next quarter hour (9:07 → 09:15, 9:15 → 09:15). `window.to` is `shutdown`.
  - **Decided:** locked blocks stay in `blocks` with `proposed: false` rather than being copied
    into `busy`, so the travel gap applies to busy times only, not between his own blocks.
- **`checkProposal(input, snapshot, senders = {})`**. With `version: 5`, `input` also takes
  `replaces` (int or null), `couldnt_fit` ([task_id]), `suggested` ([{ account, message_id,
  title, due, kind }]) and `habits` ([{ habit_id, start: "HH:MM" }]); absent lists are `[]`.
  `senders` maps `"<account> <message_id>"` to the message's From address (planner-mcp reads it
  from `message_senders`). With `version: 5` it returns `{ ok, errors, rows, dropped }`
  (`rows` null and `dropped` `[]` when it fails), and v4's rules hold, plus:
  - **day and revision:** the proposal may be absent, `pending` or `approved` (a replan after
    approval). `skipped` and `lapsed` are refused as in v4 (field `day`). `replaces` must equal
    `snapshot.proposal?.rev ?? null`, or the error names `replaces`.
  - **blocks:**
    - A block for a task in `turned_down` is refused ("turned down today").
    - Each block lies inside `window`: it starts at or after `window.from` and ends by
      `window.to`. The error names the window's start or end.
    - `minutes` equals the task's `paced_min`.
    - No block (or habit block) overlaps a busy time widened by `travel_min` on each side. A block
      over the busy time itself keeps v4's error ("overlaps a busy time 2:00–3:20 pm"); one only
      inside the gap gets "needs 10 minutes of travel time around the busy time 2:00–3:20 pm".
      A block may end exactly 10 minutes before a busy time starts.
    - **The break rule:** take the day's approved blocks, the proposal's blocks and its habit
      blocks (not the pending revision's proposed blocks, which it replaces), sorted by start.
      Blocks less than `break_min` apart join one run. No run that holds a proposed block may
      span more than `break_after_min` from its first start to its last end. The error names the
      proposed block that carries the run past 90 minutes, or the latest proposed block in the
      run when that is an approved one. **Decided:** a single block longer than 90 minutes is
      allowed; the rule is about blocks in a row.
    - **The workload cap:** the minutes of the day's approved blocks (past ones too), the
      proposal's blocks and its habit blocks add up to at most `workload_cap_min`. The error
      names `blocks` and the cap ("blocks: 6h30 planned, over the 6h00 workload cap").
  - **habits:** each `habit_id` is in `snapshot.habits`, at most once; `start` is "HH:MM" and
    within `ideal ± flex_min` (inclusive); the block runs `minutes`, inside `window`, and obeys
    the overlap, travel, break and cap rules. Errors name `habits[i]`.
  - **couldnt_fit:** at most 12 ids, each in `snapshot.tasks`, none twice, none also placed in
    `blocks`. Errors name `couldnt_fit[i]`.
  - **suggested:** at most 5. `account` and `message_id` match an item in this submit's
    `needs_you`, at most one suggestion each; `title` is free text (v4's `text` rule) of at most 80
    characters; `due` is a date and required; `kind` is `assessment` or `interview`. Errors name
    `suggested[i]`.
  - **never-show rules:** a `needs_you` item whose From address (`senders`) matches a `never`
    rule in `snapshot.triage_rules` (address: equal; domain: equal to the address's domain or a
    parent of it, so `mail.example.com` matches `example.com`) is dropped, not an error.
    `dropped` lists `[{ index, message_id, pattern }]`, and a suggestion for a dropped item is
    dropped with it. An `always` rule never drops anything.
  - **read_at** (fix): optional; `planSnapshot` returns `read_at` (its `now`), and a submitted
    `read_at` must be a time no later than the fresh snapshot's, or the error names `read_at`.
    When given, `rows.read_at` carries it (ISO, UTC); without it `rows` has no `read_at`.
  - **rows**, when ok, are `apply_proposal`'s named arguments: `{ d, replaces, blocks,
    habit_blocks, needs, picks, note, couldnt_fit, suggested, run_trigger, reasons }`, where
    `run_trigger` and `reasons` are `snapshot.run`'s, `needs` carries `from_address` from
    `senders` (null when unknown), and `habit_blocks` are `[{ habit_id, starts_at, ends_at }]`.
- **`proposalLines`** adds, after "Didn't fit": `"Couldn't fit: HW3, Lab 4."` (titles from
  `tasks`, cut to 30 characters, at most 3, then `" +2 more"` before the period), and one line
  per suggestion: `"Task to add: HackerRank assessment (due Nov 7)"`, the date as
  `dayLabel(due).date`.

#### `nudges.mjs`, extended

- **The snapshot** gains `busy` (today's busy rows), `weather` (the `weather_cache` row),
  `academic` (today's entries), `awaiting` (the `reply_state` rows with state `awaiting`) and
  `replanSent` (how many `replan` nudges went out today). `proposal` is today's newest revision,
  with `rev` and its `blocks`; for a plan tap, the tapped day's newest. `previous` (R1) is the
  revision before it that day, with `status` and `blocks`, or null.
- **Plan buttons** carry the revision when the proposal has one: `pa:<day>:<rev>` and
  `ps:<day>:<rev>`.
- **Taps.** `readTap` reads `pa:<day>:<rev>` and `ps:<day>:<rev>`, with a revision 1–999 without
  leading zeros, as `{ action: "pa" | "ps", day, rev, query_id, chat_id, message_id }`; anything
  else after the day is ignored (null). A v4 `pa:<day>` still reads as in v4, with no `rev`.
  **Decided:** `handleTap` treats a tap with no `rev` as rev 1 when the proposal has a `rev`, and
  as v4 did when it hasn't.
  - `handleTap` on a plan tap answers, in this order: "That plan has lapsed" (no proposal for that
    day, or the newest is `lapsed`); "A newer plan is out" (`tap.rev` below the newest `rev`);
    "Already approved" or "Already skipped"; otherwise it acts.
  - Approve all returns `{ changes: [{ rpc: "approve_proposal", args: { d, rev } }], text:
    "✓ Approved 3 blocks" }`, counting the day's proposed blocks (`proposedOn`). Skip returns
    `{ changes: [{ rpc: "skip_proposal", args: { d, rev } }], text: "Skipped. Plan in /plan when
    you're ready." }`. The webhook calls the function, which refuses a revision that moved on in
    the meantime.
  - A change may now be `{ rpc, args }`, which the webhook sends as a PostgREST rpc call.
- **The `proposal` message** goes out for `morning` revisions only, as in v4, once per
  `created_at`. `replan` revisions get the replan message instead.
- **The replan message** (`kind: "replan"`, `block_id: null`, `send_at` = the revision's
  `created_at`): for a pending `replan` revision whose proposed blocks differ, as a set of
  `{ task_id | habit_id, starts_at, ends_at }`, from the previous revision's when that one was
  pending (its status is `superseded` by then), or from none when it was approved or there is none. At most 4 a day (`replanSent`), 8 am to 11 pm,
  outside the budget. Its text:
  ```
  Replan: a busy time landed on a block, new mail.
  + 4:00 pm · HW3 (45 min)
  − 2:00 pm · Gym
  Couldn't fit: Lab 4.
  ```
  `+` lines are blocks new in this revision, `−` lines blocks gone from the previous one, each
  earliest first, at most 6 of each. Its buttons are the plan buttons.
- **The Finished? check** (`kind: "finished"`), for each of today's approved blocks:
  - due at the block's `ends_at`, when its start nudge went out (a `start` row at its current
    `starts_at`), its task isn't done, the day isn't shut down (`day.shutdown`), and `ends_at`
    is before 23:00;
  - sent up to 30 minutes late (`FINISHED_LATE`), once per `send_at`;
  - it counts toward the nudge budget, like a repeat: it takes a slot only when
    `used + held < BUDGET`;
  - text `"Finished? · OS homework"`, buttons **Finished** (`finished:<block id>`), **More
    time** (`more:<id>`), **Didn't start** (`nostart:<id>`) and **Tomorrow** (`tomorrow:<id>`).
  - `readTap` reads these four as `{ action, block_id, … }`, as "done:" and "snooze:" are.
- **The Finished? answers** (`handleTap`). A missing block gives "That block is no longer on the
  plan."; a done task gives "✓ Done", both with no changes.
  - **Finished:** v4's Done changes, plus `{ table: "actuals", insert: { day, task_id, block_id,
    kind, est_min, minutes } }`. `minutes` adds, over the task's approved blocks that started
    before `now`, the time from start to the earlier of end and `now`, rounded. `kind` is
    `paceKind(task)`. Text: `"✓ Done in 45 min · OS homework"`.
  - **More time:** when 30 minutes from `ends_at` overlap no busy time and no other approved
    block, and end by 23:00: `{ table: "blocks", id, update: { ends_at } }`, plus a
    `gcal_pending` insert `{ gcal_id, ends_at }` when the block has an event. Text: `"More time:
    until 10:45 am · OS homework"`. The next Finished? follows at the new end. Proposed blocks
    don't count as taken. When the slot isn't free: `"The next 30 min aren't free · OS
    homework"`; past 23:00: `"Too close to quiet hours · OS homework"`; no changes either way.
  - **Didn't start:** no changes; text `"Left open · OS homework"`.
  - **Tomorrow:** the task's blocks today that haven't started are deleted (proposed ones too;
    with `gcal_pending` `{ gcal_id, ends_at: null }` for those with an event). A task on a day
    with no `at_time` rolls: `{ rpc: "roll_tasks", args: { ids: [task_id], target: <tomorrow> }
    }`. Any other task moves: `{ table: "tasks", id, update: { day: <tomorrow>, list: null } }`.
    Text: `"Moved to tomorrow · OS homework"`.
  - **Decided:** only Finished writes `actuals`; every answer is logged in `feedback` (L1).
- **The brief** adds, in this order after its at-risk line: the weather line (`weatherLine`,
  when `weather` has periods), `"Calendar: No classes, Last day to withdraw."` (today's
  academic entries, at most 3), v4's plan lines (now with "Couldn't fit" and "Task to add"),
  and `"Awaiting reply: 2 (Ana Ruiz, Prof. Kim)."` (names cut to 30, at most 3).

#### `mail.mjs`, extended (M1, A1)

- `businessDays(fromIso, toIso, timeZone)` counts the Mondays to Fridays after `fromIso`'s local
  date, up to and including `toIso`'s.
- `automatedSender(headers)` is true when the From address's local part is like `noreply`,
  `no-reply`, `donotreply`, `notifications`, `mailer-daemon` or `bounce`, or a `List-Id`,
  `List-Unsubscribe`, `Auto-Submitted` (not `no`) or `Precedence: bulk|list|junk` header is
  present.
- `replyState(thread, timeZone, now)` takes `{ account, thread_id, messages: [{ id, date,
  labels, from, to, automated }] }` and returns `{ state, since, message_id, who }` or null:
  - from the newest message not in `SPAM` or `TRASH`;
  - `owed` when it isn't `SENT`, isn't automated, and `businessDays(date, now) >= 2`; `who` is
    the From display name;
  - `awaiting` when it is `SENT` and `businessDays(date, now) >= 3`; `who` is the first To
    display name;
  - a display name is the part before `<`, unquoted; with none, the address's local part.
  - **Decided (M1):** null when that newest message carries `CATEGORY_PROMOTIONS`,
    `CATEGORY_UPDATES`, `CATEGORY_SOCIAL` or `CATEGORY_FORUMS` (`skippedCategory(labels)`), so
    the categories spec 47 skips never reach Reply owed or Awaiting reply.
- `mailChanges(added, owed)` (M1) gives the mail sync's `changes` rows, `added`'s first:
  - `added`, the messages new since `history_id`, as `[{ id, labels, automated }]`: one
    `mail_new` (weight 2, `ref` the id) per message that isn't `SENT`, `SPAM` or `TRASH`, isn't
    automated and isn't in a skipped category;
  - `owed`, the threads whose state turned `owed` this sync (not `owed` at the same message
    before), as `[{ message_id, known }]`: one `mail_owed` (weight 8, `ref` the message id) per
    known sender's thread; an unknown sender's adds nothing more.
- `senderHash(address, salt)` returns the hex SHA-256 of `salt + address.trim().toLowerCase()`
  (async, `crypto.subtle`). The salt is the function secret `SHEET_SENDER_SALT`.
- `assessmentSender(from)` returns `assessment` for hackerrank.com, codesignal.com,
  codility.com and hirevue.com, `interview` for karat.com, calendly.com and goodtime.io, each
  with any subdomain, and null otherwise.
- `messageSummary` gains `known` (boolean) and `reply_state` (`'owed' | 'awaiting' | null`), set
  by mail-mcp from `known_senders` and `reply_state`.

#### `sources.mjs`, new (W1 creates it; SRC1–SRC3 add to it)

- `weatherPeriods(geojson)` maps an NWS `forecastHourly` response
  (https://www.weather.gov/documentation/services-web-api) to `[{ start, end, temp_f, pop,
  short }]`: `start` and `end` as `toISOString()`, `temp_f` the temperature (a `C` unit
  converted, rounded), `pop` the `probabilityOfPrecipitation.value` (null is 0), `short` the
  `shortForecast`.
- `weatherAlerts(geojson)` maps `/alerts/active` features to `[{ event, starts, ends }]`:
  `starts` is `onset`, or else `effective`; `ends` is `ends`, or else `expires`; both
  `toISOString()`.
- `weatherLine(periods, alerts, day, timeZone)` returns the brief's line, or null when no period
  starts on `day` from 08:00 to before 23:00:
  - **Spans:** periods in that range with `pop >= 40`, joined while each starts when the last
    ends. A span reads `"<Kind> <span> (<max pop>%)"`, where Kind is `Snow` when any of its
    periods' `short` says snow, else `Storms` for thunderstorms, else `Rain`, and the span is
    written as `formatSpan` writes it from the first start to the last end. Up to 3 spans, joined
    with ", ".
  - **Temperature:** `"<min>–<max>°F"` over the same periods, or `"<t>°F"` when they are equal.
  - **The line:** `"Weather: Rain 2–5 pm (70%), 41–54°F."`, or `"Weather: dry, 41–54°F."` with no
    span. Alerts whose time overlaps `day` add `" Alert: Wind Advisory."` (distinct events, at
    most 2, joined with ", ", each skipped when `linkish`).
- `weatherHours(periods, day, timeZone)` returns read_planner's `weather`: the periods starting on
  `day` from 07:00 to before 23:00, as `[{ at: start, temp_f, pop, short }]`.
- `githubTaskChanges(items, { tasks, seen, orgs, today })` takes GitHub search results
  (`is:open review-requested:@me` and `is:open assignee:@me`, merged) and returns `{ insert,
  update, close, seen, changes }`, as `courseTaskChanges` does:
  - only repositories in `orgs`; `source = 'github'`, `source_uid` the item's `html_url`,
    `link` the same, list "GitHub", `public = false`;
  - title `"Review: <title>"` for a pull request, `"<title>"` for an issue, through `cutTitle`;
    `due` from the milestone's `due_on`, else null; never `body`;
  - `close`: the ids of undone GitHub tasks whose uid isn't in `items`, to be marked done;
  - an item listed twice (in both searches) counts once; `seen` is `[{ source, uid }]` per insert;
  - `changes`: one row per insert, reason `github_due_soon` (weight 8) when due within 48 hours,
    else `github_change` (3), `ref` the uid.
- `jiraTaskChanges(issues, { tasks, seen, site, today })` does the same for a JQL search
  (`assignee = currentUser() AND statusCategory != Done`): `source_uid` the key, `link`
  `https://<site>/browse/<key>`, title `"<KEY> <summary>"`, `due` from `fields.duedate`, list
  "Jira". `issues` is the response's `issues` array; `fields.description` is never read.
  - **Decided (SRC1):** work-sync closes nothing on a run whose list may be cut short (a GitHub
    search with `incomplete_results` or more than 100 results, Jira pages left after 5), and
    skips a source with no token. `githubOrgsFromInput(value)` parses Settings' orgs field
    (comma or space separated, lower case, once each; undefined when one isn't a GitHub login).
    A GitHub or Jira task's source icon on /plan links to `link`.
- `slackNeeds(matches, { known })` takes `search.messages` matches and returns `needs_you` rows:
  `{ source: 'slack', account: 'slack', message_id: '<channel id>:<ts>', link: permalink,
  sender: <username>, subject: '#<channel name>' or 'Direct message', why: 'Mentioned you' or
  'Sent you a direct message', kind: 'reply' }`. Never `text`. Permalinks must start with
  `https://` and hold `.slack.com/`, or the match is skipped. Rows in `known` (already there)
  are skipped.
  - **Decided (SRC2):** a match is a direct message when `channel.is_im`; `known` is the slack
    `needs_you` rows already saved, `[{ message_id }]`; a match listed twice (the mentions and
    DM searches overlap) gives one row.
  - **Decided (SRC2, at build):** `known` also takes the ids in `feed_seen ('slack', id)`, which
    slack-sync writes with each row, since `nightly_roll` deletes done rows. An optional `self`
    (his user id from `auth.test`) leaves out his own messages. Channel names and usernames must
    be Slack words (`[\w.-]{1,80}`): a channel that isn't is skipped, a username that isn't reads
    "Someone". `slackLink` (morning.mjs) is the permalink check, shared with /plan: https:// and a
    host ending in `.slack.com`. slack-sync searches `<@USERID> after:<date>` and
    `to:me after:<date>`, from the day before its last good sync, and writes one `slack_new`
    change per new row.
- `handshakeBusy(events)` returns busy rows (`source = 'handshake'`) for parsed Handshake events
  whose summary starts with "Interview" or "Appointment" (case aside); other events are left out.
- `academicEntries(events, day, timeZone)` returns `[{ title, all_day }]` for parsed academic
  calendar events on `day`, in feed order, titles cut to 80 and skipped when `linkish`. An all-day
  event is on the days from its `start` to before its `end` (parseIcs gives both as dates); a
  timed one when it overlaps `day` in `timeZone` (parseIcs gives UTC). **Decided:** the zone is
  needed for timed events, which parseIcs returns as UTC instants.
- `enrollmentTask(enrollmentAt, timeZone)` (SRC3) returns the task for `settings.enrollment_at`,
  or null when it is null: `{ title: "Enrollment opens", day, at_time: "HH:MM", est_min: 15,
  public: false, list: null, source: 'enrollment', source_uid: 'enrollment' }`, `day` and
  `at_time` local. ical-sync upserts it on `(source, source_uid)`, so there is one such task, and
  leaves it alone once done.

#### `triage.mjs`, new (L1)

- `triageLabels(feedback)` turns `needs_you` feedback rows into labels `[{ account, message_id,
  needed }]`: per `(ref.account, ref.message_id)`, the newest row by `at` decides: `done` is
  `needed: true`, `not_needed` is `needed: false`, `undo` leaves no label. In order of each
  message's first row.
- `scoreTriage(items, labels)` compares a run's Needs you items (`[{ account, message_id }]`) with
  labels and returns `{ caught, missed, wrongly_shown }`, each a list of `"<account> <message_id>"`
  keys, once each: `caught` the items labelled needed, `missed` the labels needed that no item
  matches (label order), `wrongly_shown` the items labelled not needed (item order). Unlabelled
  items are in none. A small CLI (`tools/triage-score.mjs`) runs it on the live tables read-only.
- `neverOffers(feedback, rules)` returns the From addresses /plan offers "Never show mail from
  <address>" for, sorted: those with at least two different messages whose label (as
  `triageLabels`) is not needed, unless a rule already covers the address (an `address` rule
  equal to it, or a `domain` rule matching it as the never-show rules do, either action). Rows
  with no `from_address` count for nothing.
- **Decided (L1):** `tapFeedback(tap, snapshot)` gives the row a Telegram tap logs (Approve all or
  Skip on the pending revision, each Finished? answer), or null; telegram inserts it after the
  tap's changes, and not when a newer plan refused it. `needsFeedback(row, action)` gives /plan's
  Needs you row. `ruleMatches` and `neverRule` are the match checkProposal drops by.
  `tools/triage-score.mjs <run.json> [days]` scores a run file (a list of `{ account, message_id
  }`, or a submit_proposal input) against the labels of the last 14 days' feedback; done
  `needs_you` rows go hourly, so the live table can't give a past run's items.

### Edge Functions

| Function | Called by | Auth | Does |
|---|---|---|---|
| `calendar-connect` | /plan Settings | as `mail-connect` | `/start` and `/callback` for the free/busy grant |
| `busy-sync` | `sheet-busy` | `x-sheet-cron` | free/busy → `busy` (source calendar), `busy_as_of`, a busy change |
| `mail-sync` | `sheet-mail` | `x-sheet-cron` | history → `reply_state`, `message_senders`, `known_senders`, mail changes |
| `work-sync` | `sheet-work` | `x-sheet-cron` | GitHub and Jira → tasks, changes |
| `slack-sync` | `sheet-slack` | `x-sheet-cron` | Slack → `needs_you` rows, changes |
| `ical-sync` | `sheet-ical` | `x-sheet-cron` | Handshake → `busy` (source handshake, `handshake_sync_save`); academic → `academic_days`; `enrollment_at` → its task |
| `weather` | `sheet-weather` | `x-sheet-cron` | NWS → `weather_cache` |
| `telegram` | as before | as before | plus the replan decision and fire, Finished?, replan messages, rpc changes |
| `planner-mcp` | as before | as before | read_planner and submit_proposal with the v5 fields |
| `mail-mcp` | as before | as before | search results gain `known` and `reply_state` |

- **Every sync** records itself in `feed_state` under its source name (`freebusy`, `gmail`,
  `github`, `jira`, `slack`, `handshake`, `academic`, `weather`), never with a URL or token in
  `error`. One with no secret returns `{ ok: true, skipped: "not connected" }` and writes
  `feed_state` with `ok = null, error = 'not connected'`.
- **calendar-connect** asks for `openid email https://www.googleapis.com/auth/calendar.freebusy`
  with `access_type=offline`, `prompt=consent` and `login_hint` the owner's email, and accepts
  the grant only when the ID token's verified email is `settings.owner_email`. **Decided:** the
  identity scopes are there only to prove whose account it is.
  **Decided (S1):** it shares mail-connect's `MAIL_STATE_SECRET` and `mail_connect_states`, its
  state carries `grant: 'calendar'`, and it returns to `/plan/?calendar=connected` or
  `?calendar=error&reason=…`. A calendar Google answers with `errors` makes the `freebusy` feed
  fail ("1 calendar couldn't be read") while the other rows are still saved.
- **busy-sync** refreshes the token, posts `freeBusyRequest`, then in one call replaces the
  `calendar` busy rows from now to 7 days ahead with `freeBusyRows`, stamps `busy_as_of`, and
  writes `busyChange`'s row. A refused refresh sets `calendar_account.last_error` and a failed
  `freebusy` feed, which raises the feed alert. The browser save stays, and replaces only
  `source = 'calendar'` rows.
- **mail-sync** calls `users.history.list` from `history_id` (a 404 resets it from
  `users.getProfile`), then `messages.get` with `format=metadata` and `metadataHeaders` From, To,
  List-Id, List-Unsubscribe, Auto-Submitted and Precedence, never `full` or `raw`. It skips
  `CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES`, `CATEGORY_SOCIAL` and `CATEGORY_FORUMS`.
  **Decided (M1):** every Gmail read also names its `fields` (mail.mjs's `metadataQuery`), since
  metadata replies otherwise carry `snippet`, a piece of the text. History is read whole per
  touched thread (`threads.get`, format=metadata). Business days pass only at local midnight, so
  the first good run of each local day (and a full sync) also sweeps: `messages.list` with
  `newer_than:14d -in:drafts`, then each thread's newest message. A full sync logs no changes.
  **Fix:** a run reads at most 50 touched threads (`threadsToRead(threads, more)`); when it cuts
  any off, or history pages are left over, the run is a full sync (fresh `history_id`, a sweep),
  so the threads it skipped are swept rather than lost.
  mail.mjs adds `parseAddresses`, `metadataQuery`, `syncMessage`, `syncThread`,
  `historyChanges`, `newestPerThread`, `replyDiff` and `searchMarks` for it and mail-mcp.
- **The replan tick** in `telegram`'s send job: it reads the state, runs `shouldReplan`, and on
  fire claims the replan with `claim_replan(d, reasons, counts, ids) returns uuid` (service key
  only), which in one transaction inserts the `replans` row (result null) and sets `replan_id` on
  the open changes in `ids`, or returns null when another claim holds: a row for d still sending
  or `started` under 60 minutes ago, or a `retry_after` still ahead. On null the tick holds
  (`claimed`). Then it calls routine-fire.mjs's `fireRoutine(fetch, { routineId:
  SHEET_ROUTINE_ID, token: SHEET_ROUTINE_TOKEN, trigger: "replan", counts }, now)` and writes
  `fireOutcome(out, thrown)` (replan.mjs): `started` and the session id, `failed` and the error
  type (a throw is `failed` with its message, cut to 300), or `rate_limited` with `retry_after`
  set to `retry_at`. On `failed` or `rate_limited` it unties the row's changes (`replan_id`
  null), so they are weighed again. No replan fires before `retry_after`, and a request is never
  retried without a new `replans` row. The token lives only in the function's env.
- **`read_planner()`** returns `planSnapshot` as above.
- **`submit_proposal({ day, replaces, read_at, blocks, habits, needs_you, picks, note, couldnt_fit,
  suggested })`** reads `message_senders` for the submitted items, runs `checkProposal`, and on
  success calls `apply_proposal` and returns `{ ok: true, rev, blocks: n, habits: n,
  needs_you: n, dropped: [message_id] }`.

### /plan

- **Settings** gains rows for: the calendar (Connect or Reconnect, and "Busy times saved 4 min
  ago" from `busy_as_of`), replans on or off, the workload cap (in hours, 1–16, step 0.5), pace
  per kind ("Course ×1.4 (12)", or "Course: 3 of 5 needed"), habits, triage rules, the
  enrollment time, and a status row for each source in `feed_state`.
- **Needs you** gains Not needed (with undo) beside Done, Slack rows with their icon, a link
  only when it starts with `https://` and holds `.slack.com/` for Slack rows, an "Awaiting reply"
  group, and on a row with a suggestion, "Add task". After two `not_needed` feedback rows with the
  same `from_address`, it offers "Never show mail from <address>", which adds a `never` rule on
  confirm.
- **The proposal banner** shows "Revision 2" beside "Claude proposed 3 blocks", and the couldn't
  fit titles. **Fix:** while the revision is pending, its notes also list each suggested task,
  `"Task to add: HackerRank assessment (due Nov 7)"` (`suggestedLine`, as the brief's).
- **Approve all** (fix) on a pending revision calls `approve_proposal(d, rev)` (`approveAllCall`
  in morning.mjs), as Telegram's Approve all does, so the revision becomes `approved` and its
  suggested tasks are made; then the week and the notes reload, and the approved blocks get
  their Google events as off-page approvals do. Without a pending revision it approves each
  proposed block, as in v4. Approving or moving a single block is unchanged.
- **Icons:** `repeat` (habit), `github` and `kanban` (Jira), from Lucide; GitHub and Jira tasks
  get source edges like course tasks.
- **The load bar** takes `workload_cap_min` as its capacity.
- **/now** shows none of GitHub, Jira, Slack or habit items: habit blocks never reach
  `public_now`, and GitHub and Jira tasks are private.
- /plan stamps `settings.plan_edited_at` at most once a minute while it writes tasks or blocks.

### The morning task

- `docs/sheet-morning-task.md` gains, by ticket: the window and locked blocks, `replaces` (V1);
  reasons and changes (R1); reply_state in place of its own Reply owed search (M1); paced
  minutes (P1); the cap, breaks, travel and couldn't fit (D2); habits (H1); triage rules (L1);
  suggested tasks (A1); weather (W1). The live routine is updated to match, and keeps exactly
  its two connectors.
- It reads the fire payload only as reason names and counts, as untrusted data.

## Out of scope

As spec 47: push notifications, solvers, Brightspace's API, scrapers, mail text on the server,
drafting or sending replies, moving blocks dragged in Google back, confidence scores and the
SimplifyJobs list.

## Quality bar

- Verification tests come first, in test/v5-*.verify.test.mjs, written from this contract with
  hand-worked expectations, all `{ todo: true }` until the ticket's implementer removes them one
  at a time. tools/test-schema.sh's v5 checks skip themselves until the schema they test exists.
  - Written now: test/v5-busy (S1), v5-revisions (V1), v5-pace (P1), v5-day (D2) and v5-weather
    (W1, with test/fixtures/nws-hourly.json), and tools/test-schema.sh's "v5 V1, revisions".
  - The other tickets' verification tests are written from this contract before each starts.
  - Two older tests were narrowed so v5's additions don't break them, with their expectations
    unchanged: the v4 planSnapshot shape test now compares v4's fields only, and nudges.test's
    late-repeat test looks only at repeats, since a Finished? check is due at a block's end.
- Each ticket keeps `npm test` and `npm run check` green, and /plan's script at or under 60 KB.
- tools/verify-sheet-v5.sh (Z1) checks, read-only: `busy_as_of` under 15 minutes old; at most 8
  plans today; every `replans` row has a result; anon refused on every new table; each connected
  source synced within its interval; the routine has only its two connectors.

## Setup

v5 goes live in one wave, from one sheet-v5 commit that holds every ticket (48–63): the schema,
then every function, then /plan, then the morning task's prompt. Nothing here has been run yet.
Steps marked **[Lisul]** need him; the rest an agent can do. Secrets are named here, never given:
Lisul pastes each value himself, in the Supabase dashboard (Edge Functions → Secrets).

```bash
REF=bmbsvvprpfdbvalnkowp
URL=https://$REF.supabase.co
SB="npx -y supabase@latest"
```

### Why it is one wave

- The V1 schema drops the v4 `apply_proposal(date, jsonb, jsonb, jsonb, text)` and keys
  `proposals` on `(day, rev)`. The live v4 planner-mcp calls the dropped function, so every
  submit fails until v5 planner-mcp is deployed, and once a day has rev 2, v4 Telegram and /plan
  read several rows for it. Run steps 4 to 6 back to back, outside the 6:07 run.
- v5 telegram, planner-mcp and /plan read `weather_cache`, `actuals`, `calendar_account`,
  `habits`, `reply_state`, `academic_days`, `changes`, `replans`, `couldnt_fit`, `rev` and
  `busy.source`, and write `finished` and `replan` nudges, `feedback` and `actuals`: the schema
  must come first.
- The prompt sends `replaces`, `couldnt_fit`, `habits` and `suggested`, so it goes after
  planner-mcp.

### Before

1. **Build from a clean checkout** of the commit, never a working tree:
   `npm ci && npm test && npm run check && bash tools/test-schema.sh` (test-schema needs Docker).
2. **Take a read-only baseline:** `bash tools/verify-sheet-v4.sh`; `$SB secrets list
   --project-ref $REF` (names only); and with `$SB db query --remote=$REF --read-only`, the names
   in `vault.secrets`, the jobs in `cron.job`, and `select count(*) from busy where starts_at is
   null or ends_at is null`, which must be 0, since S1 makes both `not null`. Save the morning
   task with `RemoteTrigger get` (prompt, connectors, triggers, including the API trigger). Pick
   a window clear of 05:45–06:45 America/New_York and of the brief time: midday, after today's
   plan is approved or skipped.
3. **[Lisul] Google Cloud**, on the project that owns the mail-connect OAuth client:
   - APIs & Services → Library: enable the **Google Calendar API**.
   - Credentials → that web client → Authorized redirect URIs: add
     `https://bmbsvvprpfdbvalnkowp.supabase.co/functions/v1/calendar-connect/callback`, keeping
     the mail-connect and Auth ones.
   - Google Auth Platform → Data Access: add `https://www.googleapis.com/auth/calendar.freebusy`
     (with `openid` and `email`).
   - Audience: **In production**. In Testing, refresh tokens die after 7 days. Expect the
     "unverified app" screen at consent (ADR 0004).

### Deploy

4. **The schema:** `$SB db query --remote=$REF --yes --file supabase/schema.sql`. It is safe to
   re-run. It adds every v5 column and table in "Schema" above; the functions `apply_proposal`
   (the v5 signature), `approve_proposal`, `skip_proposal`, `turn_down`, `busy_sync_save`,
   `handshake_sync_save`, `calendar_account_save`, `calendar_refresh_token` and the
   `calendar_account_forget` trigger; the new `nightly_roll`; and the cron jobs `sheet-busy`,
   `sheet-mail`, `sheet-work`, `sheet-slack`, `sheet-ical` and `sheet-weather`. Each job does
   nothing until its Vault URL exists (step 7). **From here until step 5, submit_proposal
   fails.**
5. **The changed functions**, straight after: `planner-mcp`, then `telegram`, then `mail-mcp`.
6. **The new functions:** `busy-sync`, `calendar-connect`, `mail-sync`, `work-sync`,
   `slack-sync`, `ical-sync` and `weather`; and again `brightspace` and `campus` (they now log
   course and campus changes), `mail-connect` (it shares `_shared/google.ts`) and
   `routine-fire`. Every function deploys the same way:
   `$SB functions deploy <name> --use-api --no-verify-jwt --project-ref $REF --yes`.

   | Function | Function secrets it reads | Vault URL (job) |
   |---|---|---|
   | `planner-mcp` | none of its own | — |
   | `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SHEET_CRON_SECRET`, `SHEET_ROUTINE_ID`, `SHEET_ROUTINE_TOKEN` | `sheet_telegram_url` (`sheet-telegram`) |
   | `mail-mcp` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SHEET_SENDER_SALT` | — |
   | `mail-connect` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MAIL_STATE_SECRET` | — |
   | `calendar-connect` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MAIL_STATE_SECRET` | — |
   | `busy-sync` | `SHEET_CRON_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `sheet_busy_url` (`sheet-busy`) |
   | `mail-sync` | `SHEET_CRON_SECRET`, `SHEET_SENDER_SALT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `sheet_mail_url` (`sheet-mail`) |
   | `work-sync` | `SHEET_CRON_SECRET`, `SHEET_GITHUB_TOKEN`, `SHEET_JIRA_TOKEN`, `SHEET_JIRA_EMAIL`, `SHEET_JIRA_SITE` | `sheet_work_url` (`sheet-work`) |
   | `slack-sync` | `SHEET_CRON_SECRET`, `SHEET_SLACK_TOKEN` | `sheet_slack_url` (`sheet-slack`) |
   | `ical-sync` | `SHEET_CRON_SECRET`, `SHEET_HANDSHAKE_ICS`, `SHEET_ACADEMIC_ICS` | `sheet_ical_url` (`sheet-ical`) |
   | `weather` | `SHEET_CRON_SECRET` | `sheet_weather_url` (`sheet-weather`) |
   | `brightspace` | `SHEET_CRON_SECRET`, `SHEET_BRIGHTSPACE_ICS` | `sheet_brightspace_url` (`sheet-brightspace`) |
   | `campus` | `SHEET_CRON_SECRET` | `sheet_campus_url` (`sheet-campus`) |
   | `routine-fire` | `SHEET_CRON_SECRET`, `SHEET_ROUTINE_ID`, `SHEET_ROUTINE_TOKEN` | — |

   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are built in. The source secrets
   (`SHEET_SENDER_SALT`, `SHEET_GITHUB_TOKEN`, the three `SHEET_JIRA_*`, `SHEET_SLACK_TOKEN`,
   `SHEET_HANDSHAKE_ICS`, `SHEET_ACADEMIC_ICS`) are optional: without one, that sync records
   "not connected" and does nothing. `sheet-rollover` calls `nightly_roll()` in the database and
   has no URL.
7. **Vault URLs.** These are not secrets; `sheet_cron_secret` and the v3/v4 URLs are already
   there. Add each once its source can work, in this form:
   ```sql
   select vault.create_secret('<URL>/functions/v1/<function>', '<name>')
   where not exists (select 1 from vault.secrets where name = '<name>');
   ```
   - now: `sheet_weather_url`;
   - after the calendar is connected (Lisul's step 1): `sheet_busy_url`;
   - after `SHEET_SENDER_SALT` is set: `sheet_mail_url`;
   - after the source's secrets are set: `sheet_work_url`, `sheet_slack_url`, `sheet_ical_url`.

   Vault also holds `mail_refresh:<account>` and `calendar_refresh:<account>`, which
   `mail_account_save` and `calendar_account_save` write; never add or edit them by hand.
   Deleting a URL stops its job.
8. **/plan:** open the PR sheet-v5 → main with the commit as its head; **[Lisul]** merges it,
   and the push to main deploys GitHub Pages. After steps 4 to 6 only.
9. **The prompt:** `RemoteTrigger update` on the morning task with the text between the
   ```` ```text ```` fences in [sheet-morning-task.md](sheet-morning-task.md), pasted as-is.
   Change only the prompt: keep the schedule (daily 6:07 am America/New_York), exactly its two
   connectors (The Sheet planner, The Sheet mail) and the API trigger. Compare `RemoteTrigger
   get` with the saved copy.

### Lisul's one-time setup

1. **Calendar:** /plan → Settings → Calendar → Connect, signed in as his own Google account (the
   one in `settings.owner_email`); approve "See the availability on Google Calendars". It returns
   to `/plan/?calendar=connected`. Then `sheet_busy_url` goes into Vault.
2. **Replans:** the API trigger and `SHEET_ROUTINE_ID`, `SHEET_ROUTINE_TOKEN` are set already
   ([sheet-morning.md](sheet-morning.md), Setup step 5). Fire one probe
   (`SHEET_CRON_SECRET=… node tools/routine-probe.mjs --function`; `RemoteTrigger list_runs`
   shows one new run), then turn replans on in Settings.
3. **Mail sync:** set `SHEET_SENDER_SALT` to a long random string, never changed after (it would
   orphan every known-sender hash). Then `sheet_mail_url` goes into Vault.
4. **Sources** (each optional; a missing one shows "not connected"):
   - GitHub: a fine-grained token with read-only Pull requests, Issues and Metadata on his orgs,
     as `SHEET_GITHUB_TOKEN`; the orgs in Settings.
   - Jira: an API token (`read:jira-work`) as `SHEET_JIRA_TOKEN`, with `SHEET_JIRA_EMAIL` and
     `SHEET_JIRA_SITE` (`<name>.atlassian.net`).
   - Slack: a user token with only `search:read`, as `SHEET_SLACK_TOKEN`.
   - Handshake: the private calendar link as `SHEET_HANDSHAKE_ICS`; the SBU academic calendar
     link as `SHEET_ACADEMIC_ICS`.
   - Then `sheet_work_url`, `sheet_slack_url` and `sheet_ical_url` go into Vault.
5. **Settings:** the enrollment time, habits, triage rules, and the workload cap if 6 hours is
   wrong.

### Check it

- `bash tools/verify-sheet-v5.sh`, read-only. Every line should be ✓, with a ! for each source
  not connected yet, and no ✗. Run it again after 10 minutes and after the next :50, once the
  syncs have run. It doesn't reach the morning task: `RemoteTrigger get` should show it enabled,
  at 6:07 am, with its API trigger and only its two connectors.
- `bash tools/verify-sheet-v4.sh` now shows one ✗ by design: "apply_proposal is security
  invoker: no function", since V1 dropped that signature.
- After the next 6:07 am run, today's proposal is `rev 1`, `run_trigger morning`, with `blocks`
  filled.
- **[Lisul]** looks: the brief's weather and calendar lines; Approve all; a Finished? check at a
  nudged block's end with four answers; in /plan, Settings shows Calendar connected, "Busy times
  saved N min ago", the cap, pace per kind and each feed's status, and the banner shows
  "Revision 1".

### Rolling back

There is no down script, and V1 is one-way once a day has rev 2: roll forward with a fixed build.
A real revert deletes every `proposals` row with `rev > 1`, puts back `primary key (day)` and the
v4 `apply_proposal` from main's schema.sql, and redeploys v4 `planner-mcp` and `telegram` from
main; the added tables and columns can stay, since v4 ignores them. A new function comes out with
`$SB functions delete <name> --project-ref $REF`, a job stops when its Vault URL is deleted, and
Settings → Disconnect deletes the calendar grant and its Vault secret. The prompt goes back with
`RemoteTrigger update` from the saved copy.

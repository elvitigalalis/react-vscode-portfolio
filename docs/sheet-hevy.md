# The Sheet: Hevy

Lisul logs his lifts in Hevy. The Sheet reads them so a finished workout ends the day's Gym habit
block (as a ring workout does), Telegram can say how it went, and the brief can name the next
routine. Everything is read from Hevy; the Sheet never writes to it.

## Files

- `src/sheet/hevy.mjs`: the decisions. API workouts to table rows (`workoutRows`), the events
  feed folded newest-first (`applyEvents`), Hevy rows as ring workouts for `gymMatches`
  (`asRingWorkouts`), kg to lb (`toLb`), PRs (`prs`), the "Nice lift" text (`workoutText`) and the
  next routine (`nextRoutine`). No network. Tested in `test/hevy.test.mjs` with made-up
  workouts in `test/fixtures/hevy/`.
- `supabase/functions/hevy-sync/index.ts`: the sync, every 15 minutes, plus the optional webhook.
- `supabase/functions/_shared/gym-tick.ts`: `tickGym`, which ends the Gym habit block a workout
  finished. oura-sync and hevy-sync share it.
- `supabase/schema.sql`, section "Hevy (docs/sheet-hevy.md)": `hevy_account`, `hevy_workouts`,
  `hevy_sets`, the key functions and the `sheet-hevy` cron job.

## What is synced

- Per workout: id, title, routine id, local day, start, end, updated time.
- Per set: exercise index and name, template id, set index, type (normal, warmup, dropset,
  failure), weight in kg, reps, RPE.
- Not synced: notes, descriptions, distance, duration, body measurements, routines and folders.
  Hevy's API marks no PRs, so `prs` works them out from the synced history (normal and failure
  sets of 1 to 12 reps, the `gym.mjs` rule). An exercise's first time is not a PR.
- Nothing is pruned: the rows are small and PRs need the whole history. Disconnect deletes the key
  and every workout.

## How a run works

1. `rpc/hevy_key` gives the key (from Vault) and `events_since`. No key: feed_state 'hevy' says
   "not connected" and the run stops.
2. First run (`events_since` null, so also after a new key): `GET /v1/user/info` for the weight
   unit; a non-Pro account is marked `not pro`. Then every page of `GET /v1/workouts`.
3. Later runs: every page of `GET /v1/workouts/events?since=<events_since − 10 min>`. The overlap
   is harmless, since every write is an upsert or a delete by id.
4. `rpc/hevy_sync_save` writes it all in one transaction and sets `events_since` to the run's
   start.
5. `tickGym` on yesterday's and today's Hevy workouts, each as a strength ring workout.

A 401 or 403 marks the account `key refused` (Settings asks for a new key). A 429 or 5xx is an
ordinary feed failure, and the next run retries. The key is never logged, never in feed_state and
never in an error.

## The webhook

Hevy's webhook is undocumented. It was in Hevy's API spec in mid-2025 and has since been taken
out; community guides still describe "URL" and "authorization header" fields in Hevy's developer
settings. It sends only a workout id when a workout is completed and resends unless it gets a 200
within 5 seconds. Nobody knows whether edits or deletes fire it, or whether it still works.

So it is only a "sync now" hint. `POST /functions/v1/hevy-sync/hook` checks
`Authorization: Bearer <SHEET_HEVY_HOOK_TOKEN>`, answers 200 at once, and runs the same sync in
the background. It ignores the payload. Without the secret it answers 404. The 15-minute poll is
the source of truth and covers everything without it.

## Rule: Hevy rows stay out of the routine

Hevy rows stay out of `read_planner` and the routine; it gains nothing from sets and weights. Only
server code (telegram) and `/plan` read them. `/now` never shows them. This is a plain rule, not
an ADR: Hevy's terms have no clause like Oura's, and it is his own data.

## Deploy

```sh
npx supabase functions deploy hevy-sync --use-api --no-verify-jwt
```

`--no-verify-jwt` because neither the cron job nor Hevy has a Supabase sign-in; the cron proves
itself with `x-sheet-cron` (`SHEET_CRON_SECRET`), the webhook with its bearer token. oura-sync
imports `_shared/gym-tick.ts`, so redeploy it too after a change there.

## Setup Lisul does once

1. Check Hevy Pro is active. On the web, open `https://hevy.com/settings?developer` and create or
   copy the API key.
2. Run the schema's Hevy section in the Supabase SQL editor, deploy hevy-sync (above), and add the
   Vault secret for the cron job:
   `select vault.create_secret('https://<project>.supabase.co/functions/v1/hevy-sync', 'sheet_hevy_url');`
3. In /plan → Settings → Accounts → Hevy, paste the key and press Save. Within 15 minutes the
   status should say "Synced" and the feeds list should show Hevy.
4. Optional webhook: make a token (`openssl rand -hex 24`), run
   `npx supabase secrets set SHEET_HEVY_HOOK_TOKEN=<token>`, then in Hevy's developer settings set
   the URL to `https://<project>.supabase.co/functions/v1/hevy-sync/hook` and the authorization
   header to `Bearer <token>`. If those fields are gone, skip this: the poll covers it.

# The Sheet: Gym

A lift tracker at `/plan/gym/`, behind the same Google sign-in as `/plan` (owner only). It runs
Lisul's program in order and logs his sets on his iPhone between sets. The top bar on `/plan` has a
dumbbell link to it. The page is separate so `/plan`'s first load stays small. Its own first-load
JavaScript must stay at or under 40 KB gzipped (`check/budget.mjs`, run by `npm run check`).

## Files

- `src/sheet/gym.mjs`: the decisions. e1RM and records, PRs, the suggestion, session order and
  the strip, plates, warm-ups, swaps. Tested in `test/gym.test.mjs`.
- `src/sheet/gym-sync.mjs`: the offline outbox (`test/gym-sync.test.mjs`).
- `src/sheet/gym-api.mjs`: the REST calls. `src/sheet/gym-ui.mjs`: the page.
- `supabase/schema.sql`, section "Gym": the seven `gym_*` tables, owner-only, safe to re-run. It
  has no coaching notes and no program data.
- `tools/gym-seed.mjs`: turns a local program JSON and a baselines JSON into SQL
  (`test/gym-seed.test.mjs`, made-up fixtures in `test/fixtures/gym/`). The real files stay out of
  this repo, because the program comes from a copyrighted sheet and the numbers are personal.

## Today

- The page opens on the session after the last finished one, in program order, not by calendar
  date. After Week 4 Legs #2 it goes back to Week 1. A picker chooses another day. The picker is
  locked once a set is logged.
- The 4 × 6 strip shows the days done in this pass, today's day and the next one.
- Each exercise gets a card with: the prescription line, last time (the same program day first),
  today's suggestion and its reason, and an e1RM sparkline.
- Below that come the set rows. Warm-up rows (W) come first, prefilled from about 50% to 85% of
  the working weight. They never count toward records or suggestions.
- Each row has 56 px −/+ steppers and a 56 px ✓. The number fields are 18 px or larger, with
  `inputmode` decimal for weight and numeric for reps.
- ✓ saves the set to the phone at once and offers Undo for 5 s. It starts the rest timer (the
  slot's lower rest bound, or 60 s after a warm-up) and opens the RPE chips (6–10 in half steps,
  set to the target by default). The banner shows the most important PR the set made: e1RM, then
  heaviest weight, then reps at a weight.
- The rest bar keeps counting past zero (+0:20). At zero the screen flashes and a beep sounds.
  The wake lock is held while a session is open and is taken again on `visibilitychange`.
- ⇄ swaps the exercise. The choices are the original (marked Original), the two substitutes, any
  exercise, or a new one, for "Today only" or "Rest of phase". Records stay with the exercise he
  actually did.
- Finish shows a summary (sets, volume, time, PRs) and links back to `/plan`. If today has a Gym
  habit block (a habit named Gym, Lift or Workout), Finish treats it the way a done task's block
  is treated (`blockOnComplete`): it is shortened to now if under way, or dropped if it hadn't
  started.

## Rules

- **e1RM:** Epley, w × (1 + r/30). Sets of 11–12 reps show a "~". A set over 12 reps never counts
  toward a record.
- **PRs:** worked out on the phone from every logged working set, so they work offline. A
  baseline (from his sheet) shows as "From your sheet". It counts only after he confirms it in
  Records.
- **Suggestion:** the rule is `suggest` in `gym.mjs`.
  - Every set reached rep_max at or under RPE target + 0.5: add a step.
  - Any set fell under rep_min, or RPE was at target + 1.5 or more: hold the weight. If the session
    before was short too, drop a step.
  - Otherwise: same weight, one more rep on the weakest set.
  - First time: show only the target, plus the sheet's number if there is one.
  - After 14 days or more away: about 90% of the last weight.
- **Records:** for each exercise, the best weight at each rep count. A record is faded when a set
  at least as heavy went for more reps. Records also show the e1RM, the heaviest weight and the
  history. Nothing is capped.
- **Edit:** rename, replace, reorder, add or remove an exercise, or change sets, reps, RPE, warm-up
  or rest. An edit applies to that day in every week where the slot holds the same exercise.
  Editing is locked while a session is open, so changes apply from the next session.

## Offline

Every write goes to a localStorage outbox first, one entry per row, with ids made on the phone.
It then goes to Supabase as an upsert by id, or a delete by id. Every update or delete therefore
has a where, and pg-safeupdate is loaded for PostgREST's role (checked by `tools/test-schema.sh`).

The outbox flushes after each write, when the phone comes back online, when the page becomes
visible, and every 30 s while writes are waiting. An entry leaves the outbox only after the server
takes that exact version. "Saved on phone, syncing" shows while writes are waiting and the phone
is offline. The page also keeps a copy of the rows, so it can reload with a bad signal.

## Home screen

Safari, Share, Add to Home Screen gives a standalone app scoped to `/plan/`
(`public/plan/gym/manifest.webmanifest`). The home-screen app keeps its own storage, so he signs
in once inside it.

## Deploy

1. Run the schema: paste `supabase/schema.sql` into the Supabase SQL editor. Re-running it is
   safe.
2. Add the redirect URL: in Supabase Auth, under URL Configuration, add
   `https://www.lisul-elvi.com/plan/gym/` to the redirect URLs. Skip this if a wildcard already
   covers it.
3. Seed the program, once: run
   `node tools/gym-seed.mjs <program.json> <baselines.json> > seed.sql`, then run `seed.sql` in
   the SQL editor. Re-seeding adds nothing twice and never overwrites a confirmed baseline.
4. Deploy the site as usual (merge to main).

## Later

- A link from a Gym habit block's row on `/plan`. It was left out to keep `/plan` changes to the
  top-bar link.
- Bar weights per exercise in the editor. Today the seed sets 45 lb for barbell lifts.
- A service worker, so the page can open with no signal at all.
- Live Activities and lock-screen alerts, which would need Web Push and a server.

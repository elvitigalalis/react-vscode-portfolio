#!/usr/bin/env bash
#
# Runs supabase/schema.sql twice on a throwaway Postgres and checks how the v3 and v4 objects
# behave (docs/sheet-sources.md and docs/sheet-morning.md, "Schema"). Needs Docker; touches no
# live project.
#   bash tools/test-schema.sh [schema.sql]
#
# The image is Supabase's own Postgres (hub.docker.com/r/supabase/postgres): it has the anon,
# authenticated and service_role roles, Vault, pg_cron and pg_net. Only auth.jwt() is missing, since
# the Auth server's migrations create it, so a stand-in reads the claims from request.jwt.claims,
# as PostgREST sets them. The schema runs as postgres, the SQL editor's role.

set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA="${1:-supabase/schema.sql}"
IMAGE="${SHEET_PG_IMAGE:-supabase/postgres:17.11.0.018}"
NAME="sheet-schema-test-$$"
docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 90); do
  docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 1
done
sleep 2 # the image restarts once after its init scripts

psql_as() { docker exec -i "$NAME" psql -U "$1" -d postgres -v ON_ERROR_STOP=1 -q -X; }

psql_as supabase_admin <<'SQL'
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.jwt() to anon, authenticated;
SQL

for run in 1 2; do
  # Any SQL error fails the run: a re-run that breaks is as bad as a first run that does.
  out=$(sed "s/you@example\.com/owner@example.com/" "$SCHEMA" | psql_as postgres 2>&1) \
    || { printf '%s\n' "$out" | grep -A3 ERROR; echo "✗ schema.sql run $run failed"; exit 1; }
  echo "✓ schema.sql run $run"
done

# Each block raises on a failed check, so ON_ERROR_STOP ends the run at the first one. The checks
# report as notices (stderr); stdout carries only the rows of the setup selects.
psql_as postgres >/dev/null <<'SQL'
\set QUIET on
\pset tuples_only on
-- Plays a PostgREST request: the role and the JWT claims.
create function pg_temp.as_user(r text, email text) returns void language sql as $$
  select set_config('role', r, false),
         set_config('request.jwt.claims', coalesce(json_build_object('email', email)::text, ''), false) $$;

do $$ begin
  -- Cron: every job scheduled once, at its minute.
  if (select count(*) from cron.job where jobname in ('sheet-brightspace', 'sheet-campus', 'sheet-telegram', 'sheet-rollover')) <> 4
    then raise exception 'cron jobs missing or doubled'; end if;
  if (select schedule from cron.job where jobname = 'sheet-brightspace') <> '20 * * * *'
    or (select schedule from cron.job where jobname = 'sheet-campus') <> '35 * * * *'
    then raise exception 'cron schedules'; end if;
  if (select command from cron.job where jobname = 'sheet-brightspace') like '%campus_events%'
    then raise exception 'sheet-brightspace swallowed the campus section'; end if;
  raise notice '✓ cron jobs';

  -- Course tasks: one task per (source, source_uid); hand-made tasks (both null) never clash.
  insert into tasks (title, list, source, source_uid) values ('HW 1', 'Brightspace', 'brightspace', 'u1');
  begin
    insert into tasks (title, list, source, source_uid) values ('HW 1 again', 'Brightspace', 'brightspace', 'u1');
    raise exception 'a second task with the same source uid was allowed';
  exception when unique_violation then null; end;
  insert into tasks (title, list) values ('by hand', 'Inbox'), ('by hand', 'Inbox');
  raise notice '✓ course task unique (source, source_uid)';

  -- feed_seen: a uid is seen once per source.
  insert into feed_seen (source, uid) values ('brightspace', 'u1'), ('campus', 'u1');
  begin
    insert into feed_seen (source, uid) values ('brightspace', 'u1');
    raise exception 'feed_seen took a duplicate';
  exception when unique_violation then null; end;
  raise notice '✓ feed_seen primary key';

  -- The functions only the service role may call.
  if has_function_privilege('anon', 'mail_refresh_token(text)', 'execute')
    or has_function_privilege('authenticated', 'mail_refresh_token(text)', 'execute')
    or has_function_privilege('anon', 'mail_account_save(text, text)', 'execute')
    or has_function_privilege('authenticated', 'mail_account_save(text, text)', 'execute')
    then raise exception 'mail functions callable by anon or authenticated'; end if;
  if not has_function_privilege('service_role', 'mail_account_save(text, text)', 'execute')
    then raise notice '  (service_role has no execute on mail_account_save: check Supabase grants it)'; end if;
  raise notice '✓ mail_refresh_token and mail_account_save revoked';

  -- RLS on every v3 table.
  if exists (select 1 from pg_class where relname in ('feed_seen', 'feed_state', 'campus_events', 'mail_accounts', 'mail_connect_states')
             and relnamespace = 'public'::regnamespace and not relrowsecurity)
    then raise exception 'RLS off on a v3 table'; end if;

  -- The public views name none of the v3 columns.
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now')
               and (column_name in ('source', 'source_uid', 'due', 'interests')
                    or table_name in ('campus_events', 'mail_accounts', 'feed_seen', 'feed_state')))
    then raise exception 'a public view exposes a v3 column'; end if;
  raise notice '✓ RLS on and public views clean';
end $$;

insert into campus_events (uid, title, starts_at, ends_at) values ('e1', 'Bagels', now(), now() + interval '1 hour');
select mail_account_save('a@example.com', 'refresh-1');
select mail_account_save('a@example.com', 'refresh-2');  -- reconnect: same secret, new token
do $$ begin
  if (select count(*) from vault.secrets where name = 'mail_refresh:a@example.com') <> 1
    then raise exception 'reconnect made a second vault secret'; end if;
  if mail_refresh_token('a@example.com') <> 'refresh-2' then raise exception 'mail_refresh_token'; end if;
  if mail_refresh_token('nobody@example.com') is not null then raise exception 'token for a missing account'; end if;
  raise notice '✓ mail_account_save and mail_refresh_token';
end $$;

-- Visitors: no table at all.
select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from campus_events; raise exception 'anon read campus_events';
  exception when insufficient_privilege then null; end;
  begin perform 1 from mail_accounts; raise exception 'anon read mail_accounts';
  exception when insufficient_privilege then null; end;
  begin perform 1 from mail_connect_states; raise exception 'anon read mail_connect_states';
  exception when insufficient_privilege then null; end;
  perform 1 from public_week;
  raise notice '✓ anon: no v3 tables, public_week still answers';
end $$;

-- Someone else signed in: RLS hides every row.
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  if (select count(*) from campus_events) + (select count(*) from mail_accounts) + (select count(*) from feed_seen) <> 0
    then raise exception 'a non-owner sees v3 rows'; end if;
  raise notice '✓ non-owner sees no rows';
end $$;

-- The owner reads campus events and mail accounts, writes neither, and may delete an account.
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if (select count(*) from campus_events) <> 1 then raise exception 'owner cannot read campus_events'; end if;
  begin insert into campus_events (uid, title, starts_at, ends_at) values ('e2', 'x', now(), now());
    raise exception 'owner wrote campus_events';
  exception when insufficient_privilege then null; end;
  begin update mail_accounts set vault_secret_id = gen_random_uuid();
    raise exception 'owner re-aimed vault_secret_id';
  exception when insufficient_privilege then null; end;
  if (select count(*) from mail_accounts) <> 1 then raise exception 'owner cannot read mail_accounts'; end if;
  delete from mail_accounts where email = 'a@example.com';
  raise notice '✓ owner reads, cannot write, deletes an account';
end $$;

reset role;
do $$ begin
  if exists (select 1 from vault.secrets where name = 'mail_refresh:a@example.com')
    then raise exception 'deleting the account left its vault secret'; end if;
  raise notice '✓ removing an account deletes its vault secret';
end $$;

-- --- v4, the morning plan (docs/sheet-morning.md, "Schema") ---------------------------------
do $$ begin
  if exists (select 1 from pg_class where relname in ('proposals', 'needs_you', 'busy')
             and relnamespace = 'public'::regnamespace and not relrowsecurity)
    then raise exception 'RLS off on a v4 table'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now')
               and (column_name in ('busy_as_of', 'morning_on')
                    or table_name in ('proposals', 'needs_you', 'busy')))
    then raise exception 'a public view exposes a v4 table or column'; end if;
  insert into nudges (kind, day, send_at) values ('proposal', sheet_today(), now());
  raise notice '✓ v4: RLS on, public views clean, nudges take proposal';
end $$;

insert into tasks (id, title, day) values
  ('00000000-0000-4000-8000-000000000001', 'OS homework', sheet_today()),
  ('00000000-0000-4000-8000-000000000002', 'Gym', sheet_today());
-- An approved block today, which apply_proposal must leave alone.
insert into blocks (task_id, starts_at, ends_at)
  values ('00000000-0000-4000-8000-000000000002', now(), now() + interval '1 hour');

select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from proposals; raise exception 'anon read proposals';
  exception when insufficient_privilege then null; end;
  begin perform 1 from needs_you; raise exception 'anon read needs_you';
  exception when insufficient_privilege then null; end;
  begin perform 1 from busy; raise exception 'anon read busy';
  exception when insufficient_privilege then null; end;
  raise notice '✓ anon: no v4 tables';
end $$;

-- The owner, as planner-mcp calls it: a first proposal, then a resubmission that replaces it.
-- The blocks sit at fixed times today, so a run late in the evening doesn't push them into tomorrow.
-- Since v5 (V1) each submission is a revision, named by the one it replaces.
select pg_temp.as_user('authenticated', 'owner@example.com');
create temp table v4_first as select now() as at;
select apply_proposal(d => sheet_today(), replaces => null, blocks =>
  jsonb_build_array(
    jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', (sheet_today() + time '09:00') at time zone (select time_zone from settings), 'ends_at', (sheet_today() + time '10:00') at time zone (select time_zone from settings)),
    jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', (sheet_today() + time '11:00') at time zone (select time_zone from settings), 'ends_at', (sheet_today() + time '12:00') at time zone (select time_zone from settings))),
  needs => '[{"account": "a@example.com", "message_id": "abc123", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/abc123",
     "sender": "Ana", "subject": "Demo moved", "why": "Reply by Thursday.", "kind": "reply", "due": "2026-11-05"}]',
  picks => '[{"uid": "e1", "why": "Bagels."}]', note => 'Gym did not fit.');
update proposals set created_at = created_at - interval '1 hour';  -- so the resubmission's is newer
update needs_you set done = true;
select apply_proposal(d => sheet_today(), replaces => 1, blocks =>
  jsonb_build_array(jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', (sheet_today() + time '13:00') at time zone (select time_zone from settings), 'ends_at', (sheet_today() + time '14:00') at time zone (select time_zone from settings))),
  needs => '[{"account": "a@example.com", "message_id": "abc123", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/abc123",
     "sender": "Ana", "subject": "Demo moved", "why": "Reply by Thursday.", "kind": "reply"},
    {"account": "a@example.com", "message_id": "def456", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/def456",
     "sender": "Bursar", "subject": "Spring bill", "why": "Pay it.", "kind": "admin"}]');
do $$ begin
  if (select count(*) from blocks where proposed) <> 1
    or not exists (select 1 from blocks where proposed and starts_at = (sheet_today() + time '13:00') at time zone (select time_zone from settings))
    then raise exception 'resubmission did not replace the proposed blocks'; end if;
  if (select count(*) from blocks where not proposed) <> 1 then raise exception 'apply_proposal touched an approved block'; end if;
  if (select count(*) from proposals where status = 'pending') <> 1
    or (select status from proposals where rev = 1) <> 'superseded'
    or (select status from proposals where rev = 2) <> 'pending'
    or (select note from proposals where rev = 2) is not null
    or (select picks from proposals where rev = 2) <> '[]'::jsonb
    or (select created_at from proposals where rev = 2) < (select at from v4_first)
    then raise exception 'resubmission did not supersede the proposal'; end if;
  if (select count(*) from needs_you) <> 2 or not (select done from needs_you where message_id = 'abc123')
    then raise exception 'needs_you: a message already there was added again'; end if;
  raise notice '✓ apply_proposal replaces a pending proposal';
end $$;

-- A skipped proposal is refused, and nothing changes. (Since v5 an approved one takes a replan.)
update proposals set status = 'skipped' where rev = 2;
do $$ begin
  begin
    perform apply_proposal(d => sheet_today(), replaces => 2, blocks => '[]');
    raise exception 'apply_proposal replaced a skipped proposal';
  exception when raise_exception then
    if sqlerrm not like '%already skipped%' then raise; end if;
  end;
  if (select count(*) from blocks where proposed) <> 1 then raise exception 'a refused apply changed blocks'; end if;
  raise notice '✓ apply_proposal refuses a skipped proposal';
end $$;

-- A resubmission replaces the day's open Needs you items (done ones stay), and shutting a day
-- down lapses its proposal, which apply_proposal then refuses.
update proposals set status = 'pending' where rev = 2;
select apply_proposal(d => sheet_today(), replaces => 2, blocks => '[]', needs =>
  '[{"account": "a@example.com", "message_id": "aaa111", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/aaa111",
     "sender": "Ana", "subject": "One", "why": "Reply.", "kind": "reply"}]');
select apply_proposal(d => sheet_today(), replaces => 3, blocks => '[]', needs =>
  '[{"account": "a@example.com", "message_id": "bbb222", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/bbb222",
     "sender": "Ana", "subject": "Two", "why": "Reply.", "kind": "reply"}]');
do $$ begin
  if exists (select 1 from needs_you where message_id = 'aaa111') then raise exception 'an open needs_you item survived a resubmission'; end if;
  if not exists (select 1 from needs_you where message_id = 'bbb222') then raise exception 'the resubmitted needs_you item is missing'; end if;
  if not exists (select 1 from needs_you where message_id = 'abc123' and done) then raise exception 'a done needs_you item was removed'; end if;
  raise notice '✓ a resubmission replaces open Needs you items';
end $$;
select shut_down(sheet_today(), null);
do $$ begin
  if (select status from proposals where day = sheet_today() and rev = 4) <> 'lapsed' then raise exception 'shutting down left the proposal pending'; end if;
  begin
    perform apply_proposal(d => sheet_today(), replaces => 4, blocks => '[]');
    raise exception 'apply_proposal reopened a lapsed proposal';
  exception when raise_exception then
    if sqlerrm not like '%already lapsed%' then raise; end if;
  end;
  raise notice '✓ a shut-down day lapses its proposal and stays closed';
end $$;
update proposals set status = 'approved' where day = sheet_today() and rev = 4;

-- Someone else signed in can't write a proposal: RLS refuses the row.
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  begin
    perform apply_proposal(d => sheet_today() + 1, replaces => null, blocks => '[]');
    raise exception 'a non-owner wrote a proposal';
  exception when insufficient_privilege then null; end;
  raise notice '✓ a non-owner cannot apply a proposal';
end $$;

-- The nightly cleanup.
reset role;
insert into proposals (day, status) values (sheet_today() - 1, 'pending'), (sheet_today() - 2, 'skipped');
insert into busy values (now() - interval '2 hours', now() - interval '1 hour'), (now() + interval '1 hour', now() + interval '2 hours');
insert into needs_you (day, account, message_id, link, sender, subject, why, kind, created_at) values
  (sheet_today() - 15, 'a@example.com', 'old000', 'x', 'x', 'x', 'x', 'reply', now() - interval '15 days');
select nightly_roll();
do $$ begin
  if (select status from proposals where day = sheet_today() - 1) <> 'lapsed'
    or (select status from proposals where day = sheet_today() - 2) <> 'skipped'
    or (select status from proposals where day = sheet_today() and rev = 4) <> 'approved'
    then raise exception 'nightly_roll: proposal statuses'; end if;
  if (select count(*) from busy) <> 1 or exists (select 1 from busy where ends_at <= now())
    then raise exception 'nightly_roll: ended busy times kept'; end if;
  if (select array_agg(message_id) from needs_you) <> array['bbb222']
    then raise exception 'nightly_roll: needs_you done or old rows kept'; end if;
  raise notice '✓ nightly_roll lapses, clears busy and needs_you';
end $$;

-- --- v5 V1, revisions (docs/sheet-v5.md, "Schema → Revisions") -------------------------------
-- Each block skips itself until the function it checks exists, so these pass before V1 lands.
-- They run as postgres (RLS doesn't apply) on days of their own, five and six days out, so the v4
-- rows above stay as they are.
do $$
declare
  tz text := (select time_zone from settings);
  d date := sheet_today() + 5;
  t1 uuid := '00000000-0000-4000-8000-0000000000a1';
  r int;
begin
  if to_regprocedure('apply_proposal(date, integer, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz, text)') is null then
    raise notice '- v5 revisions: skipped, apply_proposal(d, replaces, ...) is not there yet';
    return;
  end if;
  insert into tasks (id, title, day) values (t1, 'V5 task', d);
  -- An approved block at 9:00, which no revision may touch.
  insert into blocks (task_id, starts_at, ends_at) values (t1, (d + time '09:00') at time zone tz, (d + time '10:00') at time zone tz);

  -- The first revision: replaces is null, and it is revision 1, pending, from the morning.
  r := apply_proposal(d => d, replaces => null, blocks => jsonb_build_array(jsonb_build_object(
    'task_id', t1, 'starts_at', (d + time '11:00') at time zone tz, 'ends_at', (d + time '11:45') at time zone tz)));
  if r <> 1 then raise exception 'the first revision is %, not 1', r; end if;
  if (select status from proposals where day = d and rev = 1) <> 'pending'
    or (select run_trigger from proposals where day = d and rev = 1) <> 'morning'
    then raise exception 'revision 1 is not a pending morning revision'; end if;

  -- replaces must name the newest revision.
  begin
    perform apply_proposal(d => d, replaces => null, blocks => '[]');
    raise exception 'apply_proposal took replaces null with revision 1 there';
  exception when raise_exception then
    if sqlerrm not like '%newest revision%' then raise; end if;
  end;

  -- Revision 2 supersedes revision 1 and replaces its proposed blocks, never the approved one.
  r := apply_proposal(d => d, replaces => 1, blocks => jsonb_build_array(jsonb_build_object(
    'task_id', t1, 'starts_at', (d + time '13:00') at time zone tz, 'ends_at', (d + time '13:45') at time zone tz)),
    run_trigger => 'replan', reasons => array['busy_overlap']);
  if r <> 2 then raise exception 'the second revision is %, not 2', r; end if;
  if (select status from proposals where day = d and rev = 1) <> 'superseded'
    then raise exception 'revision 1 was not superseded'; end if;
  if (select status from proposals where day = d and rev = 2) <> 'pending'
    or (select run_trigger from proposals where day = d and rev = 2) <> 'replan'
    or (select reasons from proposals where day = d and rev = 2) <> array['busy_overlap']
    or jsonb_array_length((select blocks from proposals where day = d and rev = 2)) <> 1
    then raise exception 'revision 2 is not the pending replan it was written as'; end if;
  if (select count(*) from blocks where task_id = t1 and proposed) <> 1
    or not exists (select 1 from blocks where task_id = t1 and proposed and starts_at = (d + time '13:00') at time zone tz)
    then raise exception 'revision 2 did not replace the proposed blocks'; end if;
  if (select count(*) from blocks where task_id = t1 and not proposed) <> 1
    or not exists (select 1 from blocks where task_id = t1 and not proposed
                   and starts_at = (d + time '09:00') at time zone tz and ends_at = (d + time '10:00') at time zone tz)
    then raise exception 'a revision touched the approved block'; end if;

  -- An older revision can't be replaced again.
  begin
    perform apply_proposal(d => d, replaces => 1, blocks => '[]');
    raise exception 'apply_proposal replaced a superseded revision';
  exception when raise_exception then
    if sqlerrm not like '%newest revision%' then raise; end if;
  end;
  raise notice '✓ v5: apply_proposal writes revisions, supersedes the pending one, leaves approved blocks';

  if to_regprocedure('approve_proposal(date, integer)') is null or to_regprocedure('skip_proposal(date, integer)') is null then
    raise notice '- v5 approve and skip by revision: skipped, not there yet';
    return;
  end if;
  -- Only the newest pending revision can be approved.
  begin
    perform approve_proposal(d, 1);
    raise exception 'approve_proposal approved a superseded revision';
  exception when raise_exception then
    if sqlerrm not like '%not the pending one%' then raise; end if;
  end;
  if approve_proposal(d, 2) <> 1 then raise exception 'approve_proposal did not count its one block'; end if;
  if (select status from proposals where day = d and rev = 2) <> 'approved'
    or exists (select 1 from blocks where task_id = t1 and proposed)
    or (select count(*) from blocks where task_id = t1 and not proposed) <> 2
    then raise exception 'approve_proposal did not approve revision 2'; end if;

  -- A replan after approval: revision 3, with revision 2 still approved and its blocks locked.
  r := apply_proposal(d => d, replaces => 2, blocks => jsonb_build_array(jsonb_build_object(
    'task_id', t1, 'starts_at', (d + time '15:00') at time zone tz, 'ends_at', (d + time '15:45') at time zone tz)),
    run_trigger => 'replan', reasons => array['mail_new']);
  if r <> 3 or (select status from proposals where day = d and rev = 2) <> 'approved'
    or (select count(*) from blocks where task_id = t1 and not proposed) <> 2
    or (select count(*) from blocks where task_id = t1 and proposed) <> 1
    then raise exception 'a replan after approval moved approved blocks or rewrote revision 2'; end if;

  -- Skip deletes the proposed blocks; a skipped day takes no new revision.
  perform skip_proposal(d, 3);
  if (select status from proposals where day = d and rev = 3) <> 'skipped'
    or exists (select 1 from blocks where task_id = t1 and proposed)
    or (select count(*) from blocks where task_id = t1 and not proposed) <> 2
    then raise exception 'skip_proposal did not skip revision 3'; end if;
  begin
    perform apply_proposal(d => d, replaces => 3, blocks => '[]');
    raise exception 'apply_proposal reopened a skipped day';
  exception when raise_exception then
    if sqlerrm not like '%already skipped%' then raise; end if;
  end;
  begin
    perform skip_proposal(d, 3);
    raise exception 'skip_proposal skipped a revision twice';
  exception when raise_exception then
    if sqlerrm not like '%not the pending one%' then raise; end if;
  end;
  raise notice '✓ v5: approve_proposal and skip_proposal act only on the newest pending revision';
end $$;

do $$
declare
  d date := sheet_today() + 6;
begin
  if to_regprocedure('apply_proposal(date, integer, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz, text)') is null then
    return;
  end if;
  -- Shutting a day down lapses its pending revision, and the day takes no new one.
  perform apply_proposal(d => d, replaces => null, blocks => '[]');
  insert into days (day, shutdown) values (d, true);
  perform lapse_proposals_on(d);
  if (select status from proposals where day = d and rev = 1) <> 'lapsed' then raise exception 'shutting down left revision 1 pending'; end if;
  begin
    perform apply_proposal(d => d, replaces => 1, blocks => '[]');
    raise exception 'apply_proposal reopened a shut-down day';
  exception when raise_exception then
    if sqlerrm not like '%already lapsed%' then raise; end if;
  end;
  raise notice '✓ v5: a shut-down day lapses its revision and stays closed';
end $$;

do $$
declare
  tz text := (select time_zone from settings);
  d date := sheet_today() + 7;
  t uuid := '00000000-0000-4000-8000-0000000000a2';
begin
  if to_regprocedure('turn_down(date, uuid)') is null then
    raise notice '- v5 turn_down: skipped, not there yet';
    return;
  end if;
  -- Turning a task down deletes its proposed blocks that day and remembers it, once.
  insert into tasks (id, title, day) values (t, 'Laundry', d);
  insert into blocks (task_id, starts_at, ends_at, proposed)
    values (t, (d + time '09:00') at time zone tz, (d + time '09:30') at time zone tz, true),
           (t, (d + time '12:00') at time zone tz, (d + time '12:30') at time zone tz, false);
  perform turn_down(d, t);
  perform turn_down(d, t);
  if exists (select 1 from blocks where task_id = t and proposed)
    or (select count(*) from blocks where task_id = t and not proposed) <> 1
    then raise exception 'turn_down: blocks'; end if;
  if (select turned_down from days where day = d) <> array[t] then raise exception 'turn_down: days.turned_down'; end if;
  raise notice '✓ v5: turn_down deletes proposed blocks and remembers the task';
end $$;

-- --- v5 P1, actuals (docs/sheet-v5.md, "Schema") ----------------------------------------------
insert into actuals (at, day, task_id, kind, est_min, minutes) values
  (now() - interval '121 days', sheet_today() - 121, gen_random_uuid(), 'course', 30, 45),
  (now() - interval '119 days', sheet_today() - 119, gen_random_uuid(), 'other', null, 20);
select nightly_roll();
do $$ begin
  if (select count(*) from actuals) <> 1 or exists (select 1 from actuals where kind = 'course')
    then raise exception 'nightly_roll kept actuals older than 120 days, or dropped a newer one'; end if;
  begin
    insert into actuals (day, task_id, kind, minutes) values (sheet_today(), gen_random_uuid(), 'other', 0);
    raise exception 'actuals took 0 minutes';
  exception when check_violation then null; end;
  begin
    insert into nudges (block_id, kind, day, send_at) values (null, 'finished', sheet_today(), now());
  exception when check_violation then raise exception 'nudges refused kind finished'; end;
  delete from nudges where kind = 'finished';
  raise notice '✓ v5: actuals kept 120 days, minutes 1-960, nudges take finished';
end $$;
select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from actuals; raise exception 'anon read actuals';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  if exists (select 1 from actuals) then raise exception 'a stranger read actuals'; end if;
end $$;
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if not exists (select 1 from actuals) then raise exception 'the owner cannot read actuals'; end if;
  begin
    insert into actuals (day, task_id, kind, minutes) values (sheet_today(), gen_random_uuid(), 'other', 30);
    raise exception 'the browser inserted into actuals';
  exception when insufficient_privilege then null; end;
  raise notice '✓ v5: actuals owner read-only, closed to anon and strangers';
end $$;
reset role;

-- --- v5 S1, busy times saved by the server (docs/sheet-v5.md, "Schema") ----------------------
reset role;
do $$ begin
  if (select relrowsecurity from pg_class where oid = 'calendar_account'::regclass) is not true
    then raise exception 'RLS off on calendar_account'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name = 'calendar_account')
    then raise exception 'a public view exposes calendar_account'; end if;
  if (select schedule from cron.job where jobname = 'sheet-busy') is distinct from '*/10 * * * *'
    or (select count(*) from cron.job where jobname = 'sheet-busy') <> 1
    then raise exception 'sheet-busy not scheduled once every 10 minutes'; end if;
  if has_function_privilege('anon', 'calendar_account_save(text, text)', 'execute')
    or has_function_privilege('authenticated', 'calendar_account_save(text, text)', 'execute')
    or has_function_privilege('anon', 'calendar_refresh_token()', 'execute')
    or has_function_privilege('authenticated', 'calendar_refresh_token()', 'execute')
    or has_function_privilege('anon', 'busy_sync_save(timestamptz, timestamptz, jsonb, jsonb)', 'execute')
    or has_function_privilege('authenticated', 'busy_sync_save(timestamptz, timestamptz, jsonb, jsonb)', 'execute')
    then raise exception 'calendar functions callable by anon or authenticated'; end if;
  if not has_function_privilege('service_role', 'calendar_account_save(text, text)', 'execute')
    or not has_function_privilege('service_role', 'busy_sync_save(timestamptz, timestamptz, jsonb, jsonb)', 'execute')
    then raise exception 'service_role cannot call the calendar functions'; end if;

  -- Connect, then reconnect: one row, one secret, the new token.
  perform calendar_account_save('owner@example.com', 'refresh-one');
  perform calendar_account_save('owner@example.com', 'refresh-two');
  if (select count(*) from calendar_account) <> 1
    or (select count(*) from vault.secrets where name = 'calendar_refresh:owner@example.com') <> 1
    or calendar_refresh_token() <> 'refresh-two'
    then raise exception 'reconnecting the calendar did not reuse its secret'; end if;
  raise notice '✓ v5: calendar_account private, its functions service-only, reconnect reuses the secret';
end $$;

-- busy_sync_save replaces only calendar rows in its window, stamps busy_as_of, and drops a change
-- while there is no changes table. Fixed times, since each statement here has its own now().
insert into busy (source, starts_at, ends_at) values
  ('calendar', '2030-01-01 13:00+00', '2030-01-01 14:00+00'),
  ('handshake', '2030-01-01 13:00+00', '2030-01-01 14:00+00'),
  ('calendar', '2030-01-09 13:00+00', '2030-01-09 14:00+00');
select set_config('role', 'service_role', false);
select busy_sync_save('2030-01-01 12:00+00', '2030-01-08 12:00+00',
  '[{"starts_at": "2030-01-01T15:00:00Z", "ends_at": "2030-01-01T16:00:00Z"}]',
  '{"kind": "busy", "reason": "busy_change", "weight": 2, "ref": null}');
reset role;
do $$ begin
  if (select count(*) from busy where source = 'handshake' and starts_at = '2030-01-01 13:00+00') <> 1
    or exists (select 1 from busy where source = 'calendar' and starts_at = '2030-01-01 13:00+00')
    or not exists (select 1 from busy where source = 'calendar' and starts_at = '2030-01-01 15:00+00')
    or not exists (select 1 from busy where source = 'calendar' and starts_at = '2030-01-09 13:00+00')
    then raise exception 'busy_sync_save replaced the wrong rows'; end if;
  if (select busy_as_of from settings) <> '2030-01-01 12:00+00' then raise exception 'busy_sync_save did not stamp busy_as_of'; end if;
  delete from busy where starts_at >= '2030-01-01';
  raise notice '✓ v5: busy_sync_save replaces calendar rows only and stamps busy_as_of';
end $$;

select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from calendar_account; raise exception 'anon read calendar_account';
  exception when insufficient_privilege then null; end;
  raise notice '✓ v5: anon cannot read calendar_account';
end $$;

select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  if (select count(*) from calendar_account) <> 0 then raise exception 'a non-owner sees calendar_account'; end if;
  delete from calendar_account;
end $$;

-- The owner reads it, can't write it, and Disconnect (delete) takes the token with it.
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if (select count(*) from calendar_account) <> 1 then raise exception 'owner cannot read calendar_account (or a stranger deleted it)'; end if;
  begin update calendar_account set vault_secret_id = gen_random_uuid();
    raise exception 'owner re-aimed the calendar vault_secret_id';
  exception when insufficient_privilege then null; end;
  begin insert into calendar_account (email) values ('x@example.com');
    raise exception 'owner inserted a calendar_account row';
  exception when insufficient_privilege then null; end;
  delete from calendar_account;
  raise notice '✓ v5: owner reads calendar_account, cannot write it, can disconnect';
end $$;

reset role;
do $$ begin
  if exists (select 1 from vault.secrets where name = 'calendar_refresh:owner@example.com')
    then raise exception 'disconnecting the calendar left its vault secret'; end if;
  if calendar_refresh_token() is not null then raise exception 'a token outlived the disconnect'; end if;
  raise notice '✓ v5: disconnecting the calendar deletes its token';
end $$;
SQL
psql_as postgres <<'SQL'
-- --- v5 D2, a realistic day (docs/sheet-v5.md, "Schema") -----------------------------------
do $$
begin
  if (select workload_cap_min from settings) <> 360 then raise exception 'workload_cap_min should default to 360'; end if;
  begin
    update settings set workload_cap_min = 30;
    raise exception 'a 30-minute workload cap was allowed';
  exception when check_violation then null;
  end;
  if (select udt_name from information_schema.columns where table_name = 'proposals' and column_name = 'couldnt_fit') is distinct from '_uuid'
    then raise exception 'proposals.couldnt_fit should be uuid[]'; end if;
  raise notice '✓ v5: the workload cap defaults to 6 hours and stays within 1 to 16; proposals has couldnt_fit';
end $$;
SQL
psql_as postgres >/dev/null <<'SQL'
-- --- v5 wave 2: R1, H1, L1, A1 and SRC3 (docs/sheet-v5.md, "Schema") --------------------------
-- Each block skips itself until the tables, columns or functions it checks exist, so these pass
-- before their tickets land. This is a new session, so it needs its own as_user.
\set QUIET on
\pset tuples_only on
create function pg_temp.as_user(r text, email text) returns void language sql as $$
  select set_config('role', r, false),
         set_config('request.jwt.claims', coalesce(json_build_object('email', email)::text, ''), false) $$;

-- --- R1, changes and replans ------------------------------------------------------------------
do $$
declare
  r1 uuid := gen_random_uuid();
  r2 uuid := gen_random_uuid();
begin
  if to_regclass('public.changes') is null or to_regclass('public.replans') is null then
    raise notice '- v5 changes and replans: skipped, not there yet';
    return;
  end if;
  if (select bool_and(relrowsecurity) from pg_class where oid in ('changes'::regclass, 'replans'::regclass)) is not true
    then raise exception 'RLS off on changes or replans'; end if;
  if has_table_privilege('anon', 'changes', 'select') or has_table_privilege('anon', 'replans', 'select')
    then raise exception 'anon can read changes or replans'; end if;
  if has_table_privilege('authenticated', 'changes', 'insert') or has_table_privilege('authenticated', 'changes', 'update')
    or has_table_privilege('authenticated', 'changes', 'delete') or has_table_privilege('authenticated', 'replans', 'insert')
    or has_table_privilege('authenticated', 'replans', 'update') or has_table_privilege('authenticated', 'replans', 'delete')
    then raise exception 'the browser can write changes or replans'; end if;
  if not has_table_privilege('authenticated', 'changes', 'select') or not has_table_privilege('authenticated', 'replans', 'select')
    then raise exception 'the owner cannot read changes or replans'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name in ('changes', 'replans'))
    then raise exception 'a public view exposes changes or replans'; end if;
  begin insert into changes (kind, reason, weight) values ('weather', 'mail_new', 2);
    raise exception 'changes took kind weather';
  exception when check_violation then null; end;
  begin insert into changes (kind, reason, weight) values ('mail', 'mail_new', 11);
    raise exception 'changes took weight 11';
  exception when check_violation then null; end;
  begin insert into changes (kind, reason, weight, ref) values ('mail', 'mail_new', 2, repeat('x', 201));
    raise exception 'changes took a 201-character ref';
  exception when check_violation then null; end;
  begin insert into replans (day, reasons, counts, result) values (sheet_today(), '{}', '{}', 'done');
    raise exception 'replans took result done';
  exception when check_violation then null; end;
  if (select replans_on from settings) is not false then raise exception 'settings.replans_on should default to false'; end if;
  if (select data_type from information_schema.columns where table_name = 'settings' and column_name = 'plan_edited_at')
     is distinct from 'timestamp with time zone' then raise exception 'settings.plan_edited_at missing'; end if;

  -- busy_sync_save writes its change once the table exists.
  perform busy_sync_save('2030-02-01 12:00+00', '2030-02-08 12:00+00', '[]',
    '{"kind": "busy", "reason": "busy_change", "weight": 2, "ref": null}');
  if not exists (select 1 from changes where kind = 'busy' and reason = 'busy_change' and weight = 2)
    then raise exception 'busy_sync_save wrote no change'; end if;
  delete from changes;

  -- nightly_roll keeps 14 days; deleting a replan unlinks its changes.
  insert into replans (id, at, day, reasons, counts, result) values
    (r1, now() - interval '15 days', sheet_today() - 15, '{busy_overlap}', '{"busy": 1}', 'started'),
    (r2, now() - interval '13 days', sheet_today() - 13, '{mail_new}', '{"mail": 1}', 'failed');
  insert into changes (at, kind, reason, weight, replan_id) values
    (now() - interval '15 days', 'busy', 'busy_overlap', 10, r1),
    (now() - interval '13 days', 'mail', 'mail_new', 2, r2);
  perform nightly_roll();
  if exists (select 1 from replans where id = r1) or not exists (select 1 from replans where id = r2)
    or exists (select 1 from changes where reason = 'busy_overlap') or not exists (select 1 from changes where replan_id = r2)
    then raise exception 'nightly_roll should keep changes and replans for 14 days, no longer'; end if;
  delete from replans where id = r2;
  if not exists (select 1 from changes where reason = 'mail_new' and replan_id is null)
    then raise exception 'deleting a replan should leave its changes, unlinked'; end if;
  delete from changes;
  delete from replans;
  raise notice '✓ v5: changes and replans private, server-written, kept 14 days';
end $$;

-- --- Fix: claim_replan claims a replan once (docs/sheet-v5.md, "The replan tick") ---------------
do $$
declare
  c1 uuid := gen_random_uuid();
  c2 uuid := gen_random_uuid();
  c3 uuid := gen_random_uuid();
  a uuid;
  b uuid;
begin
  if to_regprocedure('claim_replan(date, text[], jsonb, uuid[])') is null then
    raise notice '- claim_replan: skipped, not there yet';
    return;
  end if;
  if has_function_privilege('authenticated', 'claim_replan(date, text[], jsonb, uuid[])', 'execute')
    or has_function_privilege('anon', 'claim_replan(date, text[], jsonb, uuid[])', 'execute')
    or not has_function_privilege('service_role', 'claim_replan(date, text[], jsonb, uuid[])', 'execute')
    then raise exception 'claim_replan should be the service role''s only'; end if;
  delete from changes where true;
  delete from replans where true;
  insert into changes (id, kind, reason, weight) values (c1, 'busy', 'busy_overlap', 10), (c2, 'mail', 'mail_new', 2);
  insert into changes (id, kind, reason, weight, consumed_day, consumed_rev) values (c3, 'mail', 'mail_new', 2, sheet_today(), 1);
  a := claim_replan(sheet_today(), '{busy_overlap,mail_new}', '{"busy": 1, "mail": 1}', array[c1, c2, c3]);
  if a is null or (select count(*) from replans) <> 1 then raise exception 'the first claim should insert one replans row'; end if;
  if (select count(*) from changes where replan_id = a) <> 2 or exists (select 1 from changes where id = c3 and replan_id is not null)
    then raise exception 'the claim should tie the open changes it names, and no consumed one'; end if;
  -- A second tick a moment later gets nothing, and writes nothing.
  b := claim_replan(sheet_today(), '{busy_overlap}', '{"busy": 1}', array[c1]);
  if b is not null or (select count(*) from replans) <> 1 then raise exception 'a second claim within the hold should get nothing'; end if;
  -- A replan that failed holds nothing; a 429 holds until its retry_after; a started one 60 minutes.
  update replans set result = 'failed' where id = a;
  update changes set replan_id = null where replan_id = a;
  b := claim_replan(sheet_today(), '{busy_overlap}', '{"busy": 1}', array[c1]);
  if b is null then raise exception 'a failed replan should not hold the next claim'; end if;
  update replans set result = 'rate_limited', retry_after = now() + interval '5 minutes' where id = b;
  if claim_replan(sheet_today(), '{busy_overlap}', '{"busy": 1}', array[c1]) is not null
    then raise exception 'a 429 should hold claims until its retry_after'; end if;
  update replans set retry_after = now() - interval '1 minute' where id = b;
  a := claim_replan(sheet_today(), '{busy_overlap}', '{"busy": 1}', array[c1]);
  if a is null then raise exception 'a passed retry_after should not hold'; end if;
  update replans set result = 'started', at = now() - interval '61 minutes' where id = a;
  if claim_replan(sheet_today(), '{busy_overlap}', '{"busy": 1}', array[c1]) is null
    then raise exception 'a started replan over 60 minutes old should not hold'; end if;
  delete from changes where true;
  delete from replans where true;
  raise notice '✓ claim_replan: one claim per hold, ties only open changes, service role only';
end $$;

-- --- Fix: a revision consumes only the changes its run read (apply_proposal's read_at) ----------
do $$
declare
  d date := sheet_today() + 8;
  r int;
begin
  if to_regprocedure('apply_proposal(date, integer, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz, text)') is null then
    raise notice '- apply_proposal read_at: skipped, not there yet';
    return;
  end if;
  delete from changes where true;
  -- One change before the run read the day, one while it ran.
  insert into changes (at, kind, reason, weight) values
    (now() - interval '10 minutes', 'mail', 'mail_new', 2), (now() - interval '2 minutes', 'busy', 'busy_overlap', 10);
  r := apply_proposal(d => d, replaces => null, blocks => '[]', read_at => now() - interval '5 minutes');
  if (select count(*) from changes where consumed_rev = r and consumed_day = d) <> 1
    or exists (select 1 from changes where reason = 'busy_overlap' and consumed_rev is not null)
    then raise exception 'a revision should consume only the changes at or before its read_at'; end if;
  if (select read_at from proposals where day = d and rev = r) is distinct from now() - interval '5 minutes'
    then raise exception 'the revision should keep its read_at'; end if;
  -- Without read_at, everything up to now, as before.
  r := apply_proposal(d => d, replaces => r, blocks => '[]');
  if exists (select 1 from changes where consumed_rev is null) then raise exception 'without read_at a revision should consume every change so far'; end if;
  if (select read_at from proposals where day = d and rev = r) is null then raise exception 'a revision without read_at should keep its own time'; end if;
  delete from changes where true;
  delete from proposals where day = d;
  raise notice '✓ apply_proposal: consumes the changes up to read_at, or now without it';
end $$;

-- --- H1, habits ---------------------------------------------------------------------------------
do $$
declare
  h uuid;
  t uuid := gen_random_uuid();
begin
  if to_regclass('public.habits') is null then
    raise notice '- v5 habits: skipped, not there yet';
    return;
  end if;
  if (select relrowsecurity from pg_class where oid = 'habits'::regclass) is not true then raise exception 'RLS off on habits'; end if;
  if has_table_privilege('anon', 'habits', 'select') then raise exception 'anon can read habits'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name = 'habits')
    then raise exception 'a public view reads habits'; end if;
  begin insert into habits (name, days, ideal, minutes) values ('Gym', '{0}', '07:30', 60);
    raise exception 'habits took day 0';
  exception when check_violation then null; end;
  begin insert into habits (name, days, ideal, minutes) values ('Gym', '{}', '07:30', 60);
    raise exception 'habits took no days';
  exception when check_violation then null; end;
  begin insert into habits (name, days, ideal, minutes) values ('Gym', '{1}', '07:30', 17);
    raise exception 'habits took 17 minutes';
  exception when check_violation then null; end;
  begin insert into habits (name, days, ideal, minutes) values ('Gym', '{1}', '07:30', 10);
    raise exception 'habits took 10 minutes';
  exception when check_violation then null; end;
  begin insert into habits (name, days, ideal, minutes, defence) values ('Gym', '{1}', '07:30', 60, 'strict');
    raise exception 'habits took defence strict';
  exception when check_violation then null; end;
  begin insert into habits (name, days, ideal, minutes) values ('', '{1}', '07:30', 60);
    raise exception 'habits took an empty name';
  exception when check_violation then null; end;
  insert into habits (name, days, ideal, minutes) values ('Gym', '{1,3,5}', '07:30', 60) returning id into h;
  if (select (flex_min, defence) from habits where id = h) is distinct from (30, 'flexible'::text)
    then raise exception 'a habit should default to 30 minutes of flex, flexible'; end if;

  -- A block is a task's or a habit's, never both or neither.
  insert into tasks (id, title, day, public) values (t, 'H1 public task', sheet_today(), true);
  begin insert into blocks (starts_at, ends_at) values (now(), now() + interval '30 minutes');
    raise exception 'a block with neither a task nor a habit';
  exception when check_violation or not_null_violation then null; end;
  begin insert into blocks (task_id, habit_id, starts_at, ends_at) values (t, h, now(), now() + interval '30 minutes');
    raise exception 'a block with both a task and a habit';
  exception when check_violation then null; end;

  -- /now never shows a habit: alone, a habit block running now shows nothing; beside a public
  -- task's block, the task shows.
  delete from blocks where not proposed and starts_at <= now() and ends_at > now();
  insert into blocks (habit_id, starts_at, ends_at) values (h, now() - interval '30 minutes', now() + interval '30 minutes');
  if (select title is not null or public is not null from public_now) then raise exception 'public_now showed a habit block'; end if;
  insert into blocks (task_id, starts_at, ends_at) values (t, now() - interval '10 minutes', now() + interval '20 minutes');
  if (select title from public_now) is distinct from 'H1 public task' then raise exception 'a habit block hid the task running now'; end if;

  delete from habits where id = h;
  if exists (select 1 from blocks where habit_id = h) then raise exception 'a habit block outlived its habit'; end if;
  delete from tasks where id = t;
  raise notice '✓ v5: habits checked and private; a block is a task''s or a habit''s; habits never reach public_now';
end $$;
-- apply_proposal writes habit blocks as proposed blocks and keeps them in the revision; approving
-- the revision locks them, as task blocks. A day of its own, 31 days out.
do $$
declare
  tz text := (select time_zone from settings);
  d date := sheet_today() + 31;
  h uuid;
begin
  if to_regclass('public.habits') is null then return; end if;
  insert into habits (name, days, ideal, minutes) values ('H1 lunch', '{1,2,3,4,5,6,7}', '12:30', 30) returning id into h;
  perform apply_proposal(d => d, replaces => null, blocks => '[]', habit_blocks => jsonb_build_array(jsonb_build_object(
    'habit_id', h, 'starts_at', (d + time '12:30') at time zone tz, 'ends_at', (d + time '13:00') at time zone tz)));
  if (select count(*) from blocks where habit_id = h and proposed and task_id is null) <> 1
    then raise exception 'apply_proposal wrote no proposed habit block'; end if;
  if (select blocks -> 0 ->> 'habit_id' from proposals where day = d and rev = 1) is distinct from h::text
    then raise exception 'the revision does not hold its habit block'; end if;
  perform approve_proposal(d, 1);
  if (select count(*) from blocks where habit_id = h and not proposed) <> 1
    then raise exception 'approving did not lock the habit block'; end if;
  delete from habits where id = h;
  delete from proposals where day = d;
  raise notice '✓ v5: apply_proposal writes habit blocks, approve_proposal locks them';
end $$;
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  if to_regclass('public.habits') is null then return; end if;
  begin insert into habits (name, days, ideal, minutes) values ('Lunch', '{1}', '12:30', 30);
    raise exception 'a stranger added a habit';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if to_regclass('public.habits') is null then return; end if;
  insert into habits (name, days, ideal, minutes) values ('Lunch', '{1,2,3,4,5}', '12:30', 30);
  delete from habits where name = 'Lunch';
  raise notice '✓ v5: the owner writes habits, a stranger can''t';
end $$;
reset role;

-- --- L1, feedback and triage rules ----------------------------------------------------------------
do $$ begin
  if to_regclass('public.feedback') is null or to_regclass('public.triage_rules') is null then
    raise notice '- v5 feedback and triage rules: skipped, not there yet';
    return;
  end if;
  if (select bool_and(relrowsecurity) from pg_class where oid in ('feedback'::regclass, 'triage_rules'::regclass)) is not true
    then raise exception 'RLS off on feedback or triage_rules'; end if;
  if has_table_privilege('anon', 'feedback', 'select') or has_table_privilege('anon', 'triage_rules', 'select')
    then raise exception 'anon can read feedback or triage_rules'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name in ('feedback', 'triage_rules'))
    then raise exception 'a public view reads feedback or triage_rules'; end if;
  if has_table_privilege('authenticated', 'feedback', 'update') or has_table_privilege('authenticated', 'feedback', 'delete')
    then raise exception 'feedback is not append-only for the browser'; end if;
  begin insert into feedback (item, action, ref) values ('mail', 'done', '{}');
    raise exception 'feedback took item mail';
  exception when check_violation then null; end;
  begin insert into feedback (item, action, ref) values ('needs_you', 'maybe', '{}');
    raise exception 'feedback took action maybe';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action) values ('domain', 'Acme.com', 'never');
    raise exception 'triage_rules took an uppercase pattern';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action) values ('domain', 'ab', 'never');
    raise exception 'triage_rules took a 2-character pattern';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action) values ('name', 'acme.com', 'never');
    raise exception 'triage_rules took match name';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action) values ('domain', 'acme.com', 'sometimes');
    raise exception 'triage_rules took action sometimes';
  exception when check_violation then null; end;
  insert into triage_rules (match, pattern, action) values ('domain', 'acme.com', 'never');
  begin insert into triage_rules (match, pattern, action) values ('domain', 'acme.com', 'always');
    raise exception 'triage_rules took the same pattern twice';
  exception when unique_violation then null; end;
  delete from triage_rules;
  if (select column_default from information_schema.columns where table_name = 'needs_you' and column_name = 'not_needed')
     is distinct from 'false' then raise exception 'needs_you.not_needed should default to false'; end if;

  -- nightly_roll keeps feedback 120 days.
  insert into feedback (at, item, action, ref) values
    (now() - interval '121 days', 'proposal', 'approve', '{"day": "2026-01-01", "rev": 1}'),
    (now() - interval '119 days', 'needs_you', 'not_needed', '{"account": "owner@example.com", "message_id": "18f2a3b4c5d6e7f1", "sender_hash": "b2d1910ecb638f419ce06372f8393efff2ab1f90e03954509117859182151af9"}');
  perform nightly_roll();
  if exists (select 1 from feedback where item = 'proposal') or not exists (select 1 from feedback where item = 'needs_you')
    then raise exception 'nightly_roll should keep feedback for 120 days, no longer'; end if;
  raise notice '✓ v5: feedback and triage_rules checked, private, feedback kept 120 days';
end $$;
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if to_regclass('public.feedback') is null or to_regclass('public.triage_rules') is null then return; end if;
  insert into feedback (item, action, ref) values ('block', 'turn_down', '{"day": "2026-11-04", "task_id": "00000000-0000-4000-8000-0000000000a1"}');
  begin update feedback set action = 'undo';
    raise exception 'the owner updated feedback';
  exception when insufficient_privilege then null; end;
  begin delete from feedback;
    raise exception 'the owner deleted feedback';
  exception when insufficient_privilege then null; end;
  insert into triage_rules (match, pattern, action) values ('address', 'jobs@acme.com', 'never');
  delete from triage_rules;
  raise notice '✓ v5: the owner appends feedback and edits triage rules';
end $$;
reset role;
do $$ begin
  if to_regclass('public.feedback') is not null then delete from feedback; end if;
end $$;

-- --- A1, suggested tasks ----------------------------------------------------------------------
do $$
declare
  d date := sheet_today() + 9;
  u text := 'owner@example.com:18f2a3b4c5d6e7f1';
  s jsonb := '[{"account": "owner@example.com", "message_id": "18f2a3b4c5d6e7f1", "title": "Acme assessment", "due": "2026-11-07", "kind": "assessment"}]';
begin
  if to_regprocedure('approve_proposal(date, integer)') is null
     or (select prosrc from pg_proc where oid = to_regprocedure('approve_proposal(date, integer)')) not like '%suggested%' then
    raise notice '- v5 suggested tasks: skipped, approve_proposal does not read them yet';
    return;
  end if;
  perform apply_proposal(d => d, replaces => null, blocks => '[]', suggested => s);
  perform approve_proposal(d, 1);
  if (select count(*) from tasks where source = 'mail' and source_uid = u) <> 1
    then raise exception 'approving a suggestion should make one task'; end if;
  if (select (title, list, day, public, due) from tasks where source = 'mail' and source_uid = u)
     is distinct from ('Acme assessment'::text, 'Inbox'::text, null::date, false, '2026-11-07'::date)
    then raise exception 'a suggested task should be private, in Inbox, due as suggested'; end if;
  if not exists (select 1 from feed_seen f where f.source = 'mail' and f.uid = u)
    then raise exception 'a suggested task should be recorded in feed_seen'; end if;
  -- Deleted, then suggested again by a later revision: no second task.
  delete from tasks where source = 'mail' and source_uid = u;
  perform apply_proposal(d => d, replaces => 1, blocks => '[]', suggested => s);
  perform approve_proposal(d, 2);
  if exists (select 1 from tasks where source = 'mail' and source_uid = u)
    then raise exception 'one message made a second task'; end if;
  delete from proposals where day = d;
  delete from feed_seen f where f.source = 'mail' and f.uid = u;
  raise notice '✓ v5: approve_proposal makes each suggested task once, ever';
end $$;

-- --- SRC3, Handshake, the academic calendar and enrollment ---------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'settings' and column_name = 'enrollment_at') then
    raise notice '- v5 enrollment and sheet-ical: skipped, not there yet';
    return;
  end if;
  if (select data_type from information_schema.columns where table_name = 'settings' and column_name = 'enrollment_at')
     <> 'timestamp with time zone' then raise exception 'settings.enrollment_at should be timestamptz'; end if;
  if (select count(*) from cron.job where jobname = 'sheet-ical') <> 1
    or (select schedule from cron.job where jobname = 'sheet-ical') <> '25 * * * *'
    then raise exception 'sheet-ical not scheduled once at minute 25'; end if;
  -- The feed links are function secrets, never settings columns the browser could read.
  if exists (select 1 from information_schema.columns where table_name = 'settings' and column_name ~ '(handshake|academic)')
    then raise exception 'a settings column holds a feed link'; end if;
  -- One enrollment task: ical-sync upserts it on (source, source_uid).
  insert into tasks (title, day, at_time, est_min, public, source, source_uid)
  values ('Enrollment opens', sheet_today() + 8, '07:00', 15, false, 'enrollment', 'enrollment')
  on conflict (source, source_uid) do update set day = excluded.day, at_time = excluded.at_time;
  insert into tasks (title, day, at_time, est_min, public, source, source_uid)
  values ('Enrollment opens', sheet_today() + 8, '09:30', 15, false, 'enrollment', 'enrollment')
  on conflict (source, source_uid) do update set day = excluded.day, at_time = excluded.at_time;
  if (select count(*) from tasks where source = 'enrollment') <> 1
    or (select at_time from tasks where source = 'enrollment') <> '09:30'
    then raise exception 'the enrollment task should be one task, moved in place'; end if;
  delete from tasks where source = 'enrollment';
  raise notice '✓ v5: enrollment_at, sheet-ical at :25, and one enrollment task';
end $$;

-- handshake_sync_save replaces only handshake rows in its window, and academic_days is owner-only
-- and written by the server alone. Fixed times, as for busy_sync_save.
do $$ begin
  if to_regclass('public.academic_days') is null then
    raise notice '- v5 handshake_sync_save and academic_days: skipped, not there yet';
    return;
  end if;
  if not (select relrowsecurity from pg_class where oid = 'academic_days'::regclass)
    or has_table_privilege('anon', 'academic_days', 'select')
    or has_table_privilege('authenticated', 'academic_days', 'insert')
    or has_table_privilege('authenticated', 'academic_days', 'update')
    then raise exception 'academic_days should be owner-only and server-written'; end if;
  if has_function_privilege('anon', 'handshake_sync_save(timestamptz, timestamptz, jsonb)', 'execute')
    or has_function_privilege('authenticated', 'handshake_sync_save(timestamptz, timestamptz, jsonb)', 'execute')
    or not has_function_privilege('service_role', 'handshake_sync_save(timestamptz, timestamptz, jsonb)', 'execute')
    then raise exception 'handshake_sync_save should be service-only'; end if;
  insert into busy (source, starts_at, ends_at) values
    ('calendar', '2031-01-01 13:00+00', '2031-01-01 14:00+00'),
    ('handshake', '2031-01-01 13:00+00', '2031-01-01 14:00+00'),
    ('handshake', '2031-01-09 13:00+00', '2031-01-09 14:00+00');
  perform handshake_sync_save('2031-01-01 12:00+00', '2031-01-08 12:00+00',
    '[{"starts_at": "2031-01-02T15:00:00Z", "ends_at": "2031-01-02T15:45:00Z"}]');
  if not exists (select 1 from busy where source = 'calendar' and starts_at = '2031-01-01 13:00+00')
    or exists (select 1 from busy where source = 'handshake' and starts_at = '2031-01-01 13:00+00')
    or not exists (select 1 from busy where source = 'handshake' and starts_at = '2031-01-02 15:00+00')
    or not exists (select 1 from busy where source = 'handshake' and starts_at = '2031-01-09 13:00+00')
    then raise exception 'handshake_sync_save replaced the wrong rows'; end if;
  if to_regclass('public.changes') is not null then
    delete from changes where kind = 'handshake';
    perform handshake_sync_save('2031-01-01 12:00+00', '2031-01-08 12:00+00',
      '[{"starts_at": "2031-01-02T15:00:00Z", "ends_at": "2031-01-02T15:45:00Z"}]');
    if exists (select 1 from changes where kind = 'handshake')
      then raise exception 'an unchanged Handshake feed wrote a change'; end if;
    perform handshake_sync_save('2031-01-01 12:00+00', '2031-01-08 12:00+00', '[]');
    if (select count(*) from changes where kind = 'handshake' and reason = 'handshake_change' and weight = 3) <> 1
      then raise exception 'a changed Handshake feed should write one change'; end if;
    delete from changes where kind = 'handshake';
  end if;
  delete from busy where starts_at >= '2031-01-01';
  raise notice '✓ v5: handshake_sync_save replaces Handshake rows only; academic_days owner-only';
end $$;
SQL
psql_as postgres >/dev/null <<'SQL'
-- --- v5 wave 3: M1, SRC1 and SRC2 (docs/sheet-v5.md, "Schema") -------------------------------
-- Each block skips itself until the tables or columns it checks exist, so these pass before their
-- tickets land.
\set QUIET on
\pset tuples_only on

-- --- M1, reply tracking -------------------------------------------------------------------------
do $$ begin
  if to_regclass('public.known_senders') is null or to_regclass('public.message_senders') is null
     or to_regclass('public.reply_state') is null then
    raise notice '- v5 known_senders, message_senders and reply_state: skipped, not there yet';
    return;
  end if;
  if (select bool_and(relrowsecurity) from pg_class
      where oid in ('known_senders'::regclass, 'message_senders'::regclass, 'reply_state'::regclass)) is not true
    then raise exception 'RLS off on a reply tracking table'; end if;
  if has_table_privilege('anon', 'known_senders', 'select') or has_table_privilege('anon', 'message_senders', 'select')
    or has_table_privilege('anon', 'reply_state', 'select')
    then raise exception 'anon can read a reply tracking table'; end if;
  if has_table_privilege('authenticated', 'known_senders', 'insert') or has_table_privilege('authenticated', 'known_senders', 'update')
    or has_table_privilege('authenticated', 'known_senders', 'delete')
    or has_table_privilege('authenticated', 'message_senders', 'insert') or has_table_privilege('authenticated', 'message_senders', 'update')
    or has_table_privilege('authenticated', 'message_senders', 'delete')
    or has_table_privilege('authenticated', 'reply_state', 'insert') or has_table_privilege('authenticated', 'reply_state', 'update')
    or has_table_privilege('authenticated', 'reply_state', 'delete')
    then raise exception 'the browser can write a reply tracking table'; end if;
  if not has_table_privilege('authenticated', 'reply_state', 'select')
    then raise exception 'the owner cannot read reply_state'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now')
               and table_name in ('known_senders', 'message_senders', 'reply_state'))
    then raise exception 'a public view reads a reply tracking table'; end if;
  -- known_senders holds hashes only, never an address.
  begin insert into known_senders (hash, last_sent_at) values ('ana.ruiz@example.edu', now());
    raise exception 'known_senders took an address';
  exception when check_violation then null; end;
  begin insert into known_senders (hash, last_sent_at) values (repeat('A', 64), now());
    raise exception 'known_senders took an uppercase hash';
  exception when check_violation then null; end;
  insert into known_senders (hash, last_sent_at)
    values ('b2d1910ecb638f419ce06372f8393efff2ab1f90e03954509117859182151af9', now());
  begin insert into known_senders (hash, last_sent_at)
      values ('b2d1910ecb638f419ce06372f8393efff2ab1f90e03954509117859182151af9', now());
    raise exception 'known_senders took the same hash twice';
  exception when unique_violation then null; end;
  begin insert into reply_state (account, thread_id, state, since, message_id, who)
      values ('owner@example.com', '18f3a1c2d4e5f000', 'pending', now(), '18f3a1c2d4e5f002', 'Ana Ruiz');
    raise exception 'reply_state took state pending';
  exception when check_violation then null; end;
  begin insert into reply_state (account, thread_id, state, since, message_id, who)
      values ('owner@example.com', '18f3a1c2d4e5f000', 'owed', now(), '18f3a1c2d4e5f002', repeat('a', 81));
    raise exception 'reply_state took an 81-character who';
  exception when check_violation then null; end;
  insert into reply_state (account, thread_id, state, since, message_id, who)
    values ('owner@example.com', '18f3a1c2d4e5f000', 'owed', now(), '18f3a1c2d4e5f002', 'Ana Ruiz');
  begin insert into reply_state (account, thread_id, state, since, message_id, who)
      values ('owner@example.com', '18f3a1c2d4e5f000', 'awaiting', now(), '18f3a1c2d4e5f003', 'Ana Ruiz');
    raise exception 'reply_state took a thread twice';
  exception when unique_violation then null; end;
  begin insert into message_senders (account, message_id, thread_id, at) values ('owner@example.com', '18f3a1c2d4e5f002', '18f3a1c2d4e5f000', now());
    raise exception 'message_senders took a row with no address_hash';
  exception when not_null_violation then null; end;
  if (select data_type from information_schema.columns where table_name = 'mail_accounts' and column_name = 'history_id')
     is distinct from 'text' then raise exception 'mail_accounts.history_id missing'; end if;
  if (select count(*) from cron.job where jobname = 'sheet-mail') <> 1
    or (select schedule from cron.job where jobname = 'sheet-mail') <> '2-59/5 * * * *'
    then raise exception 'sheet-mail not scheduled once, every 5 minutes from minute 2'; end if;
  delete from reply_state;
  delete from known_senders;
  raise notice '✓ v5: known_senders hashes only; reply tracking private and server-written; sheet-mail every 5 minutes';
end $$;

-- Reply owed's evidence: basis is thread, known, cc or null; draft defaults to false.
do $$ begin
  if to_regclass('public.reply_state') is null then return; end if;
  insert into reply_state (account, thread_id, state, since, message_id, who, basis)
    values ('owner@example.com', 'ro-1', 'owed', now(), '18f3a1c2d4e5f002', 'Ana Ruiz', 'thread');
  insert into reply_state (account, thread_id, state, since, message_id, who)
    values ('owner@example.com', 'ro-2', 'awaiting', now(), '18f3a1c2d4e5f003', 'Ana Ruiz');
  if (select draft from reply_state where thread_id = 'ro-1') is distinct from false
    or (select basis from reply_state where thread_id = 'ro-2') is not null
    then raise exception 'reply_state basis and draft defaults wrong'; end if;
  begin insert into reply_state (account, thread_id, state, since, message_id, who, basis)
      values ('owner@example.com', 'ro-3', 'owed', now(), '18f3a1c2d4e5f004', 'Ana Ruiz', 'guess');
    raise exception 'reply_state took basis guess';
  exception when check_violation then null; end;
  delete from reply_state where thread_id like 'ro-%';
  raise notice '✓ reply_state keeps basis (thread, known, cc) and draft';
end $$;

-- Fix: no From address in plain text (docs/sheet-v5.md, "Sender hashes").
do $$ begin
  if to_regclass('public.message_senders') is null then return; end if;
  if exists (select 1 from information_schema.columns where table_name in ('message_senders', 'needs_you') and column_name = 'from_address')
    then raise exception 'message_senders or needs_you still has from_address'; end if;
  begin insert into message_senders (account, message_id, thread_id, address_hash, at)
      values ('owner@example.com', 'fx-1', 'fx', 'jobs@acme.com', now());
    raise exception 'message_senders took an address as its hash';
  exception when check_violation then null; end;
  begin insert into message_senders (account, message_id, thread_id, address_hash, domain_hashes, at)
      values ('owner@example.com', 'fx-1', 'fx', repeat('a', 64), array['acme.com'], now());
    raise exception 'message_senders took a domain as a domain hash';
  exception when check_violation then null; end;
  insert into message_senders (account, message_id, thread_id, address_hash, domain_hashes, at)
    values ('owner@example.com', 'fx-1', 'fx', repeat('a', 64), array[repeat('b', 64), repeat('c', 64)], now());
  delete from message_senders where thread_id = 'fx';
  begin insert into needs_you (day, account, message_id, link, sender, subject, why, kind, sender_hash)
      values (sheet_today(), 'owner@example.com', 'fx-2', 'x', 'Acme', 'Hi', 'Why', 'reply', 'jobs@acme.com');
    raise exception 'needs_you took an address as its sender_hash';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action) values ('sender', 'jobs@acme.com', 'never');
    raise exception 'triage_rules took a sender rule that is not a hash';
  exception when check_violation then null; end;
  begin insert into triage_rules (match, pattern, action, label) values ('sender', repeat('a', 64), 'never', repeat('x', 81));
    raise exception 'triage_rules took an 81-character label';
  exception when check_violation then null; end;
  insert into triage_rules (match, pattern, action, label) values ('sender', repeat('a', 64), 'never', 'Acme Recruiting');
  delete from triage_rules where match = 'sender';
  raise notice '✓ fix: message_senders, needs_you and sender rules hold hashes, never a From address';
end $$;

-- M1, beyond the verification checks: nightly_roll keeps 14 days of reply_state and message_senders.
do $$ begin
  if to_regclass('public.reply_state') is null or to_regclass('public.message_senders') is null then return; end if;
  insert into reply_state (account, thread_id, state, since, message_id, who) values
    ('owner@example.com', 'm1-old', 'owed', now() - interval '15 days', 'm1-old-1', 'Ana Ruiz'),
    ('owner@example.com', 'm1-new', 'awaiting', now() - interval '4 days', 'm1-new-1', 'Prof. Kim');
  insert into message_senders (account, message_id, thread_id, address_hash, at) values
    ('owner@example.com', 'm1-old-1', 'm1-old', repeat('a', 64), now() - interval '15 days'),
    ('owner@example.com', 'm1-new-0', 'm1-new', repeat('b', 64), now() - interval '5 days');
  perform nightly_roll();
  if exists (select 1 from reply_state where thread_id = 'm1-old') or not exists (select 1 from reply_state where thread_id = 'm1-new')
    or exists (select 1 from message_senders where message_id = 'm1-old-1') or not exists (select 1 from message_senders where message_id = 'm1-new-0')
    then raise exception 'nightly_roll should keep 14 days of reply_state and message_senders'; end if;
  delete from reply_state where thread_id like 'm1-%';
  delete from message_senders where thread_id like 'm1-%';
  raise notice '✓ v5: reply_state and message_senders kept 14 days';
end $$;

-- --- SRC1, GitHub and Jira tasks ------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'settings' and column_name = 'github_orgs') then
    raise notice '- v5 GitHub and Jira: skipped, not there yet';
    return;
  end if;
  if (select github_orgs from settings) is distinct from '{}'::text[]
    then raise exception 'settings.github_orgs should default to none'; end if;
  begin insert into tasks (title, public, list, link) values ('SRC1 http link', false, 'GitHub', 'http://github.com/acme-robotics/planner/pull/41');
    raise exception 'tasks took an http:// link';
  exception when check_violation then null; end;
  begin insert into tasks (title, public, list, link) values ('SRC1 script link', false, 'GitHub', 'javascript:alert(1)');
    raise exception 'tasks took a javascript: link';
  exception when check_violation then null; end;
  insert into tasks (title, public, list, source, source_uid, link)
    values ('Review: Add retry to the sync worker', false, 'GitHub', 'github', 'https://github.com/acme-robotics/planner/pull/41',
            'https://github.com/acme-robotics/planner/pull/41');
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name = 'tasks' and column_name = 'link')
    then raise exception 'a public view reads tasks.link'; end if;
  delete from tasks where source = 'github';
  if (select count(*) from cron.job where jobname = 'sheet-work') <> 1
    or (select schedule from cron.job where jobname = 'sheet-work') <> '40 * * * *'
    then raise exception 'sheet-work not scheduled once at minute 40'; end if;
  raise notice '✓ v5: github_orgs, https-only task links kept out of public views, sheet-work at :40';
end $$;

-- SRC1: /now shows no GitHub or Jira task. They are private, so planned on today and running now,
-- each shows only as a length, never its title, tag or link.
do $$ declare g uuid := gen_random_uuid(); j uuid := gen_random_uuid(); begin
  if not exists (select 1 from information_schema.columns where table_name = 'tasks' and column_name = 'link') then
    raise notice '- v5 GitHub and Jira on /now: skipped, not there yet';
    return;
  end if;
  insert into tasks (id, title, day, public, tag, source, source_uid, link) values
    (g, 'Review: Add retry to the sync worker', sheet_today(), false, 'workit', 'github',
     'https://github.com/acme-robotics/planner/pull/41', 'https://github.com/acme-robotics/planner/pull/41'),
    (j, 'KAN-12 Write the onboarding checklist', sheet_today(), false, null, 'jira', 'KAN-12', 'https://example-team.atlassian.net/browse/KAN-12');
  delete from blocks where not proposed and starts_at <= now() and ends_at > now();
  insert into blocks (task_id, starts_at, ends_at) values (g, now() - interval '10 minutes', now() + interval '20 minutes');
  set local role anon;
  if (select title is not null or tag is not null or public from public_now) then raise exception 'public_now showed a GitHub task'; end if;
  if exists (select 1 from public_week where id in (g, j) and (title is not null or tag is not null or bar is null))
    then raise exception 'public_week showed a GitHub or Jira task'; end if;
  reset role;
  delete from tasks where id in (g, j);
  raise notice '✓ v5: /now shows GitHub and Jira tasks only as private lengths';
end $$;

-- --- SRC2, Slack in Needs you -----------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'needs_you' and column_name = 'source') then
    raise notice '- v5 Slack in Needs you: skipped, not there yet';
    return;
  end if;
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind)
    values (sheet_today(), 'owner@example.com', '18f3a1c2d4e5f0aa', 'https://mail.google.com/mail/?authuser=owner@example.com#all/18f3a1c2d4e5f0aa',
            'Ana Ruiz', 'Lab 4', 'Asked a question', 'reply');
  if (select source from needs_you where message_id = '18f3a1c2d4e5f0aa') <> 'mail'
    then raise exception 'needs_you.source should default to mail'; end if;
  begin insert into needs_you (day, account, message_id, link, sender, subject, why, kind, source)
      values (sheet_today(), 'teams', 'x:1', 'https://example.com', 'dana.lee', 'Chat', 'Mentioned you', 'reply', 'teams');
    raise exception 'needs_you took source teams';
  exception when check_violation then null; end;
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind, source)
    values (sheet_today(), 'slack', 'C0EXAMPLE1:1762354800.000100', 'https://example-team.slack.com/archives/C0EXAMPLE1/p1762354800000100',
            'dana.lee', '#team-backend', 'Mentioned you', 'reply', 'slack');
  begin insert into needs_you (day, account, message_id, link, sender, subject, why, kind, source)
      values (sheet_today(), 'slack', 'C0EXAMPLE1:1762354800.000100', 'https://example-team.slack.com/archives/C0EXAMPLE1/p1762354800000100',
              'dana.lee', '#team-backend', 'Mentioned you', 'reply', 'slack');
    raise exception 'needs_you took the same Slack message twice';
  exception when unique_violation then null; end;
  delete from needs_you where message_id in ('18f3a1c2d4e5f0aa', 'C0EXAMPLE1:1762354800.000100');
  if (select count(*) from cron.job where jobname = 'sheet-slack') <> 1
    or (select schedule from cron.job where jobname = 'sheet-slack') <> '42 * * * *'
    then raise exception 'sheet-slack not scheduled once at minute 42'; end if;
  raise notice '✓ v5: needs_you.source mail or slack, one row per Slack message, sheet-slack at :42';
end $$;

-- A new revision replaces the day's open mail rows only: Slack rows stay until he marks them done.
do $$
declare d date := sheet_today() + 40;
begin
  if not exists (select 1 from information_schema.columns where table_name = 'needs_you' and column_name = 'source') then
    raise notice '- v5 Slack rows kept by a revision: skipped, not there yet';
    return;
  end if;
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind, source)
    values (d, 'slack', 'C0KEEP:1762354800.000100', 'https://example-team.slack.com/archives/C0KEEP/p1762354800000100',
            'dana.lee', '#team-backend', 'Mentioned you', 'reply', 'slack'),
           (d, 'owner@example.com', 'keep-mail-1', 'https://mail.google.com/mail/#all/keep-mail-1',
            'Ana Ruiz', 'Lab 4', 'Asked a question', 'reply', 'mail');
  perform apply_proposal(d => d, replaces => null, blocks => '[]');
  if not exists (select 1 from needs_you where message_id = 'C0KEEP:1762354800.000100')
    then raise exception 'a revision deleted an open Slack row'; end if;
  if exists (select 1 from needs_you where message_id = 'keep-mail-1')
    then raise exception 'a revision kept an open mail row'; end if;
  delete from needs_you where message_id = 'C0KEEP:1762354800.000100';
  delete from proposals where day = d;
  raise notice '✓ v5: a revision replaces open mail rows and keeps Slack ones';
end $$;
SQL
psql_as postgres >/dev/null <<'SQL'
-- --- Messages to Claude (docs/sheet-messages.md) ------------------------------------------------
-- A new session, so it needs its own as_user.
\set QUIET on
\pset tuples_only on
create function pg_temp.as_user(r text, email text) returns void language sql as $$
  select set_config('role', r, false),
         set_config('request.jwt.claims', coalesce(json_build_object('email', email)::text, ''), false) $$;
select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from messages; raise exception 'anon read messages';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  begin insert into messages (text) values ('dentist Thu 3pm'); raise exception 'a stranger added a message';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$
declare
  m uuid;
  m2 uuid;
  before double precision;
begin
  begin insert into messages (text) values (''); raise exception 'messages took empty text';
  exception when check_violation then null; end;
  begin insert into messages (text) values (repeat('a', 8001)); raise exception 'messages took 8001 characters';
  exception when check_violation then null; end;
  insert into messages (text) values (repeat('a', 8000)) returning id into m;
  delete from messages where id = m;
  begin insert into messages (text, reply) values ('x', repeat('r', 501)); raise exception 'messages took a 501-character reply';
  exception when check_violation then null; end;
  insert into messages (text) values ('lab report due Friday, ~2h; dentist Thu 3pm') returning id into m;
  if (select status <> 'pending' or events <> '[]'::jsonb or created_in_calendar or tasks_added <> 0 from messages where id = m)
    then raise exception 'a new message is not pending and empty'; end if;
  insert into tasks (title, list, position) values ('MSG already in Inbox', 'Inbox', 41);
  select max(position) into before from tasks where list = 'Inbox' and day is null;
  if answer_message(m, '[{"title": "MSG lab report", "day": null, "list": "Inbox", "due": "2026-11-06", "at_time": null, "est_min": 120}]',
       '[{"title": "Dentist", "starts_at": "2026-11-05T20:00:00.000Z", "ends_at": "2026-11-05T21:00:00.000Z"}]',
       'Lab report is in your Inbox, due Fri; dentist Thu 3:00 pm.') <> 'done'
    then raise exception 'answer_message did not say done'; end if;
  if (select status <> 'done' or tasks_added <> 1 or events -> 0 ->> 'title' <> 'Dentist' or reply not like 'Lab report%' from messages where id = m)
    then raise exception 'answer_message did not write the message'; end if;
  if (select source <> 'message' or position <> before + 1 or due <> '2026-11-06' or est_min <> 120 from tasks where title = 'MSG lab report')
    then raise exception 'answer_message did not add the task at the end of Inbox'; end if;
  begin perform answer_message(m, '[]', '[]', 'again'); raise exception 'answer_message answered a message twice';
  exception when raise_exception then
    if sqlerrm not like '%not pending%' then raise; end if;
  end;
  insert into messages (text) values ('asdf') returning id into m2;
  if answer_message(m2, '[]', '[]', 'Not sure what that means.') <> 'failed'
    then raise exception 'an answer that adds nothing should fail the message'; end if;
  -- The event is a busy time the planner sees, source 'message', tied to its message.
  if (select count(*) from busy where source = 'message' and message_id = m
        and starts_at = '2026-11-05T20:00:00Z' and ends_at = '2026-11-05T21:00:00Z') <> 1
    then raise exception 'answer_message did not save the event as a busy time'; end if;
  -- busy-sync replaces only calendar rows, so the event's busy time stays.
  reset role;
  perform busy_sync_save('2026-11-05T00:00:00Z', '2026-11-06T00:00:00Z', '[]');
  if not exists (select 1 from busy where message_id = m)
    then raise exception 'busy_sync_save deleted a message busy time'; end if;
  perform pg_temp.as_user('authenticated', 'owner@example.com');
  -- /plan marks the events created in Google Calendar.
  update messages set created_in_calendar = true where id = m;
  delete from tasks where title in ('MSG lab report', 'MSG already in Inbox');
  delete from messages where id in (m, m2);
  if exists (select 1 from busy where source = 'message' and starts_at = '2026-11-05T20:00:00Z')
    then raise exception 'deleting a message kept its busy time'; end if;
  raise notice '✓ messages: owner-only, answer_message adds tasks, events as busy times, and answers once';
end $$;
-- What a message added, item by item, and Undo on each (docs/sheet-messages.md).
do $$
declare
  m uuid;
  m2 uuid;
  t1 uuid;
  e1 uuid;
  e2 uuid;
  out jsonb;
begin
  insert into messages (text) values ('Project 2 due Nov 14 11:59pm; quiz Tue 9am; lab Wed 2pm') returning id into m;
  perform answer_message(m,
    '[{"title": "MSG Project 2 (due 11:59 pm)", "day": null, "list": "Inbox", "due": "2026-11-14", "at_time": null, "est_min": null},
      {"title": "MSG Read ch. 5", "day": "2026-11-09", "list": null, "due": "2026-11-10", "at_time": null, "est_min": 60}]',
    '[{"title": "Quiz ch. 5", "starts_at": "2026-11-10T14:00:00.000Z", "ends_at": "2026-11-10T15:00:00.000Z"},
      {"title": "Lab", "starts_at": "2026-11-11T19:00:00.000Z", "ends_at": "2026-11-11T20:00:00.000Z"}]',
    'Added 2 tasks and 2 events; skipped office hours (no day given).');
  -- Each task is listed with its id, title and place; each event gets an id.
  if (select jsonb_array_length(tasks) <> 2 or tasks -> 0 ->> 'title' <> 'MSG Project 2 (due 11:59 pm)'
        or tasks -> 0 ->> 'list' <> 'Inbox' or tasks -> 0 ->> 'due' <> '2026-11-14' or tasks -> 1 ->> 'day' <> '2026-11-09'
        from messages where id = m)
    then raise exception 'answer_message did not list the tasks it added'; end if;
  select (tasks -> 0 ->> 'id')::uuid, (events -> 0 ->> 'id')::uuid, (events -> 1 ->> 'id')::uuid into t1, e1, e2 from messages where id = m;
  if not exists (select 1 from tasks where id = t1 and title = 'MSG Project 2 (due 11:59 pm)')
    then raise exception 'a listed task id is not the task added'; end if;
  if e1 is null or e2 is null or e1 = e2 then raise exception 'events did not get their own ids'; end if;

  -- /plan records the Google event it made for an event.
  perform message_event_created(m, e1, 'gcal-abc');
  if (select events -> 0 ->> 'gcal_id' from messages where id = m) is distinct from 'gcal-abc'
    then raise exception 'message_event_created did not keep the Google id'; end if;

  -- Undo a task: the task goes, and so does its line.
  out := undo_message_item(m, t1);
  if out ->> 'kind' <> 'task' or out ->> 'title' <> 'MSG Project 2 (due 11:59 pm)' then raise exception 'undo of a task returned %', out; end if;
  if exists (select 1 from tasks where id = t1) then raise exception 'undo kept the task'; end if;
  if (select jsonb_array_length(tasks) <> 1 or tasks_added <> 1 or status <> 'done' from messages where id = m)
    then raise exception 'undo did not take the task off the message'; end if;

  -- Undo an event: its line and its busy time go; it comes back with its Google id, for /plan to delete.
  out := undo_message_item(m, e1);
  if out ->> 'kind' <> 'event' or out ->> 'gcal_id' <> 'gcal-abc' then raise exception 'undo of an event returned %', out; end if;
  if (select jsonb_array_length(events) <> 1 or events -> 0 ->> 'title' <> 'Lab' from messages where id = m)
    then raise exception 'undo did not take the event off the message'; end if;
  if exists (select 1 from busy where message_id = m and starts_at = '2026-11-10T14:00:00Z')
    then raise exception 'undo kept the event''s busy time'; end if;
  if not exists (select 1 from busy where message_id = m and starts_at = '2026-11-11T19:00:00Z')
    then raise exception 'undo took another event''s busy time'; end if;

  -- An item undone already, or of another message, is nothing to undo.
  if undo_message_item(m, e1) is not null then raise exception 'undo ran twice'; end if;

  -- Two messages with an event at the same times share a busy row; undoing one keeps it busy.
  insert into messages (text) values ('lab Wed 2pm') returning id into m2;
  perform answer_message(m2, '[]', '[{"title": "Lab again", "starts_at": "2026-11-11T19:00:00.000Z", "ends_at": "2026-11-11T20:00:00.000Z"}]', 'Lab Wed 2-3 pm.');
  perform undo_message_item(m, e2);
  if not exists (select 1 from busy where source = 'message' and message_id = m2 and starts_at = '2026-11-11T19:00:00Z')
    then raise exception 'undo left the other message''s event without its busy time'; end if;

  -- A stranger can undo nothing.
  perform pg_temp.as_user('authenticated', 'stranger@example.com');
  if undo_message_item(m2, (select (events -> 0 ->> 'id')::uuid from messages where id = m2)) is not null
    then raise exception 'a stranger undid an item'; end if;
  perform pg_temp.as_user('authenticated', 'owner@example.com');
  if (select jsonb_array_length(events) from messages where id = m2) <> 1 then raise exception 'a stranger changed a message'; end if;

  delete from tasks where title like 'MSG %';
  delete from messages where id in (m, m2);
  raise notice '✓ messages: each added item is listed, and undone one at a time';
end $$;
-- Claude's steps on a message, and its notes on each item (docs/sheet-messages.md).
do $$
declare
  m uuid;
  m2 uuid;
begin
  insert into messages (text, session_url) values ('quiz Tue 9am', 'https://claude.ai/code/session_x') returning id into m;
  insert into messages (text) values ('done one') returning id into m2;
  perform answer_message(m2, '[{"title": "MSG x", "day": null, "list": "Inbox", "due": null, "at_time": null, "est_min": null}]', '[]', 'Added x.');
  perform add_message_step(array[m, m2], 'checking', 'Checking Tuesday on your calendar');
  if (select jsonb_array_length(steps) <> 1 or steps -> 0 ->> 'kind' <> 'checking' or steps -> 0 ->> 'text' <> 'Checking Tuesday on your calendar'
        or (steps -> 0 ->> 'at')::timestamptz > now() from messages where id = m)
    then raise exception 'add_message_step did not add the step'; end if;
  if (select jsonb_array_length(steps) from messages where id = m2) <> 0
    then raise exception 'an answered message took a step'; end if;
  for i in 1..15 loop perform add_message_step(array[m], 'adding', 'Adding ' || i); end loop;
  if (select jsonb_array_length(steps) from messages where id = m) <> 12 then raise exception 'steps should stop at 12'; end if;
  -- A stranger adds nothing.
  perform pg_temp.as_user('authenticated', 'stranger@example.com');
  perform add_message_step(array[m], 'adding', 'Stranger');
  perform pg_temp.as_user('authenticated', 'owner@example.com');
  if exists (select 1 from messages where id = m and steps::text like '%Stranger%') then raise exception 'a stranger added a step'; end if;
  update messages set steps = '[]' where id = m;
  perform add_message_step(array[m], 'adding', 'Adding 1');
  -- The answer keeps each item's why, and when it came.
  perform answer_message(m,
    '[{"title": "MSG Read ch. 5", "day": null, "list": "Inbox", "due": "2026-11-10", "at_time": null, "est_min": null, "why": "Before the quiz."}]',
    '[{"title": "Quiz", "starts_at": "2026-11-10T14:00:00.000Z", "ends_at": "2026-11-10T15:00:00.000Z", "why": "A class quiz at a time."}]', 'Added.');
  if (select tasks -> 0 ->> 'why' <> 'Before the quiz.' or events -> 0 ->> 'why' <> 'A class quiz at a time.' or answered_at is null
        or jsonb_array_length(steps) <> 1 from messages where id = m)
    then raise exception 'answer_message did not keep the whys and answered_at'; end if;
  if (select answered_at from messages where id = m2) is null then raise exception 'answered_at missing'; end if;
  delete from tasks where title like 'MSG %';
  delete from messages where id in (m, m2);
  raise notice '✓ messages: steps (at most 12, pending only, owner only), whys and answered_at';
end $$;
reset role;
do $$ begin
  insert into messages (at, text) values (now() - interval '31 days', 'old one'), (now() - interval '29 days', 'new one');
  insert into busy (source, starts_at, ends_at, message_id)
    select 'message', now() + interval '1 day', now() + interval '1 day 1 hour', id from messages where text = 'old one';
  perform nightly_roll();
  if exists (select 1 from busy where source = 'message')
    then raise exception 'an old message kept its busy time'; end if;
  if exists (select 1 from messages where text = 'old one') or not exists (select 1 from messages where text = 'new one')
    then raise exception 'nightly_roll should keep 30 days of messages'; end if;
  delete from messages where text = 'new one';
  raise notice '✓ messages kept 30 days';
end $$;
-- --- Oura (docs/sheet-v5.md, "Oura") ---------------------------------------------------------
reset role;
do $$ begin
  if exists (select 1 from pg_class where relname in ('oura_account', 'sleep_nights', 'sleep_days') and not relrowsecurity)
    then raise exception 'RLS off on an Oura table'; end if;
  if exists (select 1 from information_schema.view_column_usage
             where view_name in ('public_week', 'public_days', 'public_now') and table_name in ('oura_account', 'sleep_nights', 'sleep_days'))
    then raise exception 'a public view exposes Oura data'; end if;
  if (select schedule from cron.job where jobname = 'sheet-oura') is distinct from '4-59/10 * * * *'
    or (select count(*) from cron.job where jobname = 'sheet-oura') <> 1
    then raise exception 'sheet-oura not scheduled once every 10 minutes'; end if;
  if has_function_privilege('anon', 'oura_token_save(text, text, timestamptz, text)', 'execute')
    or has_function_privilege('authenticated', 'oura_token_save(text, text, timestamptz, text)', 'execute')
    or has_function_privilege('anon', 'oura_tokens()', 'execute')
    or has_function_privilege('authenticated', 'oura_tokens()', 'execute')
    or has_function_privilege('authenticated', 'oura_sync_save(jsonb, jsonb, jsonb)', 'execute')
    or has_function_privilege('authenticated', 'oura_broken(text)', 'execute')
    then raise exception 'Oura functions callable by anon or authenticated'; end if;
  if not has_function_privilege('service_role', 'oura_token_save(text, text, timestamptz, text)', 'execute')
    or not has_function_privilege('service_role', 'oura_tokens()', 'execute')
    or not has_function_privilege('service_role', 'oura_sync_save(jsonb, jsonb, jsonb)', 'execute')
    then raise exception 'service_role cannot call the Oura functions'; end if;

  -- Connect, then rotate: the new pair is saved only over the token it replaced.
  if not oura_token_save('r1', 'a1', '2030-01-01T00:00:00Z') then raise exception 'connect did not save'; end if;
  if not oura_token_save('r2', 'a2', '2030-01-02T00:00:00Z', 'r1') then raise exception 'rotation did not save'; end if;
  if oura_token_save('r3', 'a3', '2030-01-03T00:00:00Z', 'r1') then raise exception 'a stale rotation overwrote the newer token'; end if;
  if not oura_token_save('r2', 'a2', '2030-01-02T00:00:00Z', 'r1') then raise exception 'a retried save was refused'; end if;
  if oura_tokens()->>'refresh' <> 'r2' or oura_tokens()->>'access' <> 'a2'
    or (select count(*) from vault.secrets where name in ('oura_refresh', 'oura_access')) <> 2
    then raise exception 'Oura tokens not rotated in place'; end if;
  perform oura_broken('token refresh refused: invalid_grant');
  if (select last_error from oura_account) is null then raise exception 'oura_broken did not mark the grant'; end if;
  perform oura_token_save('r4', 'a4', '2030-01-04T00:00:00Z');
  if (select last_error from oura_account) is not null then raise exception 'reconnecting kept the old error'; end if;

  -- The sync upserts by Oura id and logs a woke-late change once per wake.
  perform oura_sync_save('[{"oura_id": "s1", "day": "2030-01-02", "type": "sleep", "bedtime_start": "2030-01-02T05:00:00Z", "bedtime_end": "2030-01-02T14:00:00Z"}]',
    '[{"day": "2030-01-02", "readiness": 64, "sleep_s": 20400}]');
  perform oura_sync_save('[{"oura_id": "s1", "day": "2030-01-02", "type": "long_sleep", "bedtime_start": "2030-01-02T05:00:00Z", "bedtime_end": "2030-01-02T15:20:00Z"}]',
    '[{"day": "2030-01-02", "readiness": null, "sleep_s": 21000}]',
    '{"kind": "sleep", "reason": "woke_late", "weight": 9, "ref": "2030-01-02T15:20:00Z"}');
  perform oura_sync_save('[]', '[]', '{"kind": "sleep", "reason": "woke_late", "weight": 9, "ref": "2030-01-02T15:20:00Z"}');
  if (select count(*) from sleep_nights) <> 1 or (select type from sleep_nights) <> 'long_sleep'
    or (select bedtime_end from sleep_nights) <> '2030-01-02T15:20:00Z'
    then raise exception 'oura_sync_save did not upsert by oura_id'; end if;
  if (select readiness from sleep_days) <> 64 or (select sleep_s from sleep_days) <> 21000
    then raise exception 'oura_sync_save lost a readiness or took the new sleep total'; end if;
  if (select count(*) from changes where reason = 'woke_late') <> 1 then raise exception 'the woke-late change was not logged once'; end if;
  if (select synced_at from oura_account) is null then raise exception 'oura_sync_save did not stamp synced_at'; end if;
  delete from changes where reason = 'woke_late';
  raise notice '✓ Oura: private, functions service-only, tokens rotate in place, sync upserts and logs woke-late once';
end $$;

select pg_temp.as_user('anon', null);
do $$ begin
  begin perform 1 from sleep_nights; raise exception 'anon read sleep_nights';
  exception when insufficient_privilege then null; end;
  begin perform 1 from oura_account; raise exception 'anon read oura_account';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  if (select count(*) from sleep_nights) + (select count(*) from sleep_days) + (select count(*) from oura_account) <> 0
    then raise exception 'a non-owner sees Oura data'; end if;
end $$;
select pg_temp.as_user('authenticated', 'owner@example.com');
do $$ begin
  if (select count(*) from sleep_nights) <> 1 or (select count(*) from oura_account) <> 1 then raise exception 'the owner cannot read Oura rows'; end if;
  begin
    insert into sleep_nights (oura_id, day, type, bedtime_start, bedtime_end) values ('x', '2030-01-01', 'sleep', now(), now());
    raise exception 'the browser wrote sleep_nights';
  exception when insufficient_privilege then null; end;
  begin update oura_account set last_error = null where id; raise exception 'the browser updated oura_account';
  exception when insufficient_privilege then null; end;
  -- Disconnect: the grant, both tokens and every sleep row go.
  delete from oura_account where id;
  if (select count(*) from oura_account) <> 0 then raise exception 'Disconnect left the grant'; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from vault.secrets where name in ('oura_refresh', 'oura_access'))
    or exists (select 1 from sleep_nights) or exists (select 1 from sleep_days)
    then raise exception 'Disconnect kept a token or sleep rows'; end if;
  -- Kept 60 days.
  insert into sleep_nights (oura_id, day, type, bedtime_start, bedtime_end) values
    ('old', current_date - 62, 'long_sleep', now() - interval '61 days 8 hours', now() - interval '61 days'),
    ('new', current_date - 58, 'long_sleep', now() - interval '59 days 8 hours', now() - interval '59 days');
  insert into sleep_days (day, readiness) values (current_date - 61, 70), (current_date - 59, 80);
  perform nightly_roll();
  if exists (select 1 from sleep_nights where oura_id = 'old') or not exists (select 1 from sleep_nights where oura_id = 'new')
    or exists (select 1 from sleep_days where day = current_date - 61) or not exists (select 1 from sleep_days where day = current_date - 59)
    then raise exception 'nightly_roll should keep 60 days of sleep'; end if;
  delete from sleep_nights where true;
  delete from sleep_days where true;
  -- A woke-late change has kind sleep; revisions keep their window start.
  insert into changes (kind, reason, weight) values ('sleep', 'woke_late', 9);
  delete from changes where kind = 'sleep';
  perform apply_proposal(d => '2030-01-04', replaces => null, blocks => '[]', window_from => '10:15');
  if (select window_from from proposals where day = '2030-01-04') <> '10:15' then raise exception 'apply_proposal lost window_from'; end if;
  delete from proposals where day = '2030-01-04';
  begin
    update proposals set window_from = '7:00' where false;
    insert into proposals (day, rev, window_from) values ('2030-01-05', 1, '25:00');
    raise exception 'window_from took a bad time';
  exception when check_violation then null; end;
  raise notice '✓ Oura: owner read-only, Disconnect deletes the grant, tokens and rows; kept 60 days';
end $$;
SQL
echo "✓ all schema checks passed"

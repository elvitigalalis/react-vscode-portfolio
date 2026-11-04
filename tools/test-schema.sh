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
select pg_temp.as_user('authenticated', 'owner@example.com');
create temp table v4_first as select now() as at;
select apply_proposal(sheet_today(),
  jsonb_build_array(
    jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', now() + interval '2 hours', 'ends_at', now() + interval '3 hours'),
    jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', now() + interval '4 hours', 'ends_at', now() + interval '5 hours')),
  '[{"account": "a@example.com", "message_id": "abc123", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/abc123",
     "sender": "Ana", "subject": "Demo moved", "why": "Reply by Thursday.", "kind": "reply", "due": "2026-11-05"}]',
  '[{"uid": "e1", "why": "Bagels."}]', 'Gym did not fit.');
update proposals set created_at = created_at - interval '1 hour';  -- so the resubmission's is newer
update needs_you set done = true;
select apply_proposal(sheet_today(),
  jsonb_build_array(jsonb_build_object('task_id', '00000000-0000-4000-8000-000000000001', 'starts_at', now() + interval '6 hours', 'ends_at', now() + interval '7 hours')),
  '[{"account": "a@example.com", "message_id": "abc123", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/abc123",
     "sender": "Ana", "subject": "Demo moved", "why": "Reply by Thursday.", "kind": "reply"},
    {"account": "a@example.com", "message_id": "def456", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/def456",
     "sender": "Bursar", "subject": "Spring bill", "why": "Pay it.", "kind": "admin"}]',
  '[]', null);
do $$ begin
  if (select count(*) from blocks where proposed) <> 1
    or not exists (select 1 from blocks where proposed and starts_at > now() + interval '5 hours')
    then raise exception 'resubmission did not replace the proposed blocks'; end if;
  if (select count(*) from blocks where not proposed) <> 1 then raise exception 'apply_proposal touched an approved block'; end if;
  if (select count(*) from proposals) <> 1
    or (select status from proposals) <> 'pending'
    or (select note from proposals) is not null
    or (select picks from proposals) <> '[]'::jsonb
    or (select created_at from proposals) < (select at from v4_first)
    then raise exception 'resubmission did not replace the proposals row'; end if;
  if (select count(*) from needs_you) <> 2 or not (select done from needs_you where message_id = 'abc123')
    then raise exception 'needs_you: a message already there was added again'; end if;
  raise notice '✓ apply_proposal replaces a pending proposal';
end $$;

-- An approved proposal is refused, and nothing changes.
update proposals set status = 'approved';
do $$ begin
  begin
    perform apply_proposal(sheet_today(), '[]', '[]', '[]', null);
    raise exception 'apply_proposal replaced an approved proposal';
  exception when raise_exception then
    if sqlerrm not like '%already approved%' then raise; end if;
  end;
  if (select count(*) from blocks where proposed) <> 1 then raise exception 'a refused apply changed blocks'; end if;
  raise notice '✓ apply_proposal refuses an approved proposal';
end $$;

-- A resubmission replaces the day's open Needs you items (done ones stay), and shutting a day
-- down lapses its proposal, which apply_proposal then refuses.
update proposals set status = 'pending';
select apply_proposal(sheet_today(), '[]',
  '[{"account": "a@example.com", "message_id": "aaa111", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/aaa111",
     "sender": "Ana", "subject": "One", "why": "Reply.", "kind": "reply"}]', '[]', null);
select apply_proposal(sheet_today(), '[]',
  '[{"account": "a@example.com", "message_id": "bbb222", "link": "https://mail.google.com/mail/?authuser=a%40example.com#all/bbb222",
     "sender": "Ana", "subject": "Two", "why": "Reply.", "kind": "reply"}]', '[]', null);
do $$ begin
  if exists (select 1 from needs_you where message_id = 'aaa111') then raise exception 'an open needs_you item survived a resubmission'; end if;
  if not exists (select 1 from needs_you where message_id = 'bbb222') then raise exception 'the resubmitted needs_you item is missing'; end if;
  if not exists (select 1 from needs_you where message_id = 'abc123' and done) then raise exception 'a done needs_you item was removed'; end if;
  raise notice '✓ a resubmission replaces open Needs you items';
end $$;
select shut_down(sheet_today(), null);
do $$ begin
  if (select status from proposals where day = sheet_today()) <> 'lapsed' then raise exception 'shutting down left the proposal pending'; end if;
  begin
    perform apply_proposal(sheet_today(), '[]', '[]', '[]', null);
    raise exception 'apply_proposal reopened a lapsed proposal';
  exception when raise_exception then
    if sqlerrm not like '%already lapsed%' then raise; end if;
  end;
  raise notice '✓ a shut-down day lapses its proposal and stays closed';
end $$;
update proposals set status = 'approved';

-- Someone else signed in can't write a proposal: RLS refuses the row.
select pg_temp.as_user('authenticated', 'stranger@example.com');
do $$ begin
  begin
    perform apply_proposal(sheet_today() + 1, '[]', '[]', '[]', null);
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
    or (select status from proposals where day = sheet_today()) <> 'approved'
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
  if to_regprocedure('apply_proposal(date, integer, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[])') is null then
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
  if to_regprocedure('apply_proposal(date, integer, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[])') is null then
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
echo "✓ all schema checks passed"

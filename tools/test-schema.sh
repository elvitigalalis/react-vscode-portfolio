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
SQL
echo "✓ all schema checks passed"

#!/usr/bin/env bash
#
# Runs supabase/schema.sql twice on a throwaway Postgres and checks how the v3 objects behave
# (docs/sheet-sources.md, "Schema"). Needs Docker; touches no live project.
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
  if exists (select 1 from pg_class where relname in ('feed_seen', 'feed_state', 'campus_events', 'mail_accounts')
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
SQL
echo "✓ all schema checks passed"

#!/usr/bin/env bash
#
# The Sheet v3's live check (docs/sheet-sources.md, "Quality bar"): reads the live project and
# prints one line per check, ✓ pass, ✗ fail, ! warning, · info. Exits 1 on any ✗.
#   bash tools/verify-sheet-v3.sh          after deploy: everything
#   bash tools/verify-sheet-v3.sh --pre    before deploy: the function secrets and the OAuth server
#
# Read-only: SQL goes through `supabase db query --read-only` (a read-only transaction) and HTTP
# calls are requests the functions refuse. It never prints a secret value, a Vault secret or the
# Brightspace feed URL: SQL selects only names, counts and statuses, and any text from the
# database is printed through tools/sheet-check.mjs, which keeps it to one line with URLs hidden.
#
# Run from the repo root, signed in with `npx supabase login` as the project's owner.
# SHEET_DB_TARGET overrides the database (any --remote value, e.g. a local Postgres URL) and
# SHEET_URL the project URL and SHEET_SITE the site, for trying the script against a throwaway
# database without reaching the live services.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:-post}"
[[ "$MODE" == post || "$MODE" == --pre ]] || { echo "usage: bash tools/verify-sheet-v3.sh [--pre]"; exit 2; }

URL="${SHEET_URL:-$(sed -nE 's/^ *supabaseUrl: "([^"]*)".*/\1/p' src/site.mjs)}"
KEY=$(sed -nE 's/^ *anonKey: "([^"]*)".*/\1/p' src/site.mjs)
REF="${URL#https://}"; REF="${REF%%.*}"
DB="${SHEET_DB_TARGET:-$REF}"
SITE="${SHEET_SITE:-https://www.lisul-elvi.com}"
SB=(npx -y supabase@latest)
FAILED=0

pass() { printf '✓ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1"; FAILED=$((FAILED + 1)); }
warn() { printf '! %s\n' "$1"; }

# db_checks "SQL": the SQL returns (name, status, detail) rows; each becomes a line.
db_checks() {
  local rc=0
  "${SB[@]}" db query --read-only -o json --remote="$DB" "$1" 2>/dev/null | node tools/sheet-check.mjs report || rc=$?
  (( rc )) && FAILED=$((FAILED + 1))
}

# status METHOD PATH [curl args…]: the HTTP status of a request to the project.
status() {
  local method="$1" path="$2"; shift 2
  curl -s -o /dev/null -m 30 -w '%{http_code}' -X "$method" "$URL$path" "$@"
}

# expect NAME GOT WANT…: pass when GOT is one of WANT.
expect() {
  local name="$1" got="$2"; shift 2
  local w; for w in "$@"; do [[ "$got" == "$w" ]] && { pass "$name ($got)"; return; }; done
  fail "$name: got $got, want $*"
}

# A random value to send as a wrong secret. Not a secret itself.
WRONG=$(openssl rand -hex 16)

echo "The Sheet v3, project $REF${SHEET_DB_TARGET:+ (database: override)}"

# --- OAuth server (pre and post) --------------------------------------------------------------
# Supabase Auth's OAuth 2.1 server publishes RFC 8414 metadata at
# /.well-known/oauth-authorization-server/auth/v1
# (supabase.com/docs/guides/auth/oauth-server/getting-started). Claude needs registration_endpoint
# for dynamic client registration.
meta=$(curl -s -m 30 "$URL/.well-known/oauth-authorization-server/auth/v1")
if printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.exit(JSON.parse(s).registration_endpoint?0:1)}catch{process.exit(1)}})'; then
  pass "OAuth server metadata has a registration_endpoint"
else
  fail "OAuth server metadata: missing or no registration_endpoint (turn on the OAuth server and dynamic registration in Auth settings)"
fi

if [[ "$MODE" == --pre ]]; then
  # --- Function secrets: names only ------------------------------------------------------------
  # `supabase secrets list` prints names with a digest of each value; only the names are read.
  if names=$("${SB[@]}" secrets list -o json --remote="$REF" 2>/dev/null | node tools/sheet-check.mjs secrets) && [[ -n "$names" ]]; then
    for s in SHEET_CRON_SECRET SHEET_BRIGHTSPACE_ICS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MAIL_STATE_SECRET; do
      if grep -qx "$s" <<<"$names"; then pass "function secret $s is set"; else fail "function secret $s is not set"; fi
    done
  else
    fail "couldn't list the function secrets (npx supabase login as the project's owner)"
  fi
  (( FAILED )) && { echo "Some checks failed (✗ above)."; exit 1; }
  echo "Ready to deploy."; exit 0
fi

# --- Tables, columns, RLS and grants ----------------------------------------------------------
# From the catalogs, which any role can read. "Owner policy" means an all-commands policy
# named owner_all whose condition is is_owner().
db_checks "
with want(tbl, cols) as (values
  ('tasks', array['source','source_uid']),
  ('settings', array['interests']),
  ('feed_seen', array['source','uid','seen_at']),
  ('feed_state', array['source','etag','last_modified','fetched_at','ok','error','items']),
  ('campus_events', array['uid','title','starts_at','ends_at','all_day','group_name','event_type','tags','description','url','location','updated_at']),
  ('mail_accounts', array['id','email','label','vault_secret_id','connected_at','last_used_at','last_error'])),
cols as (
  select w.tbl, array(select c from unnest(w.cols) c
    where not exists (select 1 from information_schema.columns i
      where i.table_schema = 'public' and i.table_name = w.tbl and i.column_name = c)) as missing
  from want w),
newt(tbl) as (values ('feed_seen'), ('feed_state'), ('campus_events'), ('mail_accounts'))
select 'columns of ' || tbl as name,
       case when cardinality(missing) = 0 then 'ok' else 'fail' end as status,
       case when cardinality(missing) = 0 then null else 'missing ' || array_to_string(missing, ', ') end as detail
from cols
union all
select 'tasks unique (source, source_uid)',
       case when exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'tasks'
         and indexdef ilike 'create unique index%(source, source_uid)%') then 'ok' else 'fail' end, null
union all
select 'RLS and owner policy on ' || n.tbl,
       case when c.oid is null then 'fail'
            when c.relrowsecurity and exists (select 1 from pg_policies p where p.schemaname = 'public'
              and p.tablename = n.tbl and p.policyname = 'owner_all' and p.cmd = 'ALL'
              and p.qual ilike '%is_owner()%') then 'ok' else 'fail' end,
       case when c.oid is null then 'no table' when not c.relrowsecurity then 'RLS off' end
from newt n left join pg_class c on c.relname = n.tbl and c.relnamespace = 'public'::regnamespace
union all
select 'anon has no access to ' || n.tbl,
       case when c.oid is not null and not has_table_privilege('anon', c.oid, 'select, insert, update, delete')
         then 'ok' else 'fail' end, null
from newt n left join pg_class c on c.relname = n.tbl and c.relnamespace = 'public'::regnamespace
union all
select 'vault is closed to ' || r,
       case when not has_schema_privilege(r, 'vault', 'usage')
              or not (has_table_privilege(r, 'vault.secrets', 'select')
                      or has_table_privilege(r, 'vault.decrypted_secrets', 'select')) then 'ok' else 'fail' end, null
from unnest(array['anon', 'authenticated']) r
union all
select 'only the service role may call ' || f,
       case when to_regprocedure(f) is null then 'fail'
            when has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
              then 'fail' else 'ok' end,
       case when to_regprocedure(f) is null then 'no function' end
from unnest(array['public.mail_refresh_token(text)', 'public.mail_account_save(text,text)']) f
union all
select 'mail_accounts delete trigger',
       case when exists (select 1 from pg_trigger where tgname = 'mail_accounts_forget' and not tgisinternal)
         then 'ok' else 'fail' end, null
union all
-- The public views' output columns must be exactly these: none of v3's.
select 'public view ' || v.view || ' columns',
       case when got = v.cols then 'ok' else 'fail' end,
       case when got is distinct from v.cols then 'has ' || coalesce(array_to_string(got, ', '), 'nothing') end
from (values ('public_week', array['bar','day','done','id','position','public','tag','title']),
             ('public_days', array['day','planned','shutdown']),
             ('public_now', array['public','tag','title','updated_on'])) v(view, cols)
cross join lateral (select array_agg(a.attname::text order by a.attname::text) as got from pg_attribute a
  where a.attrelid = to_regclass('public.' || v.view) and a.attnum > 0 and not a.attisdropped) g
"

# --- Cron jobs and their last runs ------------------------------------------------------------
# cron.job and cron.job_run_details (github.com/citusdata/pg_cron). A run "succeeded" once
# net.http_post queued the call; the function's own outcome is in feed_state below.
db_checks "
select 'cron ' || j.name || ' at ' || j.sched as name,
       case when c.jobid is null then 'fail' when c.active and c.schedule = j.sched then 'ok' else 'fail' end as status,
       case when c.jobid is null then 'not scheduled' when not c.active then 'inactive'
            when c.schedule <> j.sched then 'schedule is ' || c.schedule end as detail
from (values ('sheet-brightspace', '20 * * * *'), ('sheet-campus', '35 * * * *'),
             ('sheet-telegram', '* * * * *'), ('sheet-rollover', '5 * * * *')) j(name, sched)
left join cron.job c on c.jobname = j.name
union all
select 'cron ' || j.name || ' last run',
       case when r.status is null then 'warn' when r.status = 'succeeded' then 'ok' else 'fail' end,
       case when r.status is null then 'no runs in the last 2 hours yet'
            else r.status || ' at ' || to_char(r.start_time at time zone 'America/New_York', 'Mon DD HH24:MI') end
from (values ('sheet-brightspace'), ('sheet-campus')) j(name)
left join cron.job c on c.jobname = j.name
left join lateral (select d.status, d.start_time from cron.job_run_details d
  where d.jobid = c.jobid and d.start_time > now() - interval '2 hours'
  order by d.start_time desc limit 1) r on true
"

# --- Vault entries: existence only, never decrypted -------------------------------------------
db_checks "
select 'vault entry ' || n as name,
       case when exists (select 1 from vault.secrets s where s.name = n) then 'ok' else 'fail' end as status,
       null as detail
from unnest(array['sheet_cron_secret', 'sheet_brightspace_url', 'sheet_campus_url']) n
"

# --- The data the functions keep --------------------------------------------------------------
# feed_state.error never holds the feed URL (contract), and the report hides URLs anyway.
db_checks "
select 'feed_state ' || f.src as name,
       case when s.source is null then 'fail' when not coalesce(s.ok, false) then 'fail'
            when s.fetched_at < now() - interval '3 hours' then 'warn' else 'ok' end as status,
       case when s.source is null then 'no row yet: the job has not run'
            else coalesce(s.items::text, '?') || ' items, fetched '
                 || coalesce(to_char(s.fetched_at at time zone 'America/New_York', 'Mon DD HH24:MI'), 'never')
                 || case when not coalesce(s.ok, false) then ' · ' || coalesce(left(s.error, 120), 'not ok') else '' end end as detail
from (values ('brightspace'), ('campus')) f(src) left join feed_state s on s.source = f.src
union all
select 'campus_events', case when n > 0 and last_start < now() + interval '15 days' then 'ok' else 'fail' end,
       n || ' events' || case when n > 0 then ', last starts '
         || to_char(last_start at time zone 'America/New_York', 'Mon DD') else '' end
         || case when last_start >= now() + interval '15 days' then ' (past the 14-day window)' else '' end
from (select count(*) as n, max(starts_at) as last_start from campus_events) e
union all
select 'campus_events ended rows', case when n = 0 then 'ok' else 'warn' end,
       case when n > 0 then n || ' ended over 2 hours ago (the sync deletes them)' end
from (select count(*) as n from campus_events where ends_at < now() - interval '2 hours') e
union all
select 'course tasks', case when n = 0 then 'warn' when pub = 0 and nosrc = 0 then 'ok' else 'fail' end,
       n || ' from Brightspace' || case when pub > 0 then ', ' || pub || ' public' else '' end
         || case when nosrc > 0 then ', ' || nosrc || ' with a uid but no source' else '' end
from (select count(*) filter (where source = 'brightspace') as n,
             count(*) filter (where source = 'brightspace' and public) as pub,
             count(*) filter (where source_uid is not null and source is distinct from 'brightspace') as nosrc
      from tasks) t
union all
select 'mail_accounts', 'info', n || ' connected' || case when bad > 0 then ', ' || bad || ' with an error' else '' end
from (select count(*) as n, count(*) filter (where last_error is not null) as bad from mail_accounts) m
"

# --- What visitors can reach through the REST API, with the site's publishable key ------------
expect "anon can't read campus_events" "$(status GET '/rest/v1/campus_events?select=uid&limit=1' -H "apikey: $KEY")" 401 403 404
expect "anon can't read mail_accounts" "$(status GET '/rest/v1/mail_accounts?select=email&limit=1' -H "apikey: $KEY")" 401 403 404
expect "anon can't ask for public_week.source" "$(status GET '/rest/v1/public_week?select=source&limit=1' -H "apikey: $KEY")" 400
expect "public_week answers" "$(status GET '/rest/v1/public_week?select=id&limit=1' -H "apikey: $KEY")" 200

# --- The functions: deployed, and refusing a caller without the secret ------------------------
for f in brightspace campus; do
  expect "$f refuses a call with no cron secret" "$(status POST "/functions/v1/$f")" 403
  expect "$f refuses a wrong cron secret" "$(status POST "/functions/v1/$f" -H "x-sheet-cron: $WRONG")" 403
done

# mail-connect answers every outcome with a redirect to /plan carrying a fixed reason word.
loc=$(curl -s -o /dev/null -m 30 -w '%{http_code} %{redirect_url}' "$URL/functions/v1/mail-connect/start?access_token=$WRONG")
case "$loc" in
  *reason=not-owner*) pass "mail-connect refuses a wrong access token" ;;
  *reason=not-set-up*) fail "mail-connect: its Google client or state secret is not set" ;;
  *) fail "mail-connect: got ${loc%% *}, want a redirect to /plan with reason=not-owner" ;;
esac

# mail-mcp: RFC 9728 metadata at {resource}/oauth-protected-resource (@supabase/server
# withOAuthProtectedResource), and a 401 pointing at it for an initialize without a valid token
# (modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
prm=$(curl -s -m 30 "$URL/functions/v1/mail-mcp/oauth-protected-resource")
if AUTH="$URL/auth/v1" node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.resource&&(j.authorization_servers||[]).includes(process.env.AUTH)?0:1)}catch{process.exit(1)}})' <<<"$prm"; then
  pass "mail-mcp serves its protected-resource metadata"
else
  fail "mail-mcp: no protected-resource metadata naming $URL/auth/v1"
fi
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify-sheet-v3","version":"1"}}}'
mcp() { curl -s -o /dev/null -m 30 -D - -X POST "$URL/functions/v1/mail-mcp" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' "$@" --data "$INIT" | tr -d '\r'; }
for case_ in none wrong; do
  if [[ $case_ == none ]]; then head=$(mcp); else head=$(mcp -H "Authorization: Bearer $WRONG"); fi
  code=$(awk 'NR==1{print $2}' <<<"$head")
  if [[ "$code" == 401 ]] && grep -qi '^www-authenticate:.*resource_metadata=' <<<"$head"; then
    pass "mail-mcp refuses initialize with $case_ token (401, points at the metadata)"
  else
    fail "mail-mcp initialize with $case_ token: got ${code:-no answer}, want 401 with resource_metadata"
  fi
done

# --- The consent page on the site -------------------------------------------------------------
consent=$(curl -s -o /dev/null -m 30 -w '%{http_code}' "$SITE/oauth/consent/")
if [[ "$consent" == 200 ]]; then pass "consent page $SITE/oauth/consent/ (200)"
else warn "consent page answered $consent: fine until the site with it is deployed"; fi

if (( FAILED )); then echo "Some checks failed (✗ above)."; exit 1; fi
echo "All checks passed."

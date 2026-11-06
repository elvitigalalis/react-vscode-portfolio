#!/usr/bin/env bash
#
# The Sheet v5's live check (docs/sheet-v5.md, "Quality bar"): reads the live project and prints
# one line per check, ✓ pass, ✗ fail, ! warning, · info. Exits 1 on any ✗.
#   bash tools/verify-sheet-v5.sh          after deploy
#
# Read-only, as verify-sheet-v4.sh: SQL goes through `supabase db query --read-only`, function
# secrets are read as names only, and HTTP calls are requests the functions refuse before they
# do anything (no or a wrong secret, no session, no state). SQL selects only names, counts,
# statuses and times, never mail senders, subjects, titles or notes, and every line from the
# database goes through tools/sheet-check.mjs. A source that isn't connected yet (no token, no
# Vault URL, no calendar grant) is a ! warning, not a failure. The morning task lives in
# claude.ai, not in this project: check it with `RemoteTrigger get` (the reminder at the end).
#
# Run from the repo root, signed in with `npx supabase login` as the project's owner.
# SHEET_DB_TARGET overrides the database and SHEET_URL the project URL, as in verify-sheet-v4.sh.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[[ $# -eq 0 ]] || { echo "usage: bash tools/verify-sheet-v5.sh"; exit 2; }

URL="${SHEET_URL:-$(sed -nE 's/^ *supabaseUrl: "([^"]*)".*/\1/p' src/site.mjs)}"
KEY=$(sed -nE 's/^ *anonKey: "([^"]*)".*/\1/p' src/site.mjs)
REF="${URL#https://}"; REF="${REF%%.*}"
DB="${SHEET_DB_TARGET:-$REF}"
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

# expect NAME GOT WANT…: pass when GOT is one of WANT.
expect() {
  local name="$1" got="$2"; shift 2
  local w; for w in "$@"; do [[ "$got" == "$w" ]] && { pass "$name ($got)"; return; }; done
  fail "$name: got $got, want $*"
}

# A random value to send as a wrong secret or token. Not a secret itself.
WRONG=$(openssl rand -hex 16)

echo "The Sheet v5, project $REF${SHEET_DB_TARGET:+ (database: override)}"

# --- Function secrets: names only -------------------------------------------------------------
# `supabase secrets list` prints names with a digest of each value; only the names are read.
# The source tokens are optional: a missing one means that source isn't connected yet.
if names=$("${SB[@]}" secrets list -o json --remote="$REF" 2>/dev/null | node tools/sheet-check.mjs secrets) && [[ -n "$names" ]]; then
  for s in SHEET_CRON_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET MAIL_STATE_SECRET TELEGRAM_BOT_TOKEN \
           TELEGRAM_WEBHOOK_SECRET SHEET_ROUTINE_ID SHEET_ROUTINE_TOKEN; do
    if grep -qx "$s" <<<"$names"; then pass "function secret $s is set"; else fail "function secret $s is not set"; fi
  done
  for s in SHEET_SENDER_SALT SHEET_GITHUB_TOKEN SHEET_JIRA_TOKEN SHEET_JIRA_EMAIL SHEET_JIRA_SITE \
           SHEET_SLACK_TOKEN SHEET_HANDSHAKE_ICS SHEET_ACADEMIC_ICS; do
    if grep -qx "$s" <<<"$names"; then pass "function secret $s is set"; else warn "function secret $s is not set: that source isn't connected yet"; fi
  done
else
  fail "couldn't list the function secrets (npx supabase login as the project's owner)"
fi

# --- Tables, columns, keys, RLS and grants ----------------------------------------------------
# From the catalogs. An owner-only table has RLS on and an all-commands policy on is_owner().
# Tables only a server function writes give the browser's role no insert, update or delete
# (has_table_privilege ignores the column grant on changes' consumed_day and consumed_rev).
db_checks "
with want(tbl, cols) as (values
  ('proposals', array['rev','run_trigger','reasons','couldnt_fit','suggested','blocks']),
  ('days', array['turned_down']),
  ('blocks', array['habit_id']),
  ('busy', array['source']),
  ('tasks', array['link']),
  ('needs_you', array['source','not_needed','sender_hash']),
  ('mail_accounts', array['history_id']),
  ('settings', array['replans_on','workload_cap_min','enrollment_at','weather_point','github_orgs','plan_edited_at']),
  ('calendar_account', array['id','email','vault_secret_id','connected_at','last_error']),
  ('changes', array['id','at','kind','reason','weight','ref','replan_id','consumed_day','consumed_rev']),
  ('replans', array['id','at','day','reasons','counts','result','retry_after','session_id','error']),
  ('actuals', array['id','at','day','task_id','block_id','kind','est_min','minutes']),
  ('habits', array['id','name','days','ideal','minutes','flex_min','defence','position','created_at']),
  ('feedback', array['id','at','item','action','ref']),
  ('triage_rules', array['id','match','pattern','action','created_at','label']),
  ('known_senders', array['hash','last_sent_at']),
  ('message_senders', array['account','message_id','thread_id','address_hash','domain_hashes','at']),
  ('reply_state', array['account','thread_id','state','since','message_id','who','updated_at','basis','draft']),
  ('academic_days', array['day','entries','fetched_at']),
  ('weather_cache', array['id','point','forecast_url','periods','alerts','fetched_at'])),
cols as (
  select w.tbl, array(select c from unnest(w.cols) c
    where not exists (select 1 from information_schema.columns i
      where i.table_schema = 'public' and i.table_name = w.tbl and i.column_name = c)) as missing
  from want w),
newt(tbl, server_only) as (values
  ('calendar_account', false), ('changes', true), ('replans', true), ('actuals', true),
  ('habits', false), ('feedback', false), ('triage_rules', false), ('known_senders', true),
  ('message_senders', true), ('reply_state', true), ('academic_days', true), ('weather_cache', true)),
pkeys(tbl, def) as (values ('proposals', 'PRIMARY KEY (day, rev)'), ('busy', 'PRIMARY KEY (source, starts_at, ends_at)'))
select 'columns of ' || tbl as name,
       case when cardinality(missing) = 0 then 'ok' else 'fail' end as status,
       case when cardinality(missing) = 0 then null else 'missing ' || array_to_string(missing, ', ') end as detail
from cols
union all
select tbl || ' key',
       case when exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.' || tbl)
         and c.contype = 'p' and pg_get_constraintdef(c.oid) = def) then 'ok' else 'fail' end,
       case when not exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.' || tbl)
         and c.contype = 'p' and pg_get_constraintdef(c.oid) = def) then 'want ' || def end
from pkeys
union all
select 'RLS and owner policy on ' || n.tbl,
       case when c.oid is null then 'fail'
            when c.relrowsecurity and exists (select 1 from pg_policies p where p.schemaname = 'public'
              and p.tablename = n.tbl and p.cmd = 'ALL' and p.qual ilike '%is_owner()%') then 'ok' else 'fail' end,
       case when c.oid is null then 'no table' when not c.relrowsecurity then 'RLS off' end
from newt n left join pg_class c on c.relname = n.tbl and c.relnamespace = 'public'::regnamespace
union all
select 'anon has no access to ' || n.tbl,
       case when c.oid is not null and not has_table_privilege('anon', c.oid, 'select, insert, update, delete')
         then 'ok' else 'fail' end, null
from newt n left join pg_class c on c.relname = n.tbl and c.relnamespace = 'public'::regnamespace
union all
select 'only the server writes ' || n.tbl,
       case when c.oid is not null and not has_table_privilege('authenticated', c.oid, 'insert, update, delete')
         then 'ok' else 'fail' end, null
from newt n left join pg_class c on c.relname = n.tbl and c.relnamespace = 'public'::regnamespace
where n.server_only
union all
select 'the browser may only read and delete calendar_account',
       case when not has_table_privilege('authenticated', to_regclass('public.calendar_account'), 'insert, update')
         then 'ok' else 'fail' end, null
union all
select 'feedback is append-only',
       case when not has_table_privilege('authenticated', to_regclass('public.feedback'), 'update, delete')
         then 'ok' else 'fail' end, null
union all
select 'nudges kind allows finished and replan',
       case when exists (select 1 from pg_constraint where conrelid = 'public.nudges'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%''finished''%' and pg_get_constraintdef(oid) ilike '%''replan''%')
         then 'ok' else 'fail' end, null
union all
select 'proposals status allows superseded',
       case when exists (select 1 from pg_constraint where conrelid = 'public.proposals'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%''superseded''%') then 'ok' else 'fail' end, null
union all
select 'calendar_account_forget trigger',
       case when exists (select 1 from pg_trigger where tgname = 'calendar_account_forget'
         and tgrelid = to_regclass('public.calendar_account')) then 'ok' else 'fail' end, null
union all
-- The public views' output columns must be exactly these: no v5 table or column reaches /now.
select 'public view ' || v.view || ' columns',
       case when got = v.cols then 'ok' else 'fail' end,
       case when got is distinct from v.cols then 'has ' || coalesce(array_to_string(got, ', '), 'nothing') end
from (values ('public_week', array['bar','day','done','id','position','public','tag','title']),
             ('public_days', array['day','planned','shutdown']),
             ('public_now', array['public','tag','title','updated_on'])) v(view, cols)
cross join lateral (select array_agg(a.attname::text order by a.attname::text) as got from pg_attribute a
  where a.attrelid = to_regclass('public.' || v.view) and a.attnum > 0 and not a.attisdropped) g
"

# --- Functions: signature, security and who may call them -------------------------------------
# Revisions run as their caller (security invoker), so RLS applies to planner-mcp, /plan and
# Telegram. The Vault ones are security definer and, like the sync writes, service key only.
db_checks "
with want(sig, definer, owner_may) as (values
  ('apply_proposal(date,integer,jsonb,jsonb,jsonb,jsonb,text,uuid[],jsonb,text,text[],timestamp with time zone,text)', false, true),
  ('approve_proposal(date,integer)', false, true),
  ('skip_proposal(date,integer)', false, true),
  ('turn_down(date,uuid)', false, true),
  ('busy_sync_save(timestamptz,timestamptz,jsonb,jsonb)', false, false),
  ('handshake_sync_save(timestamptz,timestamptz,jsonb)', false, false),
  ('calendar_account_save(text,text)', true, false),
  ('calendar_refresh_token()', true, false),
  ('calendar_account_forget()', true, false)),
f as (select w.*, to_regprocedure('public.' || w.sig) as oid from want w)
select f.sig as name,
       case when f.oid is null then 'fail'
            when p.prosecdef <> f.definer then 'fail'
            when has_function_privilege('anon', f.oid, 'execute') then 'fail'
            when has_function_privilege('authenticated', f.oid, 'execute') <> f.owner_may then 'fail'
            else 'ok' end as status,
       case when f.oid is null then 'no function'
            when p.prosecdef <> f.definer then case when p.prosecdef then 'is security definer' else 'is security invoker' end
            when has_function_privilege('anon', f.oid, 'execute') then 'anon may call it'
            when has_function_privilege('authenticated', f.oid, 'execute') <> f.owner_may then
              case when f.owner_may then 'the owner may not call it' else 'the browser may call it' end end as detail
from f left join pg_proc p on p.oid = f.oid
union all
select 'v4 apply_proposal(date,jsonb,jsonb,jsonb,text) is gone',
       case when to_regprocedure('public.apply_proposal(date,jsonb,jsonb,jsonb,text)') is null then 'ok' else 'fail' end, null
"

# --- Cron jobs and their Vault URLs: existence only, never decrypted --------------------------
# A job does nothing until its URL is in Vault, which is how a source waits to be connected.
db_checks "
with jobs(i, name, schedule, vault, mins) as (values
  (1, 'sheet-busy', '*/10 * * * *', 'sheet_busy_url', 10),
  (2, 'sheet-mail', '2-59/5 * * * *', 'sheet_mail_url', 5),
  (3, 'sheet-work', '40 * * * *', 'sheet_work_url', 60),
  (4, 'sheet-slack', '42 * * * *', 'sheet_slack_url', 60),
  (5, 'sheet-ical', '25 * * * *', 'sheet_ical_url', 60),
  (6, 'sheet-weather', '50 * * * *', 'sheet_weather_url', 60))
(select 'cron job ' || j.name as name,
       case when c.jobid is null or c.schedule <> j.schedule or not c.active then 'fail'
            when not exists (select 1 from vault.secrets s where s.name = j.vault) then 'warn'
            when r.status is null then 'warn'
            when r.status <> 'succeeded' then 'fail' else 'ok' end as status,
       case when c.jobid is null then 'not scheduled'
            when c.schedule <> j.schedule then 'runs ' || c.schedule || ', want ' || j.schedule
            when not c.active then 'inactive'
            when not exists (select 1 from vault.secrets s where s.name = j.vault) then j.vault || ' is not in Vault yet: the job does nothing'
            when r.status is null then 'no run in the last ' || (2 * j.mins + 5) || ' min'
            else 'last run ' || r.status || ' at ' || to_char(r.start_time at time zone 'America/New_York', 'Mon DD HH24:MI') end as detail
from jobs j
left join cron.job c on c.jobname = j.name
left join lateral (select d.status, d.start_time from cron.job_run_details d
  where d.jobid = c.jobid and d.start_time > now() - make_interval(mins => 2 * j.mins + 5)
  order by d.start_time desc limit 1) r on true
order by j.i)
union all
select 'vault entry sheet_cron_secret',
       case when exists (select 1 from vault.secrets where name = 'sheet_cron_secret') then 'ok' else 'fail' end, null
union all
select 'vault calendar token',
       case when n > 0 then 'ok' else 'warn' end,
       case when n > 0 then n || ' calendar_refresh secret(s)' else 'none: the calendar is not connected yet' end
from (select count(*) as n from vault.secrets where name like 'calendar\_refresh:%') v
"

# --- Each connected source synced within its interval -----------------------------------------
# feed_state, one row per source. ok null with error 'not connected' is a source with no token;
# no row is a job that hasn't run (often its Vault URL isn't there yet). A connected source must
# have synced within its interval, plus 5 minutes for the job and the fetch.
db_checks "
with src(i, source, mins) as (values (1, 'freebusy', 10), (2, 'gmail', 5), (3, 'github', 60), (4, 'jira', 60),
                                     (5, 'slack', 60), (6, 'handshake', 60), (7, 'academic', 60), (8, 'weather', 60))
select 'feed ' || f.source as name,
       case when s.source is null or s.ok is null then 'warn'
            when not s.ok then 'fail'
            when s.fetched_at is null or s.fetched_at < now() - make_interval(mins => f.mins + 5) then 'fail'
            else 'ok' end as status,
       case when s.source is null then 'no sync yet: not connected, or the job has not run'
            when s.ok is null then coalesce(left(s.error, 120), 'not connected')
            when not s.ok then coalesce(left(s.error, 120), 'not ok')
            when s.fetched_at is null then 'never fetched'
            else 'synced ' || floor(extract(epoch from now() - s.fetched_at) / 60)::int || ' min ago'
                 || case when s.fetched_at < now() - make_interval(mins => f.mins + 5)
                         then ', want within ' || f.mins || ' min' else '' end
                 || coalesce(', ' || s.items || ' items', '') end as detail
from src f left join feed_state s on s.source = f.source
order by f.i
"

# --- The live check the telegram tick also runs (schema.sql, sheet_checks()) ----------------------
db_checks "select name, status, detail from sheet_checks()"

# --- The data v5 keeps ------------------------------------------------------------------------
# busy-sync stamps busy_as_of every 10 minutes once the calendar is connected. A day holds at
# most 8 plans: its morning revision plus each replan. A replans row has no result only while
# its request is in flight.
db_checks "
with s as (select time_zone, busy_as_of, replans_on, (now() at time zone time_zone)::date as today from settings limit 1),
cal as (select count(*) as n, count(*) filter (where last_error is not null) as erred from calendar_account)
select 'busy_as_of under 15 minutes old' as name,
       case when cal.n = 0 then 'warn' when s.busy_as_of is null then 'fail'
            when s.busy_as_of < now() - interval '15 minutes' then 'fail' else 'ok' end as status,
       case when cal.n = 0 then 'the calendar is not connected yet'
              || coalesce(' (last browser save ' || floor(extract(epoch from now() - s.busy_as_of) / 60)::int || ' min ago)', '')
            when s.busy_as_of is null then 'never set'
            else 'saved ' || floor(extract(epoch from now() - s.busy_as_of) / 60)::int || ' min ago' end as detail
from s cross join cal
union all
select 'calendar grant', case when cal.n = 0 then 'warn' when cal.erred > 0 then 'fail' else 'ok' end,
       case when cal.n = 0 then 'not connected: /plan → Settings → Calendar → Connect'
            when cal.erred > 0 then 'last_error is set: reconnect in Settings' else 'connected' end
from cal
union all
select 'plans today (at most 8)', case when n > 8 then 'fail' else 'ok' end,
       n || ' (' || morning || ' morning, ' || replans || ' replans), newest revision '
         || coalesce(newest::text, 'none')
from (select m.morning, r.replans, m.morning + r.replans as n, m.newest
      from (select case when bool_or(p.run_trigger = 'morning') then 1 else 0 end as morning, max(p.rev) as newest
            from s left join proposals p on p.day = s.today) m,
           (select count(r.id) as replans from s left join replans r on r.day = s.today) r) x
union all
select 'every replans row has a result', case when stuck > 0 then 'fail' else 'ok' end,
       coalesce(nullif(concat_ws(', ',
         case when started > 0 then started || ' started' end,
         case when failed > 0 then failed || ' failed' end,
         case when limited > 0 then limited || ' rate limited' end,
         case when sending > 0 then sending || ' sending' end,
         case when stuck > 0 then stuck || ' with no result after 5 min' end), ''), 'none yet')
from (select count(*) filter (where result = 'started') as started,
             count(*) filter (where result = 'failed') as failed,
             count(*) filter (where result = 'rate_limited') as limited,
             count(*) filter (where result is null and at >= now() - interval '5 minutes') as sending,
             count(*) filter (where result is null and at < now() - interval '5 minutes') as stuck from replans) r
union all
select 'replans', case when s.replans_on then 'info' else 'warn' end,
       case when s.replans_on then 'on' else 'off: turn on in Settings after the routine probe' end
         || coalesce(', rate limited until ' || to_char(ra at time zone s.time_zone, 'Mon DD HH24:MI'), '')
from s cross join (select max(retry_after) filter (where retry_after > now()) as ra from replans) r
union all
select 'changes', 'info', n || ' kept, ' || open || ' not yet read by a revision'
from (select count(*) as n, count(*) filter (where consumed_rev is null) as open from changes) c
union all
select 'revisions today', 'info', coalesce(string_agg(status || ' ' || n, ', ' order by status), 'none yet')
from (select p.status, count(*) as n from s join proposals p on p.day = s.today group by p.status) p
union all
select 'reply_state', 'info', owed || ' reply owed, ' || awaiting || ' awaiting reply'
from (select count(*) filter (where state = 'owed') as owed, count(*) filter (where state = 'awaiting') as awaiting from reply_state) r
union all
select 'kept rows', 'info',
       (select count(*) from actuals) || ' actuals, ' || (select count(*) from feedback) || ' feedback, '
         || (select count(*) from known_senders) || ' known sender hashes, '
         || (select count(*) from message_senders) || ' message senders, '
         || (select count(*) from habits) || ' habits, ' || (select count(*) from triage_rules) || ' triage rules'
union all
-- nightly_roll keeps 14 days of these and 120 of actuals and feedback; a day over means it stopped.
select 'retention', case when old > 0 then 'warn' else 'ok' end,
       case when old > 0 then old || ' rows past their keep time (is sheet-rollover running?)' else 'nothing past its keep time' end
from (select (select count(*) from changes where at < now() - interval '15 days')
           + (select count(*) from replans where at < now() - interval '15 days')
           + (select count(*) from reply_state where since < now() - interval '15 days')
           + (select count(*) from message_senders where at < now() - interval '15 days')
           + (select count(*) from actuals where at < now() - interval '121 days')
           + (select count(*) from feedback where at < now() - interval '121 days') as old) o
"

# --- What visitors can reach through the REST API, with the site's publishable key ------------
for t in calendar_account changes replans actuals habits feedback triage_rules known_senders \
         message_senders reply_state academic_days weather_cache; do
  expect "anon can't read $t" "$(curl -s -o /dev/null -m 30 -w '%{http_code}' "$URL/rest/v1/$t?limit=1" -H "apikey: $KEY")" 401 403 404
done

# --- The sync functions refuse a call without the cron secret ---------------------------------
# Each checks x-sheet-cron before anything else and answers 403.
for f in busy-sync mail-sync work-sync slack-sync ical-sync weather; do
  expect "$f refuses no secret" "$(curl -s -o /dev/null -m 30 -w '%{http_code}' -X POST "$URL/functions/v1/$f")" 403
  expect "$f refuses a wrong secret" "$(curl -s -o /dev/null -m 30 -w '%{http_code}' -X POST "$URL/functions/v1/$f" -H "x-sheet-cron: $WRONG")" 403
done

# --- calendar-connect: /start wants the owner's session, /callback a signed state -------------
# /start with no session answers 403 (503 means its Google or state secrets are missing).
# /callback with no state sends him back to /plan with reason=expired, using up nothing.
expect "calendar-connect /start refuses no session" \
  "$(curl -s -o /dev/null -m 30 -w '%{http_code}' -X POST "$URL/functions/v1/calendar-connect/start" -H 'Origin: https://www.lisul-elvi.com')" 403
cb=$(curl -s -o /dev/null -m 30 -w '%{http_code} %{redirect_url}' "$URL/functions/v1/calendar-connect/callback")
if [[ "$cb" == "302 "*"/plan/?calendar=error&reason=expired" ]]; then
  pass "calendar-connect /callback refuses no state (back to /plan, expired)"
else
  fail "calendar-connect /callback with no state: got ${cb:-no answer}, want 302 to /plan/?calendar=error&reason=expired"
fi

# --- planner-mcp and mail-mcp: metadata, and a 401 without a valid token ----------------------
# RFC 9728 metadata at {resource}/oauth-protected-resource, and a 401 pointing at it for an
# initialize without a valid token
# (modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify-sheet-v5","version":"1"}}}'
mcp() { local fn="$1"; shift; curl -s -o /dev/null -m 30 -D - -X POST "$URL/functions/v1/$fn" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' "$@" --data "$INIT" | tr -d '\r'; }
for fn in planner-mcp mail-mcp; do
  prm=$(curl -s -m 30 "$URL/functions/v1/$fn/oauth-protected-resource")
  if AUTH="$URL/auth/v1" node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.resource&&(j.authorization_servers||[]).includes(process.env.AUTH)?0:1)}catch{process.exit(1)}})' <<<"$prm"; then
    pass "$fn serves its protected-resource metadata"
  else
    fail "$fn: no protected-resource metadata naming $URL/auth/v1"
  fi
  for case_ in none wrong; do
    if [[ $case_ == none ]]; then head=$(mcp "$fn"); else head=$(mcp "$fn" -H "Authorization: Bearer $WRONG"); fi
    code=$(awk 'NR==1{print $2}' <<<"$head")
    if [[ "$code" == 401 ]] && grep -qi '^www-authenticate:.*resource_metadata=' <<<"$head"; then
      pass "$fn refuses initialize with $case_ token (401, points at the metadata)"
    else
      fail "$fn initialize with $case_ token: got ${code:-no answer}, want 401 with resource_metadata"
    fi
  done
done

# --- The morning task: outside this project ---------------------------------------------------
echo "· Not checked here: the morning task. In Claude Code, run RemoteTrigger get on it and check"
echo "  it is enabled, runs daily at 6:07 am America/New_York, still has its API trigger (replans),"
echo "  and has only its two connectors, The Sheet mail and The Sheet planner."

if (( FAILED )); then echo "Some checks failed (✗ above)."; exit 1; fi
echo "All checks passed."

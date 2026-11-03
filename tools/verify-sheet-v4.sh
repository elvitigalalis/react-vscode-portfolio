#!/usr/bin/env bash
#
# The Sheet v4's live check (docs/sheet-morning.md, "Quality bar"): reads the live project and
# prints one line per check, ✓ pass, ✗ fail, ! warning, · info. Exits 1 on any ✗.
#   bash tools/verify-sheet-v4.sh          after deploy
#
# Read-only, as verify-sheet-v3.sh: SQL goes through `supabase db query --read-only` and HTTP
# calls are requests planner-mcp refuses. SQL selects only names, counts, statuses and times,
# never mail senders, subjects or notes, and every line from the database goes through
# tools/sheet-check.mjs. The morning task itself lives in claude.ai, not in this project: check
# it with `RemoteTrigger get` (the reminder at the end).
#
# Run from the repo root, signed in with `npx supabase login` as the project's owner.
# SHEET_DB_TARGET overrides the database and SHEET_URL the project URL, as in verify-sheet-v3.sh.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

[[ $# -eq 0 ]] || { echo "usage: bash tools/verify-sheet-v4.sh"; exit 2; }

URL="${SHEET_URL:-$(sed -nE 's/^ *supabaseUrl: "([^"]*)".*/\1/p' src/site.mjs)}"
KEY=$(sed -nE 's/^ *anonKey: "([^"]*)".*/\1/p' src/site.mjs)
REF="${URL#https://}"; REF="${REF%%.*}"
DB="${SHEET_DB_TARGET:-$REF}"
SB=(npx -y supabase@latest)
FAILED=0

pass() { printf '✓ %s\n' "$1"; }
fail() { printf '✗ %s\n' "$1"; FAILED=$((FAILED + 1)); }

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

# A random value to send as a wrong token. Not a secret itself.
WRONG=$(openssl rand -hex 16)

echo "The Sheet v4, project $REF${SHEET_DB_TARGET:+ (database: override)}"

# --- Tables, columns, RLS and functions -------------------------------------------------------
# From the catalogs. An owner-only table has RLS on and an all-commands policy on is_owner().
db_checks "
with want(tbl, cols) as (values
  ('proposals', array['day','created_at','status','note','picks']),
  ('needs_you', array['id','day','account','message_id','link','sender','subject','why','kind','due','done','created_at']),
  ('busy', array['starts_at','ends_at']),
  ('settings', array['busy_as_of','morning_on'])),
cols as (
  select w.tbl, array(select c from unnest(w.cols) c
    where not exists (select 1 from information_schema.columns i
      where i.table_schema = 'public' and i.table_name = w.tbl and i.column_name = c)) as missing
  from want w),
newt(tbl) as (values ('proposals'), ('needs_you'), ('busy'))
select 'columns of ' || tbl as name,
       case when cardinality(missing) = 0 then 'ok' else 'fail' end as status,
       case when cardinality(missing) = 0 then null else 'missing ' || array_to_string(missing, ', ') end as detail
from cols
union all
select 'needs_you unique (account, message_id)',
       case when exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'needs_you'
         and indexdef ilike 'create unique index%(account, message_id)%') then 'ok' else 'fail' end, null
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
-- apply_proposal must run as its caller (security invoker), so RLS applies to planner-mcp.
select 'apply_proposal is security invoker',
       case when p.oid is null then 'fail' when p.prosecdef then 'fail' else 'ok' end,
       case when p.oid is null then 'no function' when p.prosecdef then 'it is security definer' end
from (select to_regprocedure('public.apply_proposal(date,jsonb,jsonb,jsonb,text)') as f) x
left join pg_proc p on p.oid = x.f
union all
select 'nudges kind allows proposal',
       case when exists (select 1 from pg_constraint where conrelid = 'public.nudges'::regclass and contype = 'c'
         and pg_get_constraintdef(oid) ilike '%kind%''proposal''%') then 'ok' else 'fail' end, null
union all
-- The public views' output columns must be exactly these: nothing from v4's tables.
select 'public view ' || v.view || ' columns',
       case when got = v.cols then 'ok' else 'fail' end,
       case when got is distinct from v.cols then 'has ' || coalesce(array_to_string(got, ', '), 'nothing') end
from (values ('public_week', array['bar','day','done','id','position','public','tag','title']),
             ('public_days', array['day','planned','shutdown']),
             ('public_now', array['public','tag','title','updated_on'])) v(view, cols)
cross join lateral (select array_agg(a.attname::text order by a.attname::text) as got from pg_attribute a
  where a.attrelid = to_regclass('public.' || v.view) and a.attnum > 0 and not a.attisdropped) g
"

# --- The data the morning plan keeps ----------------------------------------------------------
# busy_as_of is set each time /plan opens with Google connected; a day without it means the
# morning run planned around stale busy times. Today's proposals row appears after 6:07 am.
db_checks "
with s as (select time_zone, busy_as_of, morning_on, (now() at time zone time_zone)::date as today,
                  (now() at time zone time_zone)::time as now_local from settings limit 1)
select 'busy_as_of' as name,
       case when busy_as_of is null then 'fail' when busy_as_of < now() - interval '24 hours' then 'warn'
            else 'ok' end as status,
       case when busy_as_of is null then 'never set: open /plan with Google connected'
            else 'saved ' || to_char(busy_as_of at time zone time_zone, 'Mon DD HH24:MI')
                 || case when busy_as_of < now() - interval '24 hours' then ' (over a day ago)' else '' end end as detail
from s
union all
select 'busy rows', 'info', n || ' saved, ' || ended || ' ended (the nightly roll deletes them)'
from (select count(*) as n, count(*) filter (where ends_at < now()) as ended from busy) b
union all
select 'settings.morning_on', case when morning_on then 'ok' else 'warn' end,
       case when morning_on then 'on' else 'off: set it once the morning task is created' end
from s
union all
select 'today''s proposal',
       case when p.day is not null then 'ok' when s.now_local < time '06:30' then 'info' else 'warn' end,
       case when p.day is not null then p.status || ', created '
              || to_char(p.created_at at time zone s.time_zone, 'Mon DD HH24:MI')
            when s.now_local < time '06:30' then 'none yet: the task runs at 6:07 am'
            else 'none for ' || s.today || ': the morning task has not submitted (fine before its first run)' end
from s left join proposals p on p.day = s.today
union all
select 'proposals', 'info', coalesce(string_agg(status || ' ' || n, ', ' order by status), 'none yet')
from (select status, count(*) as n from proposals group by status) p
union all
select 'needs_you', case when old > 0 then 'warn' else 'info' end,
       opened || ' open, ' || n || ' in all'
         || case when old > 0 then ', ' || old || ' over 14 days old or done (the nightly roll deletes them)' else '' end
from (select count(*) as n, count(*) filter (where not done) as opened,
             count(*) filter (where done or created_at < now() - interval '15 days') as old from needs_you) m
"

# --- What visitors can reach through the REST API, with the site's publishable key ------------
for t in proposals needs_you busy; do
  expect "anon can't read $t" "$(curl -s -o /dev/null -m 30 -w '%{http_code}' "$URL/rest/v1/$t?limit=1" -H "apikey: $KEY")" 401 403 404
done

# --- planner-mcp: metadata, and a 401 without a valid token -----------------------------------
# As mail-mcp: RFC 9728 metadata at {resource}/oauth-protected-resource, and a 401 pointing at it
# for an initialize without a valid token
# (modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
prm=$(curl -s -m 30 "$URL/functions/v1/planner-mcp/oauth-protected-resource")
if AUTH="$URL/auth/v1" node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.exit(j.resource&&(j.authorization_servers||[]).includes(process.env.AUTH)?0:1)}catch{process.exit(1)}})' <<<"$prm"; then
  pass "planner-mcp serves its protected-resource metadata"
else
  fail "planner-mcp: no protected-resource metadata naming $URL/auth/v1"
fi
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"verify-sheet-v4","version":"1"}}}'
mcp() { curl -s -o /dev/null -m 30 -D - -X POST "$URL/functions/v1/planner-mcp" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' "$@" --data "$INIT" | tr -d '\r'; }
for case_ in none wrong; do
  if [[ $case_ == none ]]; then head=$(mcp); else head=$(mcp -H "Authorization: Bearer $WRONG"); fi
  code=$(awk 'NR==1{print $2}' <<<"$head")
  if [[ "$code" == 401 ]] && grep -qi '^www-authenticate:.*resource_metadata=' <<<"$head"; then
    pass "planner-mcp refuses initialize with $case_ token (401, points at the metadata)"
  else
    fail "planner-mcp initialize with $case_ token: got ${code:-no answer}, want 401 with resource_metadata"
  fi
done

# --- The morning task: outside this project ---------------------------------------------------
echo "· Not checked here: the morning task. In Claude Code, run RemoteTrigger get on it and check"
echo "  it is enabled, runs daily at 6:07 am America/New_York, and has only The Sheet mail and"
echo "  The Sheet planner connectors."

if (( FAILED )); then echo "Some checks failed (✗ above)."; exit 1; fi
echo "All checks passed."

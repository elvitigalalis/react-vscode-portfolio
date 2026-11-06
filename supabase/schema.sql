-- The Sheet's database (docs/sheet.md). Run once in the Supabase SQL editor, after setting the
-- owner's email in the insert at the bottom. Re-running is safe.
--
-- Only the owner can touch the tables (row-level security). Visitors read three views that
-- never return a private task's title.

create table if not exists settings (
  id boolean primary key default true check (id),
  owner_email text not null,
  time_zone text not null default 'America/New_York',
  gcal_calendar_id text               -- the "Time blocks" Google calendar, once created
);
-- Extra Google calendars whose events show in the week, besides his main one. Owner-only, like
-- the rest of settings, so the IDs never reach /now.
alter table settings add column if not exists calendars text[] not null default '{}';

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 500),
  day date,                          -- null: on a Someday list
  list text,                         -- Someday list name, when day is null
  position double precision not null default 0,
  est_min int check (est_min > 0),
  at_time time,                      -- fixed time: stays on its day, never rolls
  tag text,
  public boolean not null default false,
  done boolean not null default false,
  rolls int not null default 0,
  parked_on date,                    -- the day rollover sent it back to Someday
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((day is null) = (list is not null))
);
create index if not exists tasks_day on tasks (day);
-- The day a task must be finished by (docs/sheet-nudges.md). Owner-only: the public views below
-- list their columns by name and leave it out, so /now never sees a due date.
alter table tasks add column if not exists due date;

create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  gcal_id text
);
-- A block Claude proposed (docs/sheet-nudges.md). It has no Google event and never reaches the
-- public views until Lisul approves it in /plan; unapproved, it lapses at the end of its day.
alter table blocks add column if not exists proposed boolean not null default false;
create index if not exists blocks_task on blocks (task_id);
create index if not exists blocks_time on blocks (starts_at, ends_at);

create table if not exists days (
  day date primary key,
  planned boolean not null default false,
  shutdown boolean not null default false,
  shutdown_at time,                  -- this day's shutdown line, when moved from the default
  reflection text                    -- never public
);

-- Telegram (docs/sheet-nudges.md): the chat the bot writes to, set by tools/sheet-setup.sh, and
-- the switch that turns the messages off.
alter table settings add column if not exists telegram_chat_id bigint;
alter table settings add column if not exists nudges_on boolean not null default true;

-- One row per Telegram message sent. The unique key is what stops a message going out twice:
-- the telegram function claims a row before sending. No foreign key on block_id: the row
-- outlives a block deleted later, so the day's nudge budget still counts it.
create table if not exists nudges (
  id uuid primary key default gen_random_uuid(),
  block_id uuid,                     -- null for the brief and the check-in
  kind text not null check (kind in ('brief', 'start', 'repeat', 'snooze', 'checkin')),
  day date not null,
  send_at timestamptz not null,      -- the minute it was due
  sent_at timestamptz,               -- null while it is being sent
  unique nulls not distinct (block_id, kind, day, send_at)
);
create index if not exists nudges_day on nudges (day);

-- Google events a Done tap changed while /plan was closed (Telegram can't reach Google): end the
-- event at ends_at, or delete it when ends_at is null. /plan applies them when it opens, then
-- deletes the rows.
create table if not exists gcal_pending (
  gcal_id text primary key,
  ends_at timestamptz
);

create or replace function touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tasks_touch on tasks;
create trigger tasks_touch before update on tasks for each row execute function touch();

-- The owner is whoever signed in with settings.owner_email.
create or replace function is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select owner_email from settings) = auth.jwt() ->> 'email', false)
$$;

alter table settings enable row level security;
alter table tasks enable row level security;
alter table blocks enable row level security;
alter table days enable row level security;
alter table nudges enable row level security;
alter table gcal_pending enable row level security;
drop policy if exists owner_all on settings;
drop policy if exists owner_all on tasks;
drop policy if exists owner_all on blocks;
drop policy if exists owner_all on days;
drop policy if exists owner_all on nudges;
drop policy if exists owner_all on gcal_pending;
create policy owner_all on settings for all using (is_owner()) with check (is_owner());
create policy owner_all on tasks for all using (is_owner()) with check (is_owner());
create policy owner_all on blocks for all using (is_owner()) with check (is_owner());
create policy owner_all on days for all using (is_owner()) with check (is_owner());
create policy owner_all on nudges for all using (is_owner()) with check (is_owner());
create policy owner_all on gcal_pending for all using (is_owner()) with check (is_owner());
revoke all on settings, tasks, blocks, days, nudges, gcal_pending from anon;

-- Today in the owner's time zone.
create or replace function sheet_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone (select time_zone from settings))::date
$$;

-- Roll the given unfinished, untimed tasks onto `target`: each roll counts, and the 4th sends
-- the task back to the Someday "Inbox" list instead. Rolled tasks go to the bottom of the day.
create or replace function roll_tasks(ids uuid[], target date) returns void
language plpgsql security definer set search_path = public as $$
declare base double precision;
begin
  select coalesce(max(position), 0) into base from tasks where day = target;
  update tasks t set day = target, rolls = t.rolls + 1, position = base + r.n
  from (select id, row_number() over (order by day, position) as n from tasks
        where id = any(ids) and not done and at_time is null and day is not null and rolls < 3) r
  where t.id = r.id;
  update tasks set day = null, list = 'Inbox', rolls = 0, parked_on = target
  where id = any(ids) and not done and at_time is null and day is not null and day < target and rolls >= 3;
end $$;
revoke execute on function roll_tasks(uuid[], date) from public, anon, authenticated;

-- A proposal lapses at the end of its day: these delete the proposed blocks of day `d`, or of
-- the days before it.
drop function if exists lapse_proposals(date, boolean);
create or replace function lapse_proposals_on(d date) returns void
language sql security definer set search_path = public as $$
  delete from blocks where proposed and (starts_at at time zone (select time_zone from settings))::date = d
$$;
create or replace function lapse_proposals_before(d date) returns void
language sql security definer set search_path = public as $$
  delete from blocks where proposed and (starts_at at time zone (select time_zone from settings))::date < d
$$;
revoke execute on function lapse_proposals_on(date), lapse_proposals_before(date) from public, anon, authenticated;

-- Nightly (run hourly; a no-op once done): everything left behind rolls to today, and
-- earlier days' proposals lapse. v4 (docs/sheet-morning.md): earlier days' pending morning plans
-- are marked lapsed, ended busy times go, and Needs you drops rows done or over 14 days old.
-- The v4 tables are created further down; plpgsql resolves them only when this runs.
create or replace function nightly_roll() returns void
language plpgsql security definer set search_path = public as $$
declare today date := sheet_today();
begin
  perform lapse_proposals_before(today);
  perform roll_tasks(array(select id from tasks
    where day < today and not done and at_time is null), today);
  update proposals set status = 'lapsed' where status = 'pending' and day < today;
  delete from busy where ends_at <= now();
  delete from needs_you where done or coalesce(created_at, day::timestamptz) < now() - interval '14 days';
  -- v5 P1: actuals are kept 120 days.
  delete from actuals where at < now() - interval '120 days';
  -- v5 L1: so is feedback.
  delete from feedback where at < now() - interval '120 days';
  -- v5 R1: changes and replans are kept 14 days.
  delete from changes where at < now() - interval '14 days';
  delete from replans where at < now() - interval '14 days';
  -- v5 M1: so are reply_state and message_senders.
  delete from reply_state where since < now() - interval '14 days';
  delete from message_senders where at < now() - interval '14 days';
  -- Messages to Claude are kept 30 days.
  delete from messages where at < now() - interval '30 days';
  -- Event to-dos are kept 30 days after their day.
  delete from event_todos where day < today - 30;
  -- Oura: sleep rows are kept 60 days.
  delete from sleep_nights where bedtime_end < now() - interval '60 days';
  delete from sleep_days where day < current_date - 60;
  delete from sleep_times where day < current_date - 60;
  delete from ring_workouts where day < current_date - 60;
  delete from rest_periods where end_day < current_date - 60;
end $$;
revoke execute on function nightly_roll() from public, anon, authenticated;

-- Shutdown: save the reflection, mark the day, let its proposals lapse, roll its missed tasks
-- to the next day.
create or replace function shut_down(d date, reflection text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_owner() then raise exception 'not the owner'; end if;
  insert into days (day, shutdown, reflection) values (d, true, reflection)
  on conflict (day) do update set shutdown = true, reflection = excluded.reflection;
  perform lapse_proposals_on(d);
  perform roll_tasks(array(select id from tasks
    where day = d and not done and at_time is null), d + 1);
end $$;
revoke execute on function shut_down(date, text) from public, anon;
grant execute on function shut_down(date, text) to authenticated;

-- Public views. They run with the table owner's rights, so they read past row-level security,
-- and they are the only way visitors see anything. A private task gives its length, not its title.
-- Proposed blocks are not part of the plan, so they never show (only public_now reads blocks).
create or replace view public_week as
  select id, day, position, done, public,
         case when public then title end as title,
         case when public then tag end as tag,
         case when public then null else least(char_length(title), 40) end as bar
  from tasks where day is not null;

create or replace view public_days as
  select day, planned, shutdown from days;

-- One row: the block running now (if any) and the date of the last edit.
create or replace view public_now as
  select n.title, n.tag, n.public, m.updated_on
  from (select (max(updated_at) at time zone (select time_zone from settings))::date as updated_on from tasks) m
  left join lateral (
    select case when t.public then t.title end as title,
           case when t.public then t.tag end as tag, t.public
    from blocks b join tasks t on t.id = b.task_id
    where not b.proposed and now() >= b.starts_at and now() < b.ends_at
    order by b.starts_at limit 1
  ) n on true;

grant select on public_week, public_days, public_now to anon, authenticated;

create extension if not exists pg_cron;
-- Every sheet-* job is scheduled by name with no unschedule first: cron.schedule(job_name, ...)
-- on a name that exists updates that job's schedule and command in place and returns the same
-- jobid (pg_cron 1.6.4, checked on supabase/postgres 17.11.0.018), so a re-run of this file keeps
-- the ids and their cron.job_run_details history. To change one live job without this file,
-- cron.alter_job(job_id, schedule, command, database, username, active) does the same
-- (github.com/citusdata/pg_cron, "Altering a cron job").
-- Each job's net.http_post waits 30 s (campus 2 min): pg_net cancels a request after
-- timeout_milliseconds (supabase.com/docs/guides/database/extensions/pg_net), and the default
-- (5 s on the live pg_net 0.20.4) cut off telegram, mail and oura runs that were still working, so
-- their response was never recorded.
select cron.schedule('sheet-rollover', '5 * * * *', 'select public.nightly_roll()');

-- Every minute, call the telegram Edge Function to send what's due (docs/sheet-nudges.md). Its
-- URL and the shared secret it checks live in Vault, put there by tools/sheet-setup.sh, so no
-- secret is in this file; until they exist the job does nothing.
create extension if not exists pg_net;
select cron.schedule('sheet-telegram', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_telegram_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "send"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_telegram_url')
$job$);

-- Mail connector (docs/sheet-sources.md, ADR 0002): the refresh token of one mail account, read
-- from Vault by the mail-mcp Edge Function with the service role. Nobody else may call it: the
-- browser can read and delete mail_accounts rows, but never Vault. plpgsql, so it is created even
-- before mail_accounts exists; null when the account or its secret is missing.
create or replace function mail_refresh_token(account_email text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  return (select s.decrypted_secret from mail_accounts a
          join vault.decrypted_secrets s on s.id = a.vault_secret_id
          where a.email = account_email);
end $$;
revoke execute on function mail_refresh_token(text) from public, anon, authenticated;

-- Set the owner: the Google account that signs in to /plan.
insert into settings (owner_email) values ('you@example.com')
on conflict (id) do nothing;

-- Interest profile (docs/sheet-sources.md): a few plain lines on what Lisul likes, which Claude
-- matches campus events against. Null until he writes one in /plan. Owner-only, like the rest
-- of settings, and no view names it.
alter table settings add column if not exists interests text;

-- --- Mail accounts (docs/sheet-sources.md, v3) ----------------------------------------------
-- One row per Google account connected for the inbox sweep (ADR 0002). The account's refresh
-- token lives in Vault, never here: vault_secret_id points at it. The mail-connect Edge Function
-- writes rows with the service key; the browser can read and delete them, nothing more, so it
-- can never aim vault_secret_id at another secret.
create table if not exists mail_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  label text,                        -- a short name, like "SBU"; null shows the email
  vault_secret_id uuid,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_error text                    -- the last failure reading it; null while it works
);
alter table mail_accounts enable row level security;
drop policy if exists owner_all on mail_accounts;
create policy owner_all on mail_accounts for all using (is_owner()) with check (is_owner());
revoke all on mail_accounts from anon;
revoke insert, update on mail_accounts from authenticated;

-- Removing an account deletes its refresh token too. Security definer because only the
-- database owner may touch vault.secrets (supabase.com/docs/guides/database/vault: deleting
-- from vault.secrets removes the secret).
create or replace function mail_account_forget() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end $$;
drop trigger if exists mail_accounts_forget on mail_accounts;
create trigger mail_accounts_forget after delete on mail_accounts for each row execute function mail_account_forget();
revoke execute on function mail_account_forget() from public, anon, authenticated;

-- Store a connected account's refresh token: the mail-connect Edge Function calls this through
-- PostgREST rpc with the service key, the only caller allowed. A new account gets a new Vault
-- secret; reconnecting replaces the old token in place, so the row keeps its secret id
-- (vault.create_secret(secret, name, description) and vault.update_secret(id, secret), as in
-- supabase.com/docs/guides/database/vault). A row whose secret is gone gets a fresh one.
create or replace function mail_account_save(account text, refresh text) returns void
language plpgsql security definer set search_path = public as $$
declare secret_id uuid;
begin
  select s.id into secret_id from vault.secrets s
  where s.id = (select vault_secret_id from mail_accounts where email = account)
     or s.name = 'mail_refresh:' || account
  limit 1;
  if secret_id is null then
    secret_id := vault.create_secret(refresh, 'mail_refresh:' || account, 'Google refresh token, gmail.readonly');
  else
    perform vault.update_secret(secret_id, refresh);
  end if;
  insert into mail_accounts (email, vault_secret_id, connected_at, last_error)
  values (account, secret_id, now(), null)
  on conflict (email) do update
  set vault_secret_id = excluded.vault_secret_id, connected_at = now(), last_error = null;
end $$;
revoke execute on function mail_account_save(text, text) from public, anon, authenticated;

-- --- Course tasks from Brightspace (docs/sheet-sources.md, v3) -------------------------------
-- A course task is an ordinary private task that came from a feed: source names the feed
-- ('brightspace'), source_uid the feed item's UID. Both stay null for hand-made tasks, and the
-- public views list their columns by name, so neither ever reaches /now. Unique together, so a
-- feed item is one task at most (nulls are distinct, so hand-made tasks never clash).
alter table tasks add column if not exists source text;
alter table tasks add column if not exists source_uid text;
create unique index if not exists tasks_source_uid on tasks (source, source_uid);

-- Every feed item UID ever inserted as a task. A seen UID is never inserted again, so a course
-- task Lisul deletes never comes back.
create table if not exists feed_seen (
  source text not null,
  uid text not null,
  seen_at timestamptz not null default now(),
  primary key (source, uid)
);

-- One row per feed: the last fetch, whether it worked and how many items it read, for the Feeds
-- status in /plan Settings. etag and last_modified let a feed be fetched conditionally (campus).
-- error never holds the feed's URL: that URL is a secret.
create table if not exists feed_state (
  source text primary key,
  etag text,
  last_modified text,
  fetched_at timestamptz,
  ok boolean,
  error text,
  items int
);

alter table feed_seen enable row level security;
alter table feed_state enable row level security;
drop policy if exists owner_all on feed_seen;
drop policy if exists owner_all on feed_state;
create policy owner_all on feed_seen for all using (is_owner()) with check (is_owner());
create policy owner_all on feed_state for all using (is_owner()) with check (is_owner());
revoke all on feed_seen, feed_state from anon;

-- At :20 every hour, call the brightspace Edge Function to sync course tasks. Like
-- sheet-telegram, its URL and the shared secret come from Vault, so until both exist the job
-- does nothing.
select cron.schedule('sheet-brightspace', '20 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_brightspace_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "sync"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_brightspace_url')
$job$);

-- --- Campus events (docs/sheet-sources.md, v3) ----------------------------------------------
-- SB Engaged's public events from today through 14 days ahead, kept by the campus Edge Function
-- (supabase/functions/campus), which writes with the service key. The data is public anyway,
-- but it stays owner-only and out of every public view, so the anon key can't mirror it.
-- The function records each fetch in feed_state under source 'campus'.
create table if not exists campus_events (
  uid text primary key,              -- the feed's UID
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  group_name text,                   -- the organizer, or the club acronym without one
  event_type text,                   -- "Meeting", "Workshop", …
  tags text[] not null default '{}', -- "Free Food & Refreshments", "Health & Wellness", …
  description text,
  url text,                          -- the event's SB Engaged page
  location text,                     -- null when the feed hides it behind sign-in
  updated_at timestamptz not null default now()
);
create index if not exists campus_events_starts_at on campus_events (starts_at);
alter table campus_events enable row level security;
drop policy if exists owner_all on campus_events;
create policy owner_all on campus_events for all using (is_owner()) with check (is_owner());
revoke all on campus_events from anon;
revoke insert, update, delete on campus_events from authenticated;
-- How many have registered, read from the event's public page (the feed has no count), and when
-- it was last read. The function refreshes a few dozen an hour (feeds.mjs, countsDue); the feed
-- upsert leaves both alone, since it never sends them.
alter table campus_events add column if not exists rsvp_count int;
alter table campus_events add column if not exists rsvp_checked_at timestamptz;

-- At :35 every hour, call the campus Edge Function to sync the feed. Like sheet-telegram, its
-- URL and the shared secret come from Vault; until both exist the job does nothing. The function
-- takes several seconds (an 8 MB download, then batched writes), longer than pg_net's 2 s
-- default timeout (supabase.com/docs/guides/database/extensions/pg_net), so it gets 2 minutes.
select cron.schedule('sheet-campus', '35 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_campus_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "campus"}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_campus_url')
$job$);

-- --- Mail connect states (docs/sheet-sources.md, v3) -----------------------------------------
-- The nonce of each signed state mail-connect's /start hands out. /callback deletes it as it
-- reads it, so a state works once: a replayed callback finds no row. Only the service role (the
-- function) touches it; the browser's roles get nothing, and with RLS on and no policy they
-- couldn't read it anyway.
create table if not exists mail_connect_states (
  nonce text primary key,
  created_at timestamptz not null default now()
);
alter table mail_connect_states enable row level security;
revoke all on mail_connect_states from anon, authenticated;

-- --- The morning plan (docs/sheet-morning.md, v4; ADR 0003) ---------------------------------
-- The proposal the morning task submits through planner-mcp, one per day. Its blocks are the
-- day's proposed blocks; this row carries what they can't: its status, the note on what didn't
-- fit, and the campus picks ([{ uid, why }]).
create table if not exists proposals (
  day date primary key,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'skipped', 'lapsed')),
  note text check (char_length(note) <= 280),   -- one line: what didn't fit, and why
  picks jsonb not null default '[]'
);

-- Mail that needs Lisul, found by the morning task. day is the proposal's day. One row per
-- message, ever, while it is kept: a later run never brings back one he marked done.
create table if not exists needs_you (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  account text not null,
  message_id text not null,
  link text not null,
  sender text not null,
  subject text not null,
  why text not null,
  kind text not null check (kind in ('reply', 'deadline', 'meeting', 'admin')),
  due date,
  done boolean not null default false,
  created_at timestamptz default now(),
  unique (account, message_id)
);

-- Busy times from his Google calendars, which /plan saves each time it loads them: start and end
-- only, never a title. The server has no Google token, so this is all the morning task sees.
create table if not exists busy (
  starts_at timestamptz,
  ends_at timestamptz,
  primary key (starts_at, ends_at)
);

alter table proposals enable row level security;
alter table needs_you enable row level security;
alter table busy enable row level security;
drop policy if exists owner_all on proposals;
drop policy if exists owner_all on needs_you;
drop policy if exists owner_all on busy;
create policy owner_all on proposals for all using (is_owner()) with check (is_owner());
create policy owner_all on needs_you for all using (is_owner()) with check (is_owner());
create policy owner_all on busy for all using (is_owner()) with check (is_owner());
revoke all on proposals, needs_you, busy from anon;

-- When /plan last saved busy times, and whether the morning task is set up. Owner-only, like the
-- rest of settings.
alter table settings add column if not exists busy_as_of timestamptz;
alter table settings add column if not exists morning_on boolean not null default false;

-- The plan sent on its own when it lands after the brief. Dropped and added again by name (the
-- one Postgres gave the inline check), so a re-run is safe.
alter table nudges drop constraint if exists nudges_kind_check;
alter table nudges add constraint nudges_kind_check
  check (kind in ('brief', 'start', 'repeat', 'snooze', 'checkin', 'proposal', 'finished', 'replan', 'wind_down', 'bedtime', 'horizon'));

-- Write day d's proposal in one transaction: its proposed blocks replaced by `blocks`
-- ([{ task_id, starts_at, ends_at }]), the proposals row pending with a new created_at, and the
-- `needs` rows added, skipping any (account, message_id) already there, done or not. Security
-- invoker, so RLS applies to the caller (planner-mcp's owner-scoped client). It refuses a day
-- already approved or skipped, and checks nothing else: checkProposal (src/sheet/proposal.mjs)
-- does, before it is called. Parameters are qualified, since blocks, picks and note are also
-- table or column names.
create or replace function apply_proposal(d date, blocks jsonb, needs jsonb, picks jsonb, note text) returns void
language plpgsql security invoker set search_path = public as $$
declare current text;
begin
  select status into current from proposals where day = d for update;
  if current in ('approved', 'skipped', 'lapsed') then
    raise exception 'the proposal for % is already %', d, current;
  end if;
  delete from public.blocks b
  where b.proposed and (b.starts_at at time zone (select time_zone from settings))::date = d;
  insert into public.blocks (task_id, starts_at, ends_at, proposed)
  select x.task_id, x.starts_at, x.ends_at, true
  from jsonb_to_recordset(coalesce(apply_proposal.blocks, '[]')) as x(task_id uuid, starts_at timestamptz, ends_at timestamptz);
  insert into proposals (day, created_at, status, note, picks)
  values (d, clock_timestamp(), 'pending', apply_proposal.note, coalesce(apply_proposal.picks, '[]'))
  on conflict (day) do update
  set created_at = excluded.created_at, status = 'pending', note = excluded.note, picks = excluded.picks;
  -- A new submission replaces the day's open items, so repeated submits can't pile rows up.
  delete from needs_you where day = d and not done;
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind, due)
  select d, x.account, x.message_id, x.link, x.sender, x.subject, x.why, x.kind, x.due
  from jsonb_to_recordset(coalesce(apply_proposal.needs, '[]'))
    as x(account text, message_id text, link text, sender text, subject text, why text, kind text, due date)
  on conflict (account, message_id) do nothing;
end $$;
revoke execute on function apply_proposal(date, jsonb, jsonb, jsonb, text) from public, anon;
grant execute on function apply_proposal(date, jsonb, jsonb, jsonb, text) to authenticated;

-- Shutting a day down lapses its proposal as well as deleting the proposed blocks (redefined here,
-- after the proposals table exists), so a later morning run can't plan a day that is closed.
create or replace function lapse_proposals_on(d date) returns void
language sql security definer set search_path = public as $$
  delete from blocks where proposed and (starts_at at time zone (select time_zone from settings))::date = d;
  update proposals set status = 'lapsed' where day = d and status = 'pending';
$$;

-- --- v5 D2: a realistic day (docs/sheet-v5.md) ---------------------------------------------
-- The most minutes of blocks a day may hold, set in /plan's Settings (in hours, 1 to 16) and
-- read by checkProposal through read_planner's day_rules. Owner-only, like the rest of settings.
alter table settings add column if not exists workload_cap_min int not null default 360;
alter table settings drop constraint if exists settings_workload_cap_min_check;
alter table settings add constraint settings_workload_cap_min_check check (workload_cap_min between 60 and 960);
-- The at-risk tasks a revision couldn't fit, as task ids; apply_proposal (V1) writes it.
alter table proposals add column if not exists couldnt_fit uuid[] not null default '{}';

-- --- v5 W1, weather (docs/sheet-v5.md) -------------------------------------------------------
-- The NWS forecast for campus, kept by the weather Edge Function (supabase/functions/weather):
-- one row, the hourly periods and active alerts as sources.mjs shapes them. forecast_url is the
-- point's forecastHourly link, cached so each run skips the /points lookup. The brief and
-- read_planner read it; only the function writes it.
alter table settings add column if not exists weather_point text not null default '40.9126,-73.1234';
alter table settings drop constraint if exists settings_weather_point_check;
alter table settings add constraint settings_weather_point_check
  check (weather_point ~ '^-?\d{1,2}\.\d{1,4},-?\d{1,3}\.\d{1,4}$');

create table if not exists weather_cache (
  id boolean primary key default true check (id),
  point text not null,
  forecast_url text,
  periods jsonb not null default '[]',
  alerts jsonb not null default '[]',
  fetched_at timestamptz
);
alter table weather_cache enable row level security;
drop policy if exists owner_all on weather_cache;
create policy owner_all on weather_cache for all using (is_owner()) with check (is_owner());
revoke all on weather_cache from anon;
revoke insert, update, delete on weather_cache from authenticated;

-- At :50 every hour, call the weather Edge Function. Like sheet-brightspace, it does nothing
-- until its URL and the shared secret are in Vault.
select cron.schedule('sheet-weather', '50 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_weather_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "weather"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_weather_url')
$job$);

-- === v5 S1, busy times saved by the server (docs/sheet-v5.md) ================================
-- Each busy row says where it came from, so the calendar sync and the browser replace only
-- their own ('calendar') rows and leave Handshake's alone. The key gains source; re-run safe.
alter table busy add column if not exists source text not null default 'calendar'
  check (source in ('calendar', 'handshake'));
do $$ begin
  if not exists (select 1 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
                 where c.conrelid = 'busy'::regclass and c.contype = 'p' and a.attname = 'source') then
    alter table busy drop constraint if exists busy_pkey;
    alter table busy alter column starts_at set not null, alter column ends_at set not null;
    alter table busy add primary key (source, starts_at, ends_at);
  end if;
end $$;

-- The one Google account whose free/busy busy-sync reads: connected apart from mail, scope
-- calendar.freebusy only. Its refresh token lives in Vault; vault_secret_id points at it. The
-- calendar-connect and busy-sync functions write the row with the service key; the browser can
-- read it and delete it (Disconnect), nothing more.
create table if not exists calendar_account (
  id boolean primary key default true check (id),
  email text not null,
  vault_secret_id uuid,
  connected_at timestamptz not null default now(),
  last_error text                    -- the last refused refresh or failed read; null while it works
);
alter table calendar_account enable row level security;
drop policy if exists owner_all on calendar_account;
create policy owner_all on calendar_account for all using (is_owner()) with check (is_owner());
revoke all on calendar_account from anon;
revoke insert, update on calendar_account from authenticated;

-- Disconnecting deletes the refresh token too (as mail_account_forget).
create or replace function calendar_account_forget() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end $$;
drop trigger if exists calendar_account_forget on calendar_account;
create trigger calendar_account_forget after delete on calendar_account for each row execute function calendar_account_forget();
revoke execute on function calendar_account_forget() from public, anon, authenticated;

-- Store the calendar refresh token as calendar_refresh:<account>, reusing the secret on
-- reconnect (as mail_account_save). Service key only.
create or replace function calendar_account_save(account text, refresh text) returns void
language plpgsql security definer set search_path = public as $$
declare secret_id uuid;
begin
  select s.id into secret_id from vault.secrets s
  where s.id = (select vault_secret_id from calendar_account)
     or s.name = 'calendar_refresh:' || account
  limit 1;
  if secret_id is null then
    secret_id := vault.create_secret(refresh, 'calendar_refresh:' || account, 'Google refresh token, calendar.freebusy');
  else
    perform vault.update_secret(secret_id, refresh);
  end if;
  insert into calendar_account (id, email, vault_secret_id, connected_at, last_error)
  values (true, account, secret_id, now(), null)
  on conflict (id) do update
  set email = excluded.email, vault_secret_id = excluded.vault_secret_id, connected_at = now(), last_error = null;
end $$;
revoke execute on function calendar_account_save(text, text) from public, anon, authenticated;

-- The calendar refresh token for busy-sync, or null when nothing is connected.
create or replace function calendar_refresh_token() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  return (select s.decrypted_secret from calendar_account a
          join vault.decrypted_secrets s on s.id = a.vault_secret_id);
end $$;
revoke execute on function calendar_refresh_token() from public, anon, authenticated;

-- busy-sync's write, in one transaction: the calendar busy rows overlapping from_at to to_at
-- replaced by `rows` ([{ starts_at, ends_at }]), busy_as_of stamped from_at, and the busy change
-- (busyChange in src/sheet/freebusy.mjs) inserted when there is one. The changes table comes
-- with replans (R1); until it exists the change is dropped. Service key only.
create or replace function busy_sync_save(from_at timestamptz, to_at timestamptz, rows jsonb, change jsonb default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  delete from busy b where b.source = 'calendar' and b.starts_at < to_at and b.ends_at > from_at;
  insert into busy (source, starts_at, ends_at)
  select 'calendar', x.starts_at, x.ends_at
  from jsonb_to_recordset(coalesce(busy_sync_save.rows, '[]')) as x(starts_at timestamptz, ends_at timestamptz)
  on conflict do nothing;
  update settings set busy_as_of = from_at where id;  -- pg-safeupdate refuses an update with no where
  if change is not null and to_regclass('public.changes') is not null then
    execute 'insert into changes (kind, reason, weight, ref) values ($1, $2, $3, $4)'
      using change->>'kind', change->>'reason', (change->>'weight')::int, change->>'ref';
  end if;
end $$;
revoke execute on function busy_sync_save(timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;

-- Every 10 minutes, call busy-sync. Like sheet-brightspace, its URL and the shared secret come
-- from Vault; until both exist the job does nothing.
select cron.schedule('sheet-busy', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_busy_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "busy"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_busy_url')
$job$);

-- --- v5 V1, revisions and locked blocks (docs/sheet-v5.md, "Schema → Revisions") -----------
-- Every plan for a day is a numbered revision. The newest pending one is current; a newer one
-- supersedes it. Approved blocks are locked: no revision moves or removes them.
alter table proposals add column if not exists rev int not null default 1 check (rev between 1 and 999);
alter table proposals add column if not exists run_trigger text not null default 'morning'
  check (run_trigger in ('morning', 'replan'));
alter table proposals add column if not exists reasons text[] not null default '{}';
-- couldnt_fit came with D2, above.
alter table proposals add column if not exists suggested jsonb not null default '[]';
-- The revision's proposed blocks as written: [{ task_id | habit_id, starts_at, ends_at }].
alter table proposals add column if not exists blocks jsonb not null default '[]';
alter table proposals drop constraint if exists proposals_pkey;
alter table proposals add constraint proposals_pkey primary key (day, rev);
alter table proposals drop constraint if exists proposals_status_check;
alter table proposals add constraint proposals_status_check
  check (status in ('pending', 'approved', 'skipped', 'lapsed', 'superseded'));

-- Tasks Lisul turned down on a day: later revisions that day don't offer them again.
alter table days add column if not exists turned_down uuid[] not null default '{}';

-- Write revision replaces + 1 of day d and return it. It refuses unless `replaces` is d's newest
-- revision (null when there is none), and refuses a day whose newest is skipped or lapsed, or
-- that is shut down. A pending newest is superseded; an approved one stays approved. d's proposed
-- blocks are replaced; a block with proposed = false is never touched. checkProposal
-- (src/sheet/proposal.mjs) checks everything else first. Parameters are qualified, since blocks,
-- picks, note, couldnt_fit, suggested, run_trigger and reasons are also column names.
-- Habit blocks need H1's blocks.habit_id and the changes rows R1's table: plpgsql plans each
-- statement when it first runs, so those stay unread until there is something to write.
drop function if exists apply_proposal(date, jsonb, jsonb, jsonb, text);
-- Fix: read_at, when its run read the day (read_planner's read_at): the revision consumes only
-- the changes logged by then, so one logged while the run worked waits for the next replan.
-- Without it, now() as before. The signature without it is dropped.
alter table proposals add column if not exists read_at timestamptz;
drop function if exists apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[]);
-- Oura: window_from, the window start the revision was planned from (the column is with Oura's
-- section, below). The signature without it is dropped.
drop function if exists apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz);
-- Auto-approval (docs/sheet-v5.md, "Auto-approval"): a block a run's revision approved by itself
-- (auto_approve_proposal, below). Until it starts, and until /plan moves it (which clears auto),
-- the next revision may move it: apply_proposal replaces it like a proposed one.
alter table blocks add column if not exists auto boolean not null default false;
-- Day rules and first steps (docs/sheet-v5.md): the first action the plan gives a block, which its
-- start nudge leads with. checkProposal holds it to one line of at most 80 characters.
alter table blocks add column if not exists first_step text check (char_length(first_step) between 1 and 80);
create or replace function apply_proposal(d date, replaces int, blocks jsonb, habit_blocks jsonb default '[]',
  needs jsonb default '[]', picks jsonb default '[]', note text default null,
  couldnt_fit uuid[] default '{}', suggested jsonb default '[]',
  run_trigger text default 'morning', reasons text[] default '{}', read_at timestamptz default null,
  window_from text default null) returns int
language plpgsql security invoker set search_path = public as $$
declare
  newest proposals%rowtype;
  tz text := (select time_zone from settings);
  r int := coalesce(replaces, 0) + 1;
  cut timestamptz := least(coalesce(apply_proposal.read_at, now()), now());
begin
  perform 1 from proposals p where p.day = d for update;
  select * into newest from proposals p where p.day = d order by p.rev desc limit 1;
  if newest.rev is distinct from replaces then
    raise exception 'the newest revision for % is %, not %', d, coalesce(newest.rev, 0), coalesce(replaces, 0);
  end if;
  if newest.status in ('skipped', 'lapsed') then
    raise exception 'the plan for % is already %', d, newest.status;
  end if;
  if exists (select 1 from days x where x.day = d and x.shutdown) then
    raise exception 'the plan for % is already lapsed', d;
  end if;
  update proposals p set status = 'superseded' where p.day = d and p.rev = newest.rev and p.status = 'pending';
  delete from public.blocks b where b.proposed and (b.starts_at at time zone tz)::date = d;
  -- Auto-approval: the earlier revisions' blocks still ahead go too, and /plan deletes their
  -- Google events when it next opens (gcal_pending, ends_at null).
  insert into gcal_pending (gcal_id, ends_at)
  select b.gcal_id, null from public.blocks b
  where b.auto and not b.proposed and b.starts_at > now() and b.gcal_id is not null and (b.starts_at at time zone tz)::date = d
  on conflict (gcal_id) do update set ends_at = null;
  delete from public.blocks b where b.auto and not b.proposed and b.starts_at > now() and (b.starts_at at time zone tz)::date = d;
  insert into public.blocks (task_id, starts_at, ends_at, proposed, first_step)
  select x.task_id, x.starts_at, x.ends_at, true, x.first_step
  from jsonb_to_recordset(coalesce(apply_proposal.blocks, '[]')) as x(task_id uuid, starts_at timestamptz, ends_at timestamptz, first_step text);
  if jsonb_array_length(coalesce(apply_proposal.habit_blocks, '[]')) > 0 then
    insert into public.blocks (habit_id, starts_at, ends_at, proposed)
    select x.habit_id, x.starts_at, x.ends_at, true
    from jsonb_to_recordset(apply_proposal.habit_blocks) as x(habit_id uuid, starts_at timestamptz, ends_at timestamptz);
  end if;
  insert into proposals (day, rev, created_at, status, note, picks, blocks, couldnt_fit, suggested, run_trigger, reasons, read_at, window_from)
  values (d, r, clock_timestamp(), 'pending', apply_proposal.note, coalesce(apply_proposal.picks, '[]'),
    (select coalesce(jsonb_agg(x order by x->>'starts_at'), '[]')
     from jsonb_array_elements(coalesce(apply_proposal.blocks, '[]') || coalesce(apply_proposal.habit_blocks, '[]')) x),
    coalesce(apply_proposal.couldnt_fit, '{}'), coalesce(apply_proposal.suggested, '[]'),
    coalesce(apply_proposal.run_trigger, 'morning'), coalesce(apply_proposal.reasons, '{}'), cut, apply_proposal.window_from);
  -- As in v4: a new revision replaces the day's open items, skipping any message already there.
  -- v5 SRC2: only mail rows; Slack rows are slack-sync's, and stay until he marks them done.
  delete from needs_you n where n.day = d and not n.done and n.source = 'mail';
  -- v5 L1: each row carries the sender hash checkProposal looked up (null when unknown).
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind, due, sender_hash)
  select d, x.account, x.message_id, x.link, x.sender, x.subject, x.why, x.kind, x.due, x.sender_hash
  from jsonb_to_recordset(coalesce(apply_proposal.needs, '[]'))
    as x(account text, message_id text, link text, sender text, subject text, why text, kind text, due date, sender_hash text)
  on conflict (account, message_id) do nothing;
  if to_regclass('public.changes') is not null then
    update changes c set consumed_day = d, consumed_rev = r
    where c.consumed_day is null and c.consumed_rev is null and c.at <= cut;
  end if;
  return r;
end $$;
revoke execute on function apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz, text) from public, anon;
grant execute on function apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[], timestamptz, text) to authenticated;

-- Approve all and Skip, from Telegram or /plan, act on revision `rev` only while it is d's newest
-- and pending, so a tap never decides a plan he hasn't seen.
create or replace function approve_proposal(d date, rev int) returns int
language plpgsql security invoker set search_path = public as $$
declare
  newest proposals%rowtype;
  n int;
begin
  perform 1 from proposals p where p.day = d for update;
  select * into newest from proposals p where p.day = d order by p.rev desc limit 1;
  if newest.rev is distinct from approve_proposal.rev or newest.status <> 'pending' then
    raise exception 'revision % of % is not the pending one', approve_proposal.rev, d;
  end if;
  update blocks b set proposed = false
  where b.proposed and (b.starts_at at time zone (select time_zone from settings))::date = d;
  get diagnostics n = row_count;
  update proposals p set status = 'approved' where p.day = d and p.rev = newest.rev;
  -- v5 A1: each suggested task goes to the bottom of Inbox, private, keyed by its message. A uid
  -- already in feed_seen is skipped, so a message makes one task, ever, even once deleted.
  with s as (
    select x.title, x.due, x.account || ':' || x.message_id as uid, row_number() over () as k
    from jsonb_to_recordset(newest.suggested) as x(account text, message_id text, title text, due date)
  ), fresh as (
    insert into feed_seen (source, uid) select 'mail', s.uid from s on conflict do nothing returning uid
  )
  insert into tasks (title, list, due, public, source, source_uid, position)
  select s.title, 'Inbox', s.due, false, 'mail', s.uid,
    (select coalesce(max(t.position), 0) from tasks t where t.day is null and t.list = 'Inbox') + s.k
  from s join fresh on fresh.uid = s.uid
  on conflict (source, source_uid) do nothing;
  return n;
end $$;
create or replace function skip_proposal(d date, rev int) returns void
language plpgsql security invoker set search_path = public as $$
declare newest proposals%rowtype;
begin
  perform 1 from proposals p where p.day = d for update;
  select * into newest from proposals p where p.day = d order by p.rev desc limit 1;
  if newest.rev is distinct from skip_proposal.rev or newest.status <> 'pending' then
    raise exception 'revision % of % is not the pending one', skip_proposal.rev, d;
  end if;
  delete from blocks b where b.proposed and (b.starts_at at time zone (select time_zone from settings))::date = d;
  update proposals p set status = 'skipped' where p.day = d and p.rev = newest.rev;
end $$;
-- The telegram function calls these with the service key.
revoke execute on function approve_proposal(date, int), skip_proposal(date, int) from public, anon;
grant execute on function approve_proposal(date, int), skip_proposal(date, int) to authenticated, service_role;

-- Auto-approval (docs/sheet-v5.md, "Auto-approval"): with settings.auto_approve on, submit_proposal
-- approves the revision it just saved, exactly as Approve all does, and marks its blocks auto so a
-- later revision may still move them until they start.
alter table settings add column if not exists auto_approve boolean not null default true;
create or replace function auto_approve_proposal(d date, rev int) returns int
language plpgsql security invoker set search_path = public as $$
begin
  update blocks b set auto = true
  where b.proposed and (b.starts_at at time zone (select time_zone from settings))::date = d;
  return approve_proposal(d, auto_approve_proposal.rev);
end $$;
revoke execute on function auto_approve_proposal(date, int) from public, anon;
grant execute on function auto_approve_proposal(date, int) to authenticated;
-- A revision's untimed tasks that couldn't fit (checkProposal's next_day) move to the bottom of
-- the next day, so its plan times them. Not a roll: rolls counts missed days, and these weren't.
-- Returns how many moved.
create or replace function move_to_next_day(d date, ids uuid[]) returns int
language plpgsql security invoker set search_path = public as $$
declare
  base double precision;
  n int;
begin
  select coalesce(max(t.position), 0) into base from tasks t where t.day = d + 1;
  update tasks t set day = d + 1, position = base + r.k
  from (select x.id, row_number() over (order by x.position) as k from tasks x
        where x.id = any(ids) and x.day = d and not x.done and x.at_time is null) r
  where t.id = r.id;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function move_to_next_day(date, uuid[]) from public, anon;
grant execute on function move_to_next_day(date, uuid[]) to authenticated;

-- /plan's × on a proposed block: it goes, and its task stays turned down for the rest of the day.
create or replace function turn_down(d date, task uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  delete from blocks b where b.proposed and b.task_id = task
    and (b.starts_at at time zone (select time_zone from settings))::date = d;
  insert into days (day, turned_down) values (d, array[task])
  on conflict (day) do update
  set turned_down = case when task = any(days.turned_down) then days.turned_down else days.turned_down || task end;
end $$;
revoke execute on function turn_down(date, uuid) from public, anon;
grant execute on function turn_down(date, uuid) to authenticated;

-- --- v5 P1, Finished? and pace (docs/sheet-v5.md) ----------------------------------------------
-- What a task really took, recorded by Telegram's Finished answer; pace per kind of task is
-- worked out from these in src/sheet/pace.mjs. No foreign keys, so a row outlives its task and
-- block. Owner-only, only the server writes it, and nightly_roll keeps 120 days.
create table if not exists actuals (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  day date not null,
  task_id uuid not null,
  block_id uuid,
  kind text not null check (kind in ('course', 'campus', 'github', 'jira', 'other')),
  est_min int,
  minutes int not null check (minutes between 1 and 960)
);
create index if not exists actuals_kind_at on actuals (kind, at desc);
alter table actuals enable row level security;
drop policy if exists owner_all on actuals;
create policy owner_all on actuals for all using (is_owner()) with check (is_owner());
revoke all on actuals from anon;
revoke insert, update, delete on actuals from authenticated;

-- The Finished? check, and the replan message (R1), in the nudges log.
alter table nudges drop constraint if exists nudges_kind_check;
alter table nudges add constraint nudges_kind_check
  check (kind in ('brief', 'start', 'repeat', 'snooze', 'checkin', 'proposal', 'finished', 'replan', 'wind_down', 'bedtime', 'horizon'));

-- --- v5 H1, habits (docs/sheet-v5.md) ----------------------------------------------------------
-- Things Lisul does on set weekdays (gym, lunch, a weekly review), edited in /plan's Settings.
-- read_planner gives the day's; the morning task places each within ideal ± flex_min, firm ones
-- before tasks and flexible ones after hard deadlines, or leaves it out that day. Owner-only, in
-- no public view.
create table if not exists habits (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  days int[] not null check (days <@ '{1,2,3,4,5,6,7}' and cardinality(days) > 0),  -- ISO, 1 = Monday
  ideal time not null,
  minutes int not null check (minutes between 15 and 240 and minutes % 5 = 0),
  flex_min int not null default 30 check (flex_min between 0 and 240),
  defence text not null default 'flexible' check (defence in ('flexible', 'firm')),
  position double precision not null default 0,
  created_at timestamptz not null default now()
);
alter table habits enable row level security;
drop policy if exists owner_all on habits;
create policy owner_all on habits for all using (is_owner()) with check (is_owner());
revoke all on habits from anon;

-- A block is a task's or a habit's. public_now joins blocks to tasks, so a habit block never
-- reaches /now.
alter table blocks add column if not exists habit_id uuid references habits on delete cascade;
alter table blocks alter column task_id drop not null;
alter table blocks drop constraint if exists blocks_task_or_habit;
alter table blocks add constraint blocks_task_or_habit check ((task_id is null) <> (habit_id is null));
create index if not exists blocks_habit on blocks (habit_id);

-- --- v5 R1, replans during the day (docs/sheet-v5.md) -----------------------------------------
-- Syncs log each change they find, with a weight (REASON_WORDS in src/sheet/replan.mjs); the
-- telegram minute tick decides from them when a replan is worth a run (shouldReplan) and logs
-- each one it starts in replans. Only the server writes either. apply_proposal runs as the owner
-- and marks the changes a revision read, so the owner keeps update on those two columns only.
-- nightly_roll keeps 14 days of both.
alter table settings add column if not exists replans_on boolean not null default false;
alter table settings add column if not exists plan_edited_at timestamptz;   -- /plan's last write

create table if not exists replans (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  day date not null,
  reasons text[] not null,
  counts jsonb not null,                         -- { kind: n }
  result text check (result in ('started', 'failed', 'rate_limited')),   -- null while sending
  retry_after timestamptz,
  session_id text,
  error text check (char_length(error) <= 300)
);
create index if not exists replans_day_at on replans (day, at desc);

create table if not exists changes (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (kind in ('mail', 'busy', 'course', 'campus', 'github', 'jira', 'slack', 'handshake')),
  reason text not null,
  weight int not null check (weight between 1 and 10),
  ref text check (char_length(ref) <= 200),      -- an id in the source; never a title
  replan_id uuid references replans on delete set null,
  consumed_day date,
  consumed_rev int
);
create index if not exists changes_open on changes (at) where consumed_rev is null;

alter table changes enable row level security;
alter table replans enable row level security;
drop policy if exists owner_all on changes;
create policy owner_all on changes for all using (is_owner()) with check (is_owner());
drop policy if exists owner_all on replans;
create policy owner_all on replans for all using (is_owner()) with check (is_owner());
revoke all on changes, replans from anon;
revoke insert, update, delete on changes, replans from authenticated;
grant update (consumed_day, consumed_rev) on changes to authenticated;

-- The telegram tick's claim on a replan (fix), in one transaction: it inserts the replans row and
-- ties the open changes `ids` to it, or returns null when another claim holds: one still sending
-- or started under 60 minutes ago (replan.mjs's PLAN_GAP), or a 429 whose retry_after is ahead.
-- The advisory lock makes two ticks at once take turns, so a replan fires once.
create or replace function claim_replan(d date, reasons text[], counts jsonb, ids uuid[]) returns uuid
language plpgsql security invoker set search_path = public as $$
declare rid uuid;
begin
  perform pg_advisory_xact_lock(hashtext('sheet.claim_replan'));
  if exists (select 1 from replans r where r.day = d
    and ((r.result is null or r.result = 'started') and r.at > now() - interval '60 minutes'
      or r.retry_after > now())) then
    return null;
  end if;
  insert into replans (day, reasons, counts) values (d, claim_replan.reasons, claim_replan.counts) returning id into rid;
  update changes c set replan_id = rid
  where c.id = any(ids) and c.replan_id is null and c.consumed_rev is null;
  return rid;
end $$;
revoke execute on function claim_replan(date, text[], jsonb, uuid[]) from public, anon, authenticated;
grant execute on function claim_replan(date, text[], jsonb, uuid[]) to service_role;

-- --- v5 L1, learning from his taps (docs/sheet-v5.md, "Schema") -------------------------------
-- Needs you gains Not needed (a done row he says wasn't worth showing) and the sender's hash
-- (sender_hash, below with message_senders), which the server sets from message_senders.
alter table needs_you add column if not exists not_needed boolean not null default false;

-- Every decision he makes, as ids only: Approve all or Skip by revision, turning down a block,
-- Done, Not needed and Undo on Needs you, and each Finished? answer. Refs: proposal { day, rev },
-- block { day, task_id }, needs_you { account, message_id, sender_hash }, finished { block_id,
-- task_id }. Append-only: the owner (/plan) and Telegram (service key) insert, nobody updates or
-- deletes but nightly_roll, which keeps 120 days.
create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  item text not null check (item in ('proposal', 'block', 'needs_you', 'finished')),
  action text not null check (action in ('approve', 'skip', 'turn_down', 'done', 'not_needed',
                                         'undo', 'finished', 'more', 'nostart', 'tomorrow')),
  ref jsonb not null
);
create index if not exists feedback_item_at on feedback (item, at);
alter table feedback enable row level security;
drop policy if exists owner_all on feedback;
create policy owner_all on feedback for all using (is_owner()) with check (is_owner());
revoke all on feedback from anon;
revoke update, delete on feedback from authenticated;

-- Always show or never show, by sender address or domain. /plan writes them; read_planner gives
-- them to the planner, and submit_proposal drops any Needs you item a never rule covers.
create table if not exists triage_rules (
  id uuid primary key default gen_random_uuid(),
  match text not null check (match in ('address', 'domain')),
  pattern text not null check (pattern = lower(pattern) and char_length(pattern) between 3 and 254),
  action text not null check (action in ('always', 'never')),
  created_at timestamptz not null default now(),
  unique (match, pattern)
);
alter table triage_rules enable row level security;
drop policy if exists owner_all on triage_rules;
create policy owner_all on triage_rules for all using (is_owner()) with check (is_owner());
revoke all on triage_rules from anon;

-- --- v5 SRC3, Handshake, the academic calendar and enrollment (docs/sheet-v5.md) ---------------
-- When spring enrollment opens, entered once in /plan Settings; ical-sync turns it into one task
-- (enrollmentTask in src/sheet/sources.mjs). The feed links are function secrets
-- (SHEET_HANDSHAKE_ICS, SHEET_ACADEMIC_ICS), never columns here.
alter table settings add column if not exists enrollment_at timestamptz;

-- The academic calendar's entries per day ([{ title, all_day }], academicEntries), written by
-- ical-sync for today and the days ahead, for the brief and read_planner. Owner-only; only the
-- server writes it.
create table if not exists academic_days (
  day date primary key,
  entries jsonb not null default '[]',
  fetched_at timestamptz not null default now()
);
alter table academic_days enable row level security;
drop policy if exists owner_all on academic_days;
create policy owner_all on academic_days for all using (is_owner()) with check (is_owner());
revoke all on academic_days from anon;
revoke insert, update, delete on academic_days from authenticated;

-- ical-sync's Handshake write, in one transaction: the handshake busy rows overlapping from_at to
-- to_at replaced by `rows` ([{ starts_at, ends_at }]), leaving the calendar's alone, and a
-- handshake_change (weight 3) inserted when the set changed and the changes table (R1) exists.
-- Service key only.
create or replace function handshake_sync_save(from_at timestamptz, to_at timestamptz, rows jsonb)
returns void language plpgsql security invoker set search_path = public as $$
declare
  before jsonb;
  after jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_array(b.starts_at, b.ends_at) order by b.starts_at, b.ends_at), '[]') into before
  from busy b where b.source = 'handshake' and b.starts_at < to_at and b.ends_at > from_at;
  delete from busy b where b.source = 'handshake' and b.starts_at < to_at and b.ends_at > from_at;
  insert into busy (source, starts_at, ends_at)
  select 'handshake', x.starts_at, x.ends_at
  from jsonb_to_recordset(coalesce(handshake_sync_save.rows, '[]')) as x(starts_at timestamptz, ends_at timestamptz)
  where x.starts_at < to_at and x.ends_at > from_at
  on conflict do nothing;
  select coalesce(jsonb_agg(jsonb_build_array(b.starts_at, b.ends_at) order by b.starts_at, b.ends_at), '[]') into after
  from busy b where b.source = 'handshake' and b.starts_at < to_at and b.ends_at > from_at;
  if before <> after and to_regclass('public.changes') is not null then
    execute 'insert into changes (kind, reason, weight, ref) values ($1, $2, $3, $4)'
      using 'handshake', 'handshake_change', 3, null::text;
  end if;
end $$;
revoke execute on function handshake_sync_save(timestamptz, timestamptz, jsonb) from public, anon, authenticated;

-- At :25 every hour, call ical-sync (Handshake and the academic calendar). Like
-- sheet-brightspace, it does nothing until its URL and the shared secret are in Vault.
select cron.schedule('sheet-ical', '25 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_ical_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "ical"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_ical_url')
$job$);

-- --- v5 SRC1, GitHub and Jira tasks (docs/sheet-v5.md) ---------------------------------------
-- work-sync (supabase/functions/work-sync) turns review requests and assigned issues in the orgs
-- below, and his open Jira tickets, into private tasks in the "GitHub" and "Jira" lists, with
-- their page in `link`. The public views list their columns by name, so link never reaches /now.
-- The tokens are function secrets (SHEET_GITHUB_TOKEN, SHEET_JIRA_TOKEN), never columns here.
alter table settings add column if not exists github_orgs text[] not null default '{}';
alter table tasks add column if not exists link text;
alter table tasks drop constraint if exists tasks_link_check;
alter table tasks add constraint tasks_link_check check (link is null or link ~ '^https://');

-- At :40 every hour, call work-sync. Like sheet-brightspace, it does nothing until its URL and
-- the shared secret are in Vault.
select cron.schedule('sheet-work', '40 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_work_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "work"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_work_url')
$job$);

-- --- v5 M1, mail checked every 5 minutes, and reply tracking (docs/sheet-v5.md; ADR 0004) -------
-- The mail-sync Edge Function reads Gmail history with labels, dates and a few headers only, never
-- mail text, and keeps three things, all owner-only and written only by the server:
--   known_senders    salted SHA-256 hashes (senderHash, src/sheet/mail.mjs) of the addresses he
--                    has sent mail to, never an address;
--   message_senders  each received message's sender hashes (senderHashes: the address's, its
--                    domain's and each parent's), for submit_proposal's never-show rules (L1);
--                    14 days, like Needs you; never an address;
--   reply_state      per thread, Reply owed or Awaiting reply (replyState), with a display name.
-- mail_accounts.history_id is where each account's next history read starts.
alter table mail_accounts add column if not exists history_id text;

create table if not exists known_senders (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  last_sent_at timestamptz not null
);

create table if not exists message_senders (
  account text,
  message_id text,
  thread_id text not null,
  address_hash text not null,
  domain_hashes text[] not null default '{}',
  at timestamptz not null,
  primary key (account, message_id)
);

create table if not exists reply_state (
  account text,
  thread_id text,
  state text not null check (state in ('owed', 'awaiting')),
  since timestamptz not null,                     -- the newest message's date
  message_id text not null,                       -- the newest message
  who text not null check (char_length(who) <= 80),   -- display name only, never an address
  updated_at timestamptz not null default now(),
  primary key (account, thread_id)
);
-- Reply owed's evidence (replyState): "thread" they answered a thread he wrote in, "known" someone
-- he has written to wrote to him, "cc" the same with him copied; null for awaiting. draft: the
-- thread holds his unsent Gmail draft (a draft is not a reply).
alter table reply_state add column if not exists basis text check (basis in ('thread', 'known', 'cc'));
alter table reply_state add column if not exists draft boolean not null default false;
-- Owed rows from the rule before basis existed are stale; re-runnable (new owed rows always
-- have a basis).
delete from reply_state where state = 'owed' and basis is null;

alter table known_senders enable row level security;
alter table message_senders enable row level security;
alter table reply_state enable row level security;
drop policy if exists owner_all on known_senders;
create policy owner_all on known_senders for all using (is_owner()) with check (is_owner());
drop policy if exists owner_all on message_senders;
create policy owner_all on message_senders for all using (is_owner()) with check (is_owner());
drop policy if exists owner_all on reply_state;
create policy owner_all on reply_state for all using (is_owner()) with check (is_owner());
revoke all on known_senders, message_senders, reply_state from anon;
revoke insert, update, delete on known_senders, message_senders, reply_state from authenticated;

-- Fix: no From address in plain text (docs/sheet-v5.md, "Sender hashes"). message_senders keeps
-- hashes only, Needs you rows and their feedback a sender_hash, and a triage rule made from a
-- /plan offer matches by hash (match 'sender', with the sender's display name as its label).
-- Rows written with plain addresses before are deleted or stripped. Safe to re-run.
alter table message_senders add column if not exists address_hash text;
alter table message_senders add column if not exists domain_hashes text[] not null default '{}';
delete from message_senders where address_hash is null;
alter table message_senders drop column if exists from_address;
alter table message_senders alter column address_hash set not null;
alter table message_senders drop constraint if exists message_senders_hashes_check;
alter table message_senders add constraint message_senders_hashes_check
  check (address_hash ~ '^[0-9a-f]{64}$' and array_to_string(domain_hashes, ',') ~ '^([0-9a-f]{64}(,|$))*$');
alter table needs_you add column if not exists sender_hash text;
alter table needs_you drop column if exists from_address;
alter table needs_you drop constraint if exists needs_you_sender_hash_check;
alter table needs_you add constraint needs_you_sender_hash_check check (sender_hash is null or sender_hash ~ '^[0-9a-f]{64}$');
update feedback set ref = ref - 'from_address' where item = 'needs_you' and ref ? 'from_address';
alter table triage_rules add column if not exists label text check (label is null or char_length(label) <= 80);
alter table triage_rules drop constraint if exists triage_rules_match_check;
alter table triage_rules add constraint triage_rules_match_check check (match in ('address', 'domain', 'sender'));
alter table triage_rules drop constraint if exists triage_rules_sender_check;
alter table triage_rules add constraint triage_rules_sender_check check (match <> 'sender' or pattern ~ '^[0-9a-f]{64}$');

-- Every 5 minutes from :02, call mail-sync. Like sheet-brightspace, it does nothing until its URL
-- and the shared secret are in Vault.
select cron.schedule('sheet-mail', '2-59/5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_mail_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "mail"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_mail_url')
$job$);

-- --- v5 SRC2, Slack in Needs you (docs/sheet-v5.md) ------------------------------------------
-- slack-sync (supabase/functions/slack-sync) writes a needs_you row per new mention or DM, with
-- account 'slack', message_id '<channel id>:<ts>', the channel, the person and the permalink,
-- never the message text. Its ids go in feed_seen ('slack', message_id) as well, so a row he
-- marked done (and nightly_roll deleted) never comes back. The token is a function secret
-- (SHEET_SLACK_TOKEN), never a column here.
alter table needs_you add column if not exists source text not null default 'mail';
alter table needs_you drop constraint if exists needs_you_source_check;
alter table needs_you add constraint needs_you_source_check check (source in ('mail', 'slack'));

-- At :42 every hour, call slack-sync. Like sheet-work, it does nothing until its URL and the
-- shared secret are in Vault.
select cron.schedule('sheet-slack', '42 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_slack_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "slack"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_slack_url')
$job$);

-- --- Messages to Claude (docs/sheet-messages.md) --------------------------------------------
-- Plain lines Lisul types into /plan ("dentist Thu 3pm"). The message Edge Function inserts one
-- and fires the morning task; the task answers it through planner-mcp's answer_messages, which
-- calls answer_message below. events are the events Claude worked out ([{ title, starts_at,
-- ends_at }]); /plan creates them in Google Calendar and sets created_in_calendar. Owner-only,
-- in no public view; nightly_roll keeps 30 days.
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  text text not null check (char_length(text) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  reply text check (char_length(reply) <= 280),
  tasks_added int not null default 0,
  events jsonb not null default '[]' check (jsonb_typeof(events) = 'array'),
  created_in_calendar boolean not null default false,
  fired_at timestamptz
);
create index if not exists messages_pending on messages (at) where status = 'pending';
-- Long messages: a pasted class announcement runs to thousands of characters (messageText).
alter table messages drop constraint if exists messages_text_check;
alter table messages add constraint messages_text_check check (char_length(text) between 1 and 8000);
-- A reply says what was added and what was skipped, and why (MAX_REPLY).
alter table messages drop constraint if exists messages_reply_check;
alter table messages add constraint messages_reply_check check (char_length(reply) <= 500);

alter table messages enable row level security;
drop policy if exists owner_all on messages;
create policy owner_all on messages for all using (is_owner()) with check (is_owner());
revoke all on messages from anon;

-- A message's events are busy times too, so the morning task and replans plan around them:
-- busy-sync and /plan's busy save skip The Sheet's own calendar, and replace only 'calendar'
-- rows. answer_message writes them with source 'message'; they go with their message (deleted,
-- or past nightly_roll's 30 days) or once they end. Two events at the same times share one row.
alter table busy drop constraint if exists busy_source_check;
alter table busy add constraint busy_source_check check (source in ('calendar', 'handshake', 'message'));
alter table busy add column if not exists message_id uuid references messages on delete cascade;

-- Answer pending message m in one transaction: its tasks added (new_tasks, [{ title, day, list,
-- due, at_time, est_min }]) at the end of their day or Someday list, with source 'message'; the
-- message done with its reply and events (each also a busy time), or failed when it added nothing (the reply says why).
-- Security invoker, so RLS applies to the caller (planner-mcp's owner-scoped client). It refuses
-- a message that isn't pending; checkAnswers (src/sheet/messages.mjs) checks the rest first.
-- Returns the message's new status.
create or replace function answer_message(m uuid, new_tasks jsonb, new_events jsonb, answer text) returns text
language plpgsql security invoker set search_path = public as $$
declare
  t record;
  n int := 0;
  added jsonb := '[]';
  task_id uuid;
  evs jsonb;
  result text;
begin
  perform 1 from messages where id = m and status = 'pending' for update;
  if not found then raise exception 'message % is not pending', m; end if;
  for t in select * from jsonb_to_recordset(coalesce(new_tasks, '[]')) as x(title text, day date, list text, due date, at_time time, est_min int, why text)
  loop
    insert into tasks (title, day, list, due, at_time, est_min, source, position)
    values (t.title, t.day, t.list, t.due, t.at_time, t.est_min, 'message',
      coalesce((select max(position) from tasks where day is not distinct from t.day and list is not distinct from t.list), 0) + 1)
    returning id into task_id;
    added := added || jsonb_build_array(jsonb_build_object('id', task_id, 'title', t.title, 'day', t.day, 'list', t.list,
      'due', t.due, 'at_time', to_char(t.at_time, 'HH24:MI'))
      || case when t.why is null then '{}' else jsonb_build_object('why', t.why) end);
    n := n + 1;
  end loop;
  -- Each event gets an id, for /plan's Undo.
  select coalesce(jsonb_agg(e || jsonb_build_object('id', gen_random_uuid())), '[]') into evs
  from jsonb_array_elements(coalesce(new_events, '[]')) as e;
  result := case when n > 0 or jsonb_array_length(evs) > 0 then 'done' else 'failed' end;
  update messages set status = result, reply = answer, tasks_added = n, tasks = added, events = evs, answered_at = now()
  where id = m;
  insert into busy (source, starts_at, ends_at, message_id)
  select 'message', x.starts_at, x.ends_at, m
  from jsonb_to_recordset(evs) as x(starts_at timestamptz, ends_at timestamptz)
  on conflict do nothing;
  return result;
end $$;
revoke execute on function answer_message(uuid, jsonb, jsonb, text) from public, anon;

-- What a message added, item by item, so /plan can list it and undo each one (docs/sheet-messages.md):
-- tasks is [{ id, title, day, list, due, at_time }] as added (the task may move later), and each
-- of events carries an id, and a gcal_id once /plan has made it in Google Calendar.
alter table messages add column if not exists tasks jsonb not null default '[]' check (jsonb_typeof(tasks) = 'array');

-- /plan made event `item` of message m in Google Calendar, as Google event `gcal`.
create or replace function message_event_created(m uuid, item uuid, gcal text) returns void
language sql security invoker set search_path = public as $$
  update messages set events = (
    select jsonb_agg(case when e ->> 'id' = item::text then e || jsonb_build_object('gcal_id', gcal) else e end order by i)
    from jsonb_array_elements(events) with ordinality as x(e, i))
  where id = m and events @> jsonb_build_array(jsonb_build_object('id', item::text));
$$;
revoke execute on function message_event_created(uuid, uuid, text) from public, anon;

-- Undo item `item` (a task's or an event's id) of message m: a task is deleted, an event comes
-- off the message and out of busy (another message's event at the same times keeps the time
-- busy). Either way it leaves the message's list. Returns the item with its kind ('task' or
-- 'event'; an event keeps its gcal_id, for /plan to delete from Google), or null when there is
-- nothing to undo. Security invoker: only the owner sees a message, so only he can undo.
create or replace function undo_message_item(m uuid, item uuid) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  msg messages;
  found_item jsonb;
  s timestamptz;
  e timestamptz;
begin
  select * into msg from messages where id = m for update;
  if not found then return null; end if;
  select x into found_item from jsonb_array_elements(msg.tasks) as x where x ->> 'id' = item::text;
  if found_item is not null then
    delete from tasks where id = item and source = 'message';
    update messages set tasks = (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(msg.tasks) as x where x ->> 'id' <> item::text),
      tasks_added = greatest(tasks_added - 1, 0)
    where id = m;
    return found_item || '{"kind": "task"}';
  end if;
  select x into found_item from jsonb_array_elements(msg.events) as x where x ->> 'id' = item::text;
  if found_item is null then return null; end if;
  update messages set events = (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(msg.events) as x where x ->> 'id' <> item::text)
  where id = m;
  s := (found_item ->> 'starts_at')::timestamptz;
  e := (found_item ->> 'ends_at')::timestamptz;
  if not exists (select 1 from messages, jsonb_array_elements(events) as x
                 where id = m and (x ->> 'starts_at')::timestamptz = s and (x ->> 'ends_at')::timestamptz = e) then
    delete from busy where source = 'message' and message_id = m and starts_at = s and ends_at = e;
    insert into busy (source, starts_at, ends_at, message_id)
    select 'message', s, e, o.id from messages o, jsonb_array_elements(o.events) as x
    where o.id <> m and (x ->> 'starts_at')::timestamptz = s and (x ->> 'ends_at')::timestamptz = e
    limit 1
    on conflict do nothing;
  end if;
  return found_item || '{"kind": "event"}';
end $$;
revoke execute on function undo_message_item(uuid, uuid) from public, anon;

-- Claude's progress on a message, for /plan while it works (docs/sheet-messages.md): steps
-- [{ at, kind, text }] (the message function's "Started Claude", planner-mcp's "Read your
-- planner" and "Saving", and those the run reports with report_step), the run's claude.ai
-- session_url from the fire, and answered_at, when answer_message wrote it. Each item's why
-- (Claude's note on how it placed it) rides in tasks and events.
alter table messages add column if not exists steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array');
alter table messages add column if not exists session_url text check (session_url like 'https://claude.ai/%');
alter table messages add column if not exists answered_at timestamptz;

-- Add one step to each pending message in ms, stamped now, up to 12 a message. Security
-- invoker: only the owner sees a message. checkStep (src/sheet/messages.mjs) checks the text.
create or replace function add_message_step(ms uuid[], step_kind text, words text) returns void
language sql security invoker set search_path = public as $$
  update messages set steps = steps || jsonb_build_array(jsonb_build_object('at', now(), 'kind', step_kind, 'text', words))
  where id = any(ms) and status = 'pending' and jsonb_array_length(steps) < 12;
$$;
revoke execute on function add_message_step(uuid[], text, text) from public, anon;

-- A message texted to the bot (docs/sheet-messages.md, "From Telegram"): tg_message_id is his
-- Telegram message, which the receipt replies to, and tg_receipt_at is when the telegram
-- function claimed the receipt (set before sending, back to null if Telegram refused it), so it
-- goes out once. Null for a message typed in /plan.
alter table messages add column if not exists tg_message_id bigint;
alter table messages add column if not exists tg_receipt_at timestamptz;
create index if not exists messages_tg_receipt on messages (answered_at) where tg_message_id is not null and tg_receipt_at is null;

-- The pinned Now message in Telegram (docs/sheet-nudges.md, "The pinned Now message"): the bot's
-- message id and the words it last showed, so the minute tick edits it only when they change.
-- Null until the first one is made, and again if Lisul deletes it.
alter table settings add column if not exists now_message_id bigint;
alter table settings add column if not exists now_text text;

-- --- Event to-dos (docs/sheet-v5.md, "Event to-dos") -----------------------------------------
-- Every Google Calendar event on a day is also a to-do in /plan's list. Only what the browser
-- can't get from Google is kept, by the event's key (calendar ID ":" event ID): done, hidden,
-- and title_ai, a concise title Claude wrote. No raw event title is ever stored. day is the
-- event's day (or the plan day Claude wrote it for), for retention. Owner-only, in no public
-- view; nightly_roll keeps 30 days after day.
create table if not exists event_todos (
  cal_event_key text primary key check (char_length(cal_event_key) between 3 and 1300),
  day date not null,
  title_ai text check (char_length(title_ai) between 1 and 80),
  done boolean not null default false,
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table event_todos enable row level security;
drop policy if exists owner_all on event_todos;
create policy owner_all on event_todos for all using (is_owner()) with check (is_owner());
revoke all on event_todos from anon;

drop trigger if exists event_todos_touch on event_todos;
create or replace function event_todos_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger event_todos_touch before update on event_todos for each row execute function event_todos_touch();

-- Claude's concise titles ([{ cal_event_key, title_ai }], checked first by checkEventTodos in
-- src/sheet/event-todos.mjs): a new event gets a row on day d; a known one gets only its
-- title_ai replaced, so done, hidden and day stay. Security invoker, so RLS applies to the caller
-- (planner-mcp's owner-scoped client).
create or replace function set_event_titles(d date, titles jsonb) returns int
language sql security invoker set search_path = public as $$
  with saved as (
    insert into event_todos (cal_event_key, day, title_ai)
    select x.cal_event_key, d, x.title_ai
    from jsonb_to_recordset(coalesce(titles, '[]')) as x(cal_event_key text, title_ai text)
    on conflict (cal_event_key) do update set title_ai = excluded.title_ai
    returning 1)
  select count(*)::int from saved $$;
revoke execute on function set_event_titles(date, jsonb) from public, anon;
grant execute on function set_event_titles(date, jsonb) to authenticated;
-- --- Oura: the plan starts when he wakes (docs/sheet-v5.md, "Oura") -------------------------
-- oura-connect connects his Oura account (OAuth2 with PKCE, scope daily); oura-sync reads his
-- sleep periods and daily readiness every 10 minutes. Only these fields are kept, 60 days
-- (nightly_roll), never shared, never sent to an AI model and never used to train anything (Oura's
-- API agreement, cloud.ouraring.com/legal/api-agreement; docs/adr/0005). Below: sleep times and
-- each day's numbers for /plan, Oura's bedtime window, workouts and Rest Mode, nothing else.
-- Oura's refresh tokens are single-use and rotate, so each refresh's new token is saved before
-- its access token is used (oura_token_save); both tokens live only in Vault.
create table if not exists oura_account (
  id boolean primary key default true check (id),
  refresh_secret_id uuid,
  access_secret_id uuid,
  access_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  synced_at timestamptz,             -- the last good sync; null until the first (which reads 21 days)
  last_error text                    -- a refused refresh: Settings shows Reconnect
);
-- One row per Oura sleep period, upserted by its Oura id (a period can be rewritten later).
create table if not exists sleep_nights (
  oura_id text primary key check (char_length(oura_id) <= 100),
  day date not null,                 -- Oura's day: the morning the sleep belongs to
  type text not null check (type in ('deleted', 'sleep', 'long_sleep', 'late_nap', 'rest')),
  bedtime_start timestamptz not null,
  bedtime_end timestamptz not null
);
create index if not exists sleep_nights_end on sleep_nights (bedtime_end);
-- One row per day: readiness (0-100) and the main sleep's total seconds, for the day's cap.
create table if not exists sleep_days (
  day date primary key,
  readiness int check (readiness between 0 and 100),
  sleep_s int check (sleep_s between 0 and 86400)
);
-- The day's Oura numbers that /plan shows him (never /now, never Claude: docs/adr/0005): the
-- sleep score, the main sleep's efficiency, deep and REM seconds, lowest and average heart rate
-- and average HRV, readiness's temperature deviation, the activity score and steps, and the
-- stress summary.
alter table sleep_days add column if not exists sleep_score int check (sleep_score between 0 and 100);
alter table sleep_days add column if not exists efficiency int check (efficiency between 1 and 100);
alter table sleep_days add column if not exists deep_s int check (deep_s between 0 and 86400);
alter table sleep_days add column if not exists rem_s int check (rem_s between 0 and 86400);
alter table sleep_days add column if not exists rhr_low int check (rhr_low between 20 and 250);
alter table sleep_days add column if not exists rhr_avg int check (rhr_avg between 20 and 250);
alter table sleep_days add column if not exists hrv_avg int check (hrv_avg between 0 and 500);
alter table sleep_days add column if not exists temp_dev numeric(4, 2) check (temp_dev between -10 and 10);
alter table sleep_days add column if not exists activity_score int check (activity_score between 0 and 100);
alter table sleep_days add column if not exists steps int check (steps between 0 and 200000);
alter table sleep_days add column if not exists stress text check (stress in ('restored', 'normal', 'stressful'));
-- Tips: the day's sleep and readiness score contributors, integers 0-100 by Oura's names only.
alter table sleep_days add column if not exists contributors jsonb check (contributors is null or jsonb_typeof(contributors) = 'object');
-- Ring workouts (scope workout): only strength-type and generic ones, and only their day, start,
-- end and activity; never calories, intensity or distance. Gym habit blocks they overlap end.
create table if not exists ring_workouts (
  oura_id text primary key check (char_length(oura_id) <= 100),
  day date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  activity text not null check (char_length(activity) <= 40)
);
-- Rest Mode: only each period's start and end days (end null while it is on).
create table if not exists rest_periods (
  oura_id text primary key check (char_length(oura_id) <= 100),
  start_day date not null,
  end_day date check (end_day >= start_day)
);
alter table ring_workouts enable row level security;
alter table rest_periods enable row level security;
drop policy if exists owner_all on ring_workouts;
drop policy if exists owner_all on rest_periods;
create policy owner_all on ring_workouts for all using (is_owner()) with check (is_owner());
create policy owner_all on rest_periods for all using (is_owner()) with check (is_owner());
revoke all on ring_workouts, rest_periods from anon;
revoke insert, update, delete on ring_workouts, rest_periods from authenticated;
-- Whether the grant reads workouts (null until tried; false: Settings asks to reconnect), and
-- whether the ring's battery was low at the last sync (the level itself is never kept).
alter table oura_account add column if not exists workouts_ok boolean;
alter table oura_account add column if not exists ring_low boolean;
alter table oura_account add column if not exists ring_checked_at timestamptz;
-- Wind-down: Oura's optimal bedtime window by its day (/v2/usercollection/sleep_time), only its
-- start and end as seconds from that day's midnight, for tonight's bedtime when none is set.
create table if not exists sleep_times (
  day date primary key,
  start_offset int not null check (start_offset between -86400 and 86400),
  end_offset int not null check (end_offset between -86400 and 86400)
);
alter table sleep_times add column if not exists hint text check (hint in ('improve_efficiency', 'earlier_bedtime', 'later_bedtime', 'earlier_wake_up_time', 'later_wake_up_time', 'follow_optimal_bedtime'));
alter table sleep_times enable row level security;
drop policy if exists owner_all on sleep_times;
create policy owner_all on sleep_times for all using (is_owner()) with check (is_owner());
revoke all on sleep_times from anon;
revoke insert, update, delete on sleep_times from authenticated;
-- Wind-down's settings (Settings, Oura): a bedtime target, whether to ease in toward it 15
-- minutes a night (bedtime_set_on is the night it was set, where easing starts), and the switch
-- for all of it (the planning limit, the Telegram nudges and /plan's marker).
alter table settings add column if not exists bedtime_target time;
alter table settings add column if not exists bedtime_ease boolean not null default true;
alter table settings add column if not exists bedtime_set_on date;
alter table settings add column if not exists wind_down_on boolean not null default true;
alter table oura_account enable row level security;
alter table sleep_nights enable row level security;
alter table sleep_days enable row level security;
drop policy if exists owner_all on oura_account;
drop policy if exists owner_all on sleep_nights;
drop policy if exists owner_all on sleep_days;
create policy owner_all on oura_account for all using (is_owner()) with check (is_owner());
create policy owner_all on sleep_nights for all using (is_owner()) with check (is_owner());
create policy owner_all on sleep_days for all using (is_owner()) with check (is_owner());
revoke all on oura_account, sleep_nights, sleep_days from anon;
-- The owner reads all three and deletes oura_account (Disconnect); only the server writes.
revoke insert, update on oura_account from authenticated;
revoke insert, update, delete on sleep_nights, sleep_days from authenticated;

-- Disconnecting deletes both tokens and every sleep row.
create or replace function oura_account_forget() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where id in (old.refresh_secret_id, old.access_secret_id);
  delete from sleep_nights where true;
  delete from sleep_days where true;
  delete from sleep_times where true;
  delete from ring_workouts where true;
  delete from rest_periods where true;
  return old;
end $$;
drop trigger if exists oura_account_forget on oura_account;
create trigger oura_account_forget after delete on oura_account for each row execute function oura_account_forget();
revoke execute on function oura_account_forget() from public, anon, authenticated;

-- Store a token pair: Vault secrets oura_refresh and oura_access, reused on every save. With
-- `old_refresh` (a refresh), only while the stored refresh token is still that one, so two runs
-- that rotate at once can't overwrite the newer token; it says whether it saved. Without it (a
-- connect), always, and the grant is no longer broken. A retried save of the same pair (its first
-- try saved but its reply was lost) saves again. Service key only.
create or replace function oura_token_save(refresh text, access text, expires_at timestamptz, old_refresh text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare r uuid; a uuid; stored text;
begin
  perform pg_advisory_xact_lock(hashtext('sheet.oura_token'));
  stored := (select s.decrypted_secret from oura_account o join vault.decrypted_secrets s on s.id = o.refresh_secret_id);
  if old_refresh is not null and stored is distinct from old_refresh and stored is distinct from refresh then
    return false;
  end if;
  select id into r from vault.secrets where name = 'oura_refresh';
  select id into a from vault.secrets where name = 'oura_access';
  if r is null then r := vault.create_secret(refresh, 'oura_refresh', 'Oura refresh token, scope daily (single-use)');
  else perform vault.update_secret(r, refresh); end if;
  if a is null then a := vault.create_secret(access, 'oura_access', 'Oura access token');
  else perform vault.update_secret(a, access); end if;
  insert into oura_account (id, refresh_secret_id, access_secret_id, access_expires_at, connected_at, last_error)
  values (true, r, a, expires_at, now(), null)
  on conflict (id) do update
  set refresh_secret_id = r, access_secret_id = a, access_expires_at = expires_at,
      connected_at = case when old_refresh is null then now() else oura_account.connected_at end,
      last_error = case when old_refresh is null then null else oura_account.last_error end;
  return true;
end $$;
revoke execute on function oura_token_save(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function oura_token_save(text, text, timestamptz, text) to service_role;

-- oura-sync's tokens: { refresh, access, expires_at, synced_at }, or null when nothing is connected.
create or replace function oura_tokens() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  return (select jsonb_build_object('refresh', r.decrypted_secret, 'access', a.decrypted_secret,
            'expires_at', o.access_expires_at, 'synced_at', o.synced_at)
          from oura_account o
          join vault.decrypted_secrets r on r.id = o.refresh_secret_id
          left join vault.decrypted_secrets a on a.id = o.access_secret_id);
end $$;
revoke execute on function oura_tokens() from public, anon, authenticated;
grant execute on function oura_tokens() to service_role;

-- oura-sync's write, in one transaction: the sleep periods upserted by oura_id ([{ oura_id, day,
-- type, bedtime_start, bedtime_end }]), the days ([{ day, readiness, sleep_s }], a null keeps
-- what was there), Oura's optimal bedtime windows ([{ day, start_offset, end_offset }]),
-- synced_at stamped, and the woke-late change inserted once per wake (its ref). Service key only.
-- extra: { workouts: [{ oura_id, day, starts_at, ends_at, activity }] or null when the grant
-- can't read them (workouts_ok false), rest: [{ oura_id, start_day, end_day }], ring_low: boolean
-- or null (no sample) }.
drop function if exists oura_sync_save(jsonb, jsonb, jsonb);
drop function if exists oura_sync_save(jsonb, jsonb, jsonb, jsonb);
create or replace function oura_sync_save(nights jsonb, days jsonb default '[]', change jsonb default null, times jsonb default '[]', extra jsonb default '{}')
returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into sleep_times (day, start_offset, end_offset, hint)
  select x.day, x.start_offset, x.end_offset, x.hint
  from jsonb_to_recordset(coalesce(times, '[]')) as x(day date, start_offset int, end_offset int, hint text)
  on conflict (day) do update set start_offset = excluded.start_offset, end_offset = excluded.end_offset, hint = excluded.hint;
  if extra ? 'workouts' then
    update oura_account set workouts_ok = jsonb_typeof(extra->'workouts') = 'array' where id;
    insert into ring_workouts (oura_id, day, starts_at, ends_at, activity)
    select x.oura_id, x.day, x.starts_at, x.ends_at, x.activity
    from jsonb_to_recordset(case when jsonb_typeof(extra->'workouts') = 'array' then extra->'workouts' else '[]' end)
      as x(oura_id text, day date, starts_at timestamptz, ends_at timestamptz, activity text)
    on conflict (oura_id) do update set day = excluded.day, starts_at = excluded.starts_at, ends_at = excluded.ends_at, activity = excluded.activity;
  end if;
  insert into rest_periods (oura_id, start_day, end_day)
  select x.oura_id, x.start_day, x.end_day
  from jsonb_to_recordset(coalesce(extra->'rest', '[]')) as x(oura_id text, start_day date, end_day date)
  on conflict (oura_id) do update set start_day = excluded.start_day, end_day = excluded.end_day;
  if extra ? 'ring_low' then
    update oura_account set ring_low = (extra->>'ring_low')::boolean, ring_checked_at = now() where id;
  end if;
  insert into sleep_nights (oura_id, day, type, bedtime_start, bedtime_end)
  select x.oura_id, x.day, x.type, x.bedtime_start, x.bedtime_end
  from jsonb_to_recordset(coalesce(nights, '[]')) as x(oura_id text, day date, type text, bedtime_start timestamptz, bedtime_end timestamptz)
  on conflict (oura_id) do update
  set day = excluded.day, type = excluded.type, bedtime_start = excluded.bedtime_start, bedtime_end = excluded.bedtime_end;
  insert into sleep_days (day, readiness, sleep_s, sleep_score, efficiency, deep_s, rem_s, rhr_low, rhr_avg, hrv_avg, temp_dev, activity_score, steps, stress, contributors)
  select x.day, x.readiness, x.sleep_s, x.sleep_score, x.efficiency, x.deep_s, x.rem_s, x.rhr_low, x.rhr_avg, x.hrv_avg, x.temp_dev, x.activity_score, x.steps, x.stress, x.contributors
  from jsonb_to_recordset(coalesce(days, '[]')) as x(day date, readiness int, sleep_s int, sleep_score int, efficiency int, deep_s int, rem_s int,
    rhr_low int, rhr_avg int, hrv_avg int, temp_dev numeric, activity_score int, steps int, stress text, contributors jsonb)
  on conflict (day) do update
  set readiness = coalesce(excluded.readiness, sleep_days.readiness), sleep_s = coalesce(excluded.sleep_s, sleep_days.sleep_s),
      sleep_score = coalesce(excluded.sleep_score, sleep_days.sleep_score), efficiency = coalesce(excluded.efficiency, sleep_days.efficiency),
      deep_s = coalesce(excluded.deep_s, sleep_days.deep_s), rem_s = coalesce(excluded.rem_s, sleep_days.rem_s),
      rhr_low = coalesce(excluded.rhr_low, sleep_days.rhr_low), rhr_avg = coalesce(excluded.rhr_avg, sleep_days.rhr_avg),
      hrv_avg = coalesce(excluded.hrv_avg, sleep_days.hrv_avg), temp_dev = coalesce(excluded.temp_dev, sleep_days.temp_dev),
      activity_score = coalesce(excluded.activity_score, sleep_days.activity_score), steps = coalesce(excluded.steps, sleep_days.steps),
      stress = coalesce(excluded.stress, sleep_days.stress), contributors = coalesce(excluded.contributors, sleep_days.contributors);
  update oura_account set synced_at = now(), last_error = null where id;
  if change is not null and not exists (select 1 from changes c where c.reason = change->>'reason' and c.ref = change->>'ref') then
    insert into changes (kind, reason, weight, ref)
    values (change->>'kind', change->>'reason', (change->>'weight')::int, change->>'ref');
  end if;
end $$;
revoke execute on function oura_sync_save(jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function oura_sync_save(jsonb, jsonb, jsonb, jsonb, jsonb) to service_role;

-- A refused refresh marks the grant broken (Settings shows Reconnect). Service key only.
create or replace function oura_broken(why text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update oura_account set last_error = left(why, 300) where id;
end $$;
revoke execute on function oura_broken(text) from public, anon, authenticated;
grant execute on function oura_broken(text) to service_role;

-- oura-connect keeps the PKCE code verifier with the state's nonce, never in the URL.
alter table mail_connect_states add column if not exists verifier text;

-- The window start a revision was planned from ("HH:MM"), for the woke-late replan.
alter table proposals add column if not exists window_from text check (window_from ~ '^([01]\d|2[0-3]):[0-5]\d$');

-- A woke-late change has kind 'sleep' (replan.mjs's woke_late).
alter table changes drop constraint if exists changes_kind_check;
alter table changes add constraint changes_kind_check
  check (kind in ('mail', 'busy', 'course', 'campus', 'github', 'jira', 'slack', 'handshake', 'sleep'));

-- Every 10 minutes, call oura-sync. Like sheet-busy, its URL and the shared secret come from
-- Vault; until both exist the job does nothing.
select cron.schedule('sheet-oura', '4-59/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_oura_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "oura"}'::jsonb,
    timeout_milliseconds := 30000)
  where exists (select 1 from vault.decrypted_secrets where name = 'sheet_cron_secret')
    and exists (select 1 from vault.decrypted_secrets where name = 'sheet_oura_url')
$job$);

-- --- Gym (docs/sheet-gym.md) ------------------------------------------------------------------
-- The /plan/gym/ lift tracker: a program (days, and the exercise prescribed in each slot), the
-- sessions and sets he logs, his spreadsheet's starting numbers, and swaps. Owner-only, in no
-- public view. The program itself is not in this repo: tools/gym-seed.mjs writes it from a local
-- JSON file. No coaching notes are stored anywhere. Sessions and sets take ids made on the phone,
-- so the offline outbox (src/sheet/gym-sync.mjs) resends them as upserts by id.
create table if not exists gym_exercises (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 80),
  "group" text check (char_length("group") <= 40),     -- a movement, e.g. 'horizontal press'
  unit text not null default 'lb' check (unit = 'lb'),
  step_lb numeric not null default 5 check (step_lb > 0 and step_lb <= 50),
  bar_lb numeric check (bar_lb > 0 and bar_lb <= 100),  -- barbell lifts: the plate chip
  created_at timestamptz not null default now()
);
-- A bodyweight exercise (pull-ups, dips) may log 0 lb added; any other never logs 0.
alter table gym_exercises add column if not exists bodyweight boolean not null default false;

create table if not exists gym_program_days (
  id uuid primary key default gen_random_uuid(),
  phase int not null check (phase > 0),
  week int not null check (week between 1 and 12),
  day_key text not null check (day_key ~ '^[a-z]+[0-9]$'),   -- 'push1' … 'legs2'
  name text not null check (char_length(name) between 1 and 40),
  position int not null,
  unique (phase, week, day_key)
);

create table if not exists gym_prescriptions (
  id uuid primary key default gen_random_uuid(),
  program_day_id uuid not null references gym_program_days on delete cascade,
  position int not null,
  exercise_id uuid not null references gym_exercises,
  warmup_sets text check (char_length(warmup_sets) <= 10),     -- '3-4'
  working_sets int not null check (working_sets between 1 and 10),
  reps text not null check (char_length(reps) between 1 and 10), -- '4-6'
  rep_min int check (rep_min between 1 and 100),
  rep_max int check (rep_max between 1 and 100 and rep_max >= rep_min),
  rpe text check (char_length(rpe) <= 10),                       -- '8-9'
  rpe_target numeric check (rpe_target between 1 and 10),
  rest_min_s int check (rest_min_s between 0 and 1200),
  rest_max_s int check (rest_max_s between 0 and 1200),
  sub1_exercise_id uuid references gym_exercises on delete set null,
  sub2_exercise_id uuid references gym_exercises on delete set null
);
create index if not exists gym_prescriptions_day on gym_prescriptions (program_day_id, position);

create table if not exists gym_sessions (
  id uuid primary key default gen_random_uuid(),
  program_day_id uuid references gym_program_days on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz check (finished_at >= started_at)
);

-- exercise_id is what he actually did (the prescribed one or a swap), so records stay per
-- exercise. Deleting a session deletes its sets; an exercise with sets can't be deleted.
create table if not exists gym_sets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references gym_sessions on delete cascade,
  prescription_id uuid references gym_prescriptions on delete set null,
  exercise_id uuid not null references gym_exercises,
  set_index int not null check (set_index between 0 and 50),
  warmup boolean not null default false,
  weight_lb numeric not null check (weight_lb >= 0 and weight_lb < 2000),
  reps int not null check (reps between 0 and 100),
  rpe numeric check (rpe between 1 and 10),
  done_at timestamptz not null default now()
);
create index if not exists gym_sets_session on gym_sets (session_id);
create index if not exists gym_sets_exercise on gym_sets (exercise_id, done_at);

-- His spreadsheet's numbers: starting points, never records until he confirms one.
create table if not exists gym_baselines (
  exercise_id uuid primary key references gym_exercises on delete cascade,
  weight_lb numeric check (weight_lb >= 0 and weight_lb < 2000),
  reps int check (reps between 1 and 100),
  note text check (char_length(note) <= 500),
  confirmed boolean not null default false
);

-- A swap in one slot: for today's session only, or for the rest of the phase (program_day_id
-- null: that day's slot in every week).
create table if not exists gym_swaps (
  id uuid primary key default gen_random_uuid(),
  program_day_id uuid references gym_program_days on delete cascade,
  prescription_id uuid not null references gym_prescriptions on delete cascade,
  exercise_id uuid not null references gym_exercises on delete cascade,
  scope text not null check (scope in ('today', 'phase')),
  session_id uuid references gym_sessions on delete cascade,
  created_at timestamptz not null default now(),
  check ((scope = 'today') = (session_id is not null))
);

alter table gym_exercises enable row level security;
alter table gym_program_days enable row level security;
alter table gym_prescriptions enable row level security;
alter table gym_sessions enable row level security;
alter table gym_sets enable row level security;
alter table gym_baselines enable row level security;
alter table gym_swaps enable row level security;
drop policy if exists owner_all on gym_exercises;
drop policy if exists owner_all on gym_program_days;
drop policy if exists owner_all on gym_prescriptions;
drop policy if exists owner_all on gym_sessions;
drop policy if exists owner_all on gym_sets;
drop policy if exists owner_all on gym_baselines;
drop policy if exists owner_all on gym_swaps;
create policy owner_all on gym_exercises for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_program_days for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_prescriptions for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_sessions for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_sets for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_baselines for all using (is_owner()) with check (is_owner());
create policy owner_all on gym_swaps for all using (is_owner()) with check (is_owner());
revoke all on gym_exercises, gym_program_days, gym_prescriptions, gym_sessions, gym_sets, gym_baselines, gym_swaps from anon;

-- --- Horizon planning (docs/sheet-horizon.md; ADR 0006) -------------------------------------
-- Every undone task with a due date gets planned minutes on each working day up to it, worked out
-- by src/sheet/horizon.mjs on the server. Future days hold minutes only, never times or Google
-- events. Owner-only, in no public view, written only through replace_horizon.
create table if not exists horizon_alloc (
  task_id uuid not null references tasks on delete cascade,
  day date not null,
  minutes int not null check (minutes > 0),
  over_min int not null default 0 check (over_min >= 0 and over_min <= minutes),  -- past the cap
  updated_at timestamptz not null default now(),
  primary key (task_id, day)
);
create index if not exists horizon_alloc_day on horizon_alloc (day);
create table if not exists horizon_state (
  task_id uuid primary key references tasks on delete cascade,
  state text not null check (state in ('on_track', 'tight', 'wont_fit')),
  slack_min int not null,
  short_min int not null default 0 check (short_min >= 0),
  remaining_min int not null check (remaining_min >= 0),
  finish_day date,
  target_day date not null,
  updated_at timestamptz not null default now()
);
-- The last re-flow: when, and the key of the inputs it planned from (a re-flow with the same key
-- is skipped).
alter table settings add column if not exists horizon_at timestamptz;
alter table settings add column if not exists horizon_key text check (char_length(horizon_key) <= 128);
-- Part 2: the last state Lisul was told of in Telegram (tight or won't fit), so each is told
-- once. replace_horizon leaves it as it is; the telegram function clears it once the task is back
-- on track. The horizon message logs as nudges kind 'horizon' (nudges_kind_check, above).
alter table horizon_state add column if not exists notified text check (notified in ('tight', 'wont_fit'));
alter table horizon_alloc enable row level security;
alter table horizon_state enable row level security;
drop policy if exists owner_all on horizon_alloc;
drop policy if exists owner_all on horizon_state;
create policy owner_all on horizon_alloc for all using (is_owner()) with check (is_owner());
create policy owner_all on horizon_state for all using (is_owner()) with check (is_owner());
revoke all on horizon_alloc, horizon_state from anon;

-- One re-flow, all or nothing: allocations from from_day on are replaced by `allocs` ([{ task_id,
-- day, minutes, over_min }]), rows from more than 30 days before it go, every task's state is
-- replaced by `states` ([{ task_id, state, slack_min, short_min, remaining_min, finish_day,
-- target_day }]), and settings records the run. Rows for a task that no longer exists are left
-- out. Security invoker, so RLS applies to the caller. Returns how many allocations it wrote.
create or replace function replace_horizon(from_day date, key text, allocs jsonb, states jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare n int;
begin
  delete from horizon_alloc a where a.day >= from_day or a.day < from_day - 30;
  insert into horizon_alloc (task_id, day, minutes, over_min)
  select x.task_id, x.day, x.minutes, coalesce(x.over_min, 0)
  from jsonb_to_recordset(coalesce(allocs, '[]')) as x(task_id uuid, day date, minutes int, over_min int)
  join tasks t on t.id = x.task_id
  where x.day >= from_day;
  get diagnostics n = row_count;
  delete from horizon_state s
  where s.task_id <> all (array(select (e->>'task_id')::uuid from jsonb_array_elements(coalesce(states, '[]')) e));
  insert into horizon_state (task_id, state, slack_min, short_min, remaining_min, finish_day, target_day)
  select x.task_id, x.state, x.slack_min, coalesce(x.short_min, 0), x.remaining_min, x.finish_day, x.target_day
  from jsonb_to_recordset(coalesce(states, '[]'))
    as x(task_id uuid, state text, slack_min int, short_min int, remaining_min int, finish_day date, target_day date)
  join tasks t on t.id = x.task_id
  on conflict (task_id) do update set state = excluded.state, slack_min = excluded.slack_min,
    short_min = excluded.short_min, remaining_min = excluded.remaining_min,
    finish_day = excluded.finish_day, target_day = excluded.target_day, updated_at = now();
  update settings set horizon_at = now(), horizon_key = key where id;
  return n;
end $$;
revoke execute on function replace_horizon(date, text, jsonb, jsonb) from public, anon;
grant execute on function replace_horizon(date, text, jsonb, jsonb) to authenticated, service_role;

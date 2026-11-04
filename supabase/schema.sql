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
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-rollover';
select cron.schedule('sheet-rollover', '5 * * * *', 'select public.nightly_roll()');

-- Every minute, call the telegram Edge Function to send what's due (docs/sheet-nudges.md). Its
-- URL and the shared secret it checks live in Vault, put there by tools/sheet-setup.sh, so no
-- secret is in this file; until they exist the job does nothing.
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-telegram';
select cron.schedule('sheet-telegram', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_telegram_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "send"}'::jsonb)
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
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-brightspace';
select cron.schedule('sheet-brightspace', '20 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_brightspace_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "sync"}'::jsonb)
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
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-campus';
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
  check (kind in ('brief', 'start', 'repeat', 'snooze', 'checkin', 'proposal'));

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
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-weather';
select cron.schedule('sheet-weather', '50 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_weather_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "weather"}'::jsonb)
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
  update settings set busy_as_of = from_at;
  if change is not null and to_regclass('public.changes') is not null then
    execute 'insert into changes (kind, reason, weight, ref) values ($1, $2, $3, $4)'
      using change->>'kind', change->>'reason', (change->>'weight')::int, change->>'ref';
  end if;
end $$;
revoke execute on function busy_sync_save(timestamptz, timestamptz, jsonb, jsonb) from public, anon, authenticated;

-- Every 10 minutes, call busy-sync. Like sheet-brightspace, its URL and the shared secret come
-- from Vault; until both exist the job does nothing.
select cron.unschedule(jobid) from cron.job where jobname = 'sheet-busy';
select cron.schedule('sheet-busy', '*/10 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_busy_url'),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sheet-cron',
      (select decrypted_secret from vault.decrypted_secrets where name = 'sheet_cron_secret')),
    body := '{"job": "busy"}'::jsonb)
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
create or replace function apply_proposal(d date, replaces int, blocks jsonb, habit_blocks jsonb default '[]',
  needs jsonb default '[]', picks jsonb default '[]', note text default null,
  couldnt_fit uuid[] default '{}', suggested jsonb default '[]',
  run_trigger text default 'morning', reasons text[] default '{}') returns int
language plpgsql security invoker set search_path = public as $$
declare
  newest proposals%rowtype;
  tz text := (select time_zone from settings);
  r int := coalesce(replaces, 0) + 1;
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
  insert into public.blocks (task_id, starts_at, ends_at, proposed)
  select x.task_id, x.starts_at, x.ends_at, true
  from jsonb_to_recordset(coalesce(apply_proposal.blocks, '[]')) as x(task_id uuid, starts_at timestamptz, ends_at timestamptz);
  if jsonb_array_length(coalesce(apply_proposal.habit_blocks, '[]')) > 0 then
    insert into public.blocks (habit_id, starts_at, ends_at, proposed)
    select x.habit_id, x.starts_at, x.ends_at, true
    from jsonb_to_recordset(apply_proposal.habit_blocks) as x(habit_id uuid, starts_at timestamptz, ends_at timestamptz);
  end if;
  insert into proposals (day, rev, created_at, status, note, picks, blocks, couldnt_fit, suggested, run_trigger, reasons)
  values (d, r, clock_timestamp(), 'pending', apply_proposal.note, coalesce(apply_proposal.picks, '[]'),
    (select coalesce(jsonb_agg(x order by x->>'starts_at'), '[]')
     from jsonb_array_elements(coalesce(apply_proposal.blocks, '[]') || coalesce(apply_proposal.habit_blocks, '[]')) x),
    coalesce(apply_proposal.couldnt_fit, '{}'), coalesce(apply_proposal.suggested, '[]'),
    coalesce(apply_proposal.run_trigger, 'morning'), coalesce(apply_proposal.reasons, '{}'));
  -- As in v4: a new revision replaces the day's open items, skipping any message already there.
  delete from needs_you n where n.day = d and not n.done;
  insert into needs_you (day, account, message_id, link, sender, subject, why, kind, due)
  select d, x.account, x.message_id, x.link, x.sender, x.subject, x.why, x.kind, x.due
  from jsonb_to_recordset(coalesce(apply_proposal.needs, '[]'))
    as x(account text, message_id text, link text, sender text, subject text, why text, kind text, due date)
  on conflict (account, message_id) do nothing;
  if to_regclass('public.changes') is not null then
    update changes c set consumed_day = d, consumed_rev = r
    where c.consumed_day is null and c.consumed_rev is null and c.at <= now();
  end if;
  return r;
end $$;
revoke execute on function apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[]) from public, anon;
grant execute on function apply_proposal(date, int, jsonb, jsonb, jsonb, jsonb, text, uuid[], jsonb, text, text[]) to authenticated;

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

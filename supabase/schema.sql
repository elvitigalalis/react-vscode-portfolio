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
-- earlier days' proposals lapse.
create or replace function nightly_roll() returns void
language plpgsql security definer set search_path = public as $$
declare today date := sheet_today();
begin
  perform lapse_proposals_before(today);
  perform roll_tasks(array(select id from tasks
    where day < today and not done and at_time is null), today);
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

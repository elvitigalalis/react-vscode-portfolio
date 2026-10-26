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
drop policy if exists owner_all on settings;
drop policy if exists owner_all on tasks;
drop policy if exists owner_all on blocks;
drop policy if exists owner_all on days;
create policy owner_all on settings for all using (is_owner()) with check (is_owner());
create policy owner_all on tasks for all using (is_owner()) with check (is_owner());
create policy owner_all on blocks for all using (is_owner()) with check (is_owner());
create policy owner_all on days for all using (is_owner()) with check (is_owner());
revoke all on settings, tasks, blocks, days from anon;

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

-- Delete the proposed blocks of the days before `before` (or of day `d` only): a proposal
-- lapses at the end of its day.
create or replace function lapse_proposals(d date, before boolean default false) returns void
language sql security definer set search_path = public as $$
  delete from blocks
  where proposed and case when before
    then (starts_at at time zone (select time_zone from settings))::date < d
    else (starts_at at time zone (select time_zone from settings))::date = d end
$$;
revoke execute on function lapse_proposals(date, boolean) from public, anon, authenticated;

-- Nightly (run hourly; a no-op once done): everything left behind rolls to today, and
-- earlier days' proposals lapse.
create or replace function nightly_roll() returns void
language plpgsql security definer set search_path = public as $$
declare today date := sheet_today();
begin
  perform lapse_proposals(today, true);
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
  perform lapse_proposals(d);
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

-- Set the owner: the Google account that signs in to /plan.
insert into settings (owner_email) values ('you@example.com')
on conflict (id) do nothing;

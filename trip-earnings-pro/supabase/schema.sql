-- Trip Earnings Pro — Supabase schema + Row Level Security
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
-- Every table is owned by auth.users.id; RLS guarantees a signed-in user can only read or
-- write rows whose user_id equals their own auth.uid(). The frontend only ever holds the
-- public anon key, which has no power without a valid user JWT once RLS is enabled.

create table if not exists public.trips (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ts          bigint not null,                 -- epoch ms, when the trip/tip happened
  from_loc    text not null default '',
  to_loc      text not null default '',
  fare        numeric(10,2) not null check (fare >= 0),
  extra       boolean not null default false,  -- true = tip (earnings only, never a trip)
  pay         text not null default 'cash',
  note        text not null default '',
  route_id    text,
  updated_at  bigint not null,                 -- epoch ms, last-write-wins merge key
  deleted     boolean not null default false   -- soft delete so other devices learn about it
);
create index if not exists trips_user_updated on public.trips (user_id, updated_at);

create table if not exists public.routes (
  id          text primary key,                -- preset ids like 'r1' or uuids for custom routes
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_loc    text not null,
  to_loc      text not null default '',
  fare        numeric(10,2) not null check (fare >= 0),
  updated_at  bigint not null,
  deleted     boolean not null default false
);
-- Preset ids are shared across users, so the primary key must include the user.
alter table public.routes drop constraint if exists routes_pkey;
alter table public.routes add primary key (user_id, id);
create index if not exists routes_user_updated on public.routes (user_id, updated_at);

create table if not exists public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  settings    jsonb not null default '{}'::jsonb,
  celebrated  jsonb not null default '{}'::jsonb,
  updated_at  bigint not null
);

-- ---------- Row Level Security ----------
alter table public.trips    enable row level security;
alter table public.routes   enable row level security;
alter table public.profiles enable row level security;

drop policy if exists "trips: own rows"    on public.trips;
drop policy if exists "routes: own rows"   on public.routes;
drop policy if exists "profiles: own row"  on public.profiles;

create policy "trips: own rows" on public.trips
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "routes: own rows" on public.routes
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "profiles: own row" on public.profiles
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- No policy for the anon role = anonymous requests see and write nothing.
revoke all on public.trips, public.routes, public.profiles from anon;
grant select, insert, update, delete on public.trips, public.routes, public.profiles to authenticated;

-- ---------- Quick RLS self-check (run while signed in via the API, or trust the policies above) ----------
-- select count(*) from public.trips;   -- as an authenticated user returns only their rows

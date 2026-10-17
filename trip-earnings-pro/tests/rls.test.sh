#!/usr/bin/env bash
# Spins up a throwaway local PostgreSQL 16, emulates Supabase's auth schema (auth.users, auth.uid(),
# roles anon/authenticated), applies supabase/schema.sql, then proves RLS isolation between two users.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN=/usr/lib/postgresql/16/bin; D=$(mktemp -d -p /tmp/pgtest); PORT=54329
export PGHOST=/tmp PGPORT=$PORT
cleanup(){ $PGBIN/pg_ctl -D "$D" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$D"; }
trap cleanup EXIT
RUNAS=""; if [ "$(id -u)" = 0 ]; then RUNAS="runuser -u nobody --"; chown nobody "$D"; fi
$RUNAS $PGBIN/initdb -D "$D" -U postgres -A trust >/dev/null
$RUNAS $PGBIN/pg_ctl -D "$D" -o "-p $PORT -k /tmp -c listen_addresses=''" -w start >/dev/null
psql -U postgres -v ON_ERROR_STOP=1 -q <<'SQL'
create role anon nologin; create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
insert into auth.users values ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
grant usage on schema public to anon, authenticated;
SQL
psql -U postgres -v ON_ERROR_STOP=1 -q -f "$ROOT/supabase/schema.sql"
echo "schema.sql applied cleanly"
psql -U postgres -v ON_ERROR_STOP=1 -q -tA <<'SQL'
-- User A inserts a trip and a preset route
set role authenticated; set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.trips (id, ts, from_loc, to_loc, fare, extra, updated_at) values ('aaaaaaaa-0000-0000-0000-000000000001', 1, 'Male''', 'Airport', 70, false, 1);
insert into public.routes (id, from_loc, to_loc, fare, updated_at) values ('r6', 'Male''', 'Airport', 70, 1);
insert into public.profiles (settings, updated_at) values ('{"target":1000}', 1);
select 'A sees ' || count(*) || ' trip(s)' from public.trips;
-- User B sees nothing and cannot touch A's rows
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'B sees ' || count(*) || ' trip(s), ' || (select count(*) from public.routes) || ' route(s), ' || (select count(*) from public.profiles) || ' profile(s)' from public.trips;
update public.trips set fare = 1 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select 'B update affected rows: ' || (select count(*) from public.trips where fare = 1);
delete from public.trips where id = 'aaaaaaaa-0000-0000-0000-000000000001';
-- B can create the same preset route id for themselves (composite PK)
insert into public.routes (id, from_loc, to_loc, fare, updated_at) values ('r6', 'Male''', 'Airport', 75, 2);
-- B's upsert with the app's conflict target works
insert into public.routes (id, from_loc, to_loc, fare, updated_at) values ('r6', 'Male''', 'Airport', 80, 3) on conflict (user_id, id) do update set fare = excluded.fare, updated_at = excluded.updated_at;
select 'B route fare now ' || fare from public.routes where id = 'r6';
-- B cannot forge another user's id
do $$ begin
  insert into public.trips (id, user_id, ts, fare, updated_at) values ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 1, 10, 1);
  raise exception 'FORGED INSERT SUCCEEDED';
exception when insufficient_privilege then raise notice 'forged user_id insert blocked by RLS (expected)'; end $$;
-- A's data is intact
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select 'A still has fare ' || fare || ' on ' || count(*) || ' trip(s)' from public.trips group by fare;
select 'A route fare still ' || fare from public.routes where id = 'r6';
-- anon sees nothing
reset role; set role anon;
do $$ begin perform count(*) from public.trips; raise exception 'ANON READ SUCCEEDED'; exception when insufficient_privilege then raise notice 'anon read blocked (expected)'; end $$;
SQL
echo "RLS checks passed"

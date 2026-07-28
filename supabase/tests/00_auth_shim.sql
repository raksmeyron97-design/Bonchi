-- =============================================================================
-- 00_auth_shim.sql — TEST HARNESS ONLY. Never applied to a real environment.
-- =============================================================================
-- Supabase provides `auth.users`, `auth.uid()`, the `authenticated`/`anon`/
-- `service_role` roles and the `storage` schema. This file recreates just enough
-- of that surface to run the migrations and the RLS suite against a plain
-- `postgres:16` container, so tenant isolation can be proven in CI without
-- booting the whole Supabase stack.
--
-- It lives in supabase/tests/ and is loaded only by scripts/db-test.sh. The
-- migrations in supabase/migrations/ never reference it.
-- =============================================================================

create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "citext" with schema extensions;

-- Supabase's roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, extensions, storage to anon, authenticated, service_role;

-- Mirrors the columns of the real auth.users that seed.sql populates, so a single
-- seed file works against both this shim and a real Supabase instance. GoTrue
-- requires aud, role and email_confirmed_at for a user to be able to sign in.
create table if not exists auth.users (
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  id uuid primary key default extensions.gen_random_uuid(),
  aud varchar(255) default 'authenticated',
  role varchar(255) default 'authenticated',
  email extensions.citext unique,
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- GoTrue scans these into non-nullable Go strings, so the real table needs them
  -- as empty strings. Mirrored here so one seed file works against both.
  confirmation_token varchar(255) default '',
  recovery_token varchar(255) default '',
  email_change_token_new varchar(255) default '',
  email_change_token_current varchar(255) default '',
  email_change varchar(255) default '',
  phone_change varchar(255) default '',
  phone_change_token varchar(255) default '',
  reauthentication_token varchar(255) default ''
);

-- Supabase derives the current user from the request's JWT claims, which
-- PostgREST puts in the `request.jwt.claims` GUC. Tests set that GUC directly,
-- which is exactly how the real function behaves.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    'anon'
  );
$$;

grant execute on function auth.uid, auth.role to anon, authenticated, service_role;

-- Minimal storage surface: enough for the bucket insert and the object policies.
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  owner_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists storage_objects_bucket_name_key
  on storage.objects (bucket_id, name);

grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Test helpers
-- ---------------------------------------------------------------------------

create schema if not exists test;

-- Impersonates a signed-in user exactly as PostgREST would.
create or replace function test.login(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text,
    true
  );
  execute 'set local role authenticated';
end;
$$;

create or replace function test.logout()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;

create or replace function test.reset_role()
returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'reset role';
end;
$$;

-- Asserts that a statement is refused, AND that it was refused for the expected
-- reason.
--
-- `p_expect` is required in practice: a test that accepts any error is worthless,
-- because a typo in the fixture will trip an unrelated constraint and the test
-- goes green while proving nothing. Passing null accepts any error and should be
-- reserved for cases where the message genuinely cannot be predicted.
create or replace function test.assert_raises(
  p_sql text,
  p_label text,
  p_expect text default null
)
returns void
language plpgsql
as $$
declare
  v_message text;
begin
  begin
    execute p_sql;
  exception
    when others then
      v_message := replace(sqlerrm, E'\n', ' ');
      if p_expect is not null and position(lower(p_expect) in lower(v_message)) = 0 then
        raise exception
          'FAIL  %  — blocked, but for the wrong reason. Expected a message containing "%", got "%"',
          p_label, p_expect, left(v_message, 200);
      end if;
      raise notice 'PASS  %', p_label;
      return;
  end;
  raise exception 'FAIL  %  — the statement was allowed but should have been refused', p_label;
end;
$$;

-- Asserts a query returns no rows. The core tenant-isolation assertion: RLS
-- filters silently rather than erroring, so "denied" looks like "empty".
create or replace function test.assert_no_rows(p_sql text, p_label text)
returns void
language plpgsql
as $$
declare
  v_count integer;
begin
  execute format('select count(*) from (%s) probe', p_sql) into v_count;
  if v_count <> 0 then
    raise exception 'FAIL  %  — expected no rows, got %', p_label, v_count;
  end if;
  raise notice 'PASS  %', p_label;
end;
$$;

-- Asserts a DML statement touched no rows.
--
-- Distinct from assert_no_rows because a data-modifying statement cannot be
-- wrapped in a subquery. This is the shape RLS denial takes on UPDATE: the
-- statement succeeds and silently affects nothing, rather than raising.
create or replace function test.assert_affects_no_rows(p_dml text, p_label text)
returns void
language plpgsql
as $$
declare
  v_count integer;
begin
  execute p_dml;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'FAIL  %  — expected 0 affected rows, got %', p_label, v_count;
  end if;
  raise notice 'PASS  %', p_label;
end;
$$;

create or replace function test.assert_row_count(p_sql text, p_expected integer, p_label text)
returns void
language plpgsql
as $$
declare
  v_count integer;
begin
  execute format('select count(*) from (%s) probe', p_sql) into v_count;
  if v_count <> p_expected then
    raise exception 'FAIL  %  — expected % rows, got %', p_label, p_expected, v_count;
  end if;
  raise notice 'PASS  %', p_label;
end;
$$;

create or replace function test.assert_equals(p_actual anyelement, p_expected anyelement, p_label text)
returns void
language plpgsql
as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL  %  — expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS  %', p_label;
end;
$$;

create or replace function test.assert_true(p_condition boolean, p_label text)
returns void
language plpgsql
as $$
begin
  if p_condition is not true then
    raise exception 'FAIL  %  — expected true, got %', p_label, coalesce(p_condition::text, 'null');
  end if;
  raise notice 'PASS  %', p_label;
end;
$$;

grant usage on schema test to anon, authenticated, service_role;
grant execute on all functions in schema test to anon, authenticated, service_role;

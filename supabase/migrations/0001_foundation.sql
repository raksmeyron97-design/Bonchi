-- =============================================================================
-- 0001_foundation.sql — extensions, private schema, shared helpers
-- =============================================================================
-- Conventions used by every later migration:
--
--   * UUID primary keys, generated client-side. A merchant recording a debt with
--     no signal must produce the final id offline, so the database accepts an id
--     rather than inventing one.
--   * All timestamps are `timestamptz` and stored in UTC. Calendar days that
--     belong to the merchant's own timezone (a repayment due date) are `date`.
--   * Helper functions live in the `bonchi` schema, are SECURITY DEFINER with a
--     pinned `search_path`, and are the only thing RLS policies call. Policies
--     that inline their logic drift apart; policies that share a function
--     cannot.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "citext" with schema extensions;

-- Private schema for helpers. Never exposed through the API.
create schema if not exists bonchi;
revoke all on schema bonchi from public;
grant usage on schema bonchi to authenticated, anon, service_role;

comment on schema bonchi is
  'Private helpers and authorization predicates. Not exposed via PostgREST.';

-- -----------------------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------------------

create type bonchi.organization_role as enum ('OWNER', 'MANAGER', 'CASHIER', 'VIEWER');
create type bonchi.membership_status as enum ('INVITED', 'ACTIVE', 'ARCHIVED');
create type bonchi.currency_code as enum ('KHR', 'USD');
create type bonchi.currency_usage as enum ('KHR_ONLY', 'USD_ONLY', 'BOTH');

create type bonchi.transaction_type as enum (
  'DEBT',
  'PAYMENT',
  'ADJUSTMENT',
  'REVERSAL',
  'OPENING_BALANCE'
);

create type bonchi.adjustment_direction as enum ('INCREASE', 'DECREASE');
create type bonchi.payment_method as enum ('CASH', 'BANK_TRANSFER', 'KHQR', 'OTHER');

create type bonchi.business_category as enum (
  'CLOTHING',
  'GROCERY',
  'GENERAL_STORE',
  'CONSTRUCTION_MATERIALS',
  'AGRICULTURAL_SUPPLY',
  'WHOLESALE',
  'BEAUTY_SERVICES',
  'ONLINE_SELLER',
  'RESTAURANT',
  'PHARMACY',
  'ELECTRONICS',
  'OTHER'
);

create type bonchi.attachment_kind as enum (
  'DEBT_EVIDENCE',
  'PRODUCT_PHOTO',
  'RECEIPT',
  'CUSTOMER_PHOTO',
  'SHOP_LOGO',
  'SIGNATURE'
);

create type bonchi.sync_state as enum (
  'LOCAL_ONLY',
  'PENDING',
  'SYNCING',
  'SYNCED',
  'FAILED',
  'CONFLICT'
);

create type bonchi.reminder_kind as enum (
  'DAY_BEFORE',
  'ON_DUE_DATE',
  'OVERDUE_FOLLOW_UP',
  'CUSTOM'
);

create type bonchi.lock_screen_detail as enum ('FULL', 'HIDE_CUSTOMER_AND_AMOUNT', 'NONE');

create type bonchi.subscription_status as enum (
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELLED',
  'SUSPENDED'
);

-- -----------------------------------------------------------------------------
-- Shared triggers
-- -----------------------------------------------------------------------------

create or replace function bonchi.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function bonchi.set_updated_at is
  'Maintains updated_at. Applied to every mutable table so a client cannot backdate it.';

-- The tenant boundary must be immovable. Without this, a member of two
-- organizations could pass RLS on both sides of an UPDATE and walk a customer
-- (and their whole debt history) from one shop into another.
create or replace function bonchi.freeze_organization_id()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id is distinct from old.organization_id then
    raise exception
      'organization_id is immutable (attempted % -> % on %)',
      old.organization_id, new.organization_id, tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function bonchi.freeze_organization_id is
  'Blocks re-parenting a row into another organization. Defence against tenant escape via UPDATE.';

create or replace function bonchi.reject_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Rows in % are append-only and cannot be deleted. Record a correcting entry instead.',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

comment on function bonchi.reject_delete is
  'Enforces append-only tables. Financial history is corrected by reversal, never by deletion.';

-- -----------------------------------------------------------------------------
-- Time helpers
-- -----------------------------------------------------------------------------

-- Overdue status must be decided in the merchant's timezone, not the server's
-- and not the device's. Everything that compares a due date goes through here.
create or replace function bonchi.merchant_today(p_time_zone text)
returns date
language sql
stable
as $$
  select (now() at time zone coalesce(nullif(p_time_zone, ''), 'Asia/Phnom_Penh'))::date;
$$;

comment on function bonchi.merchant_today is
  'Today''s calendar date in the given timezone. The only source of "today" for overdue logic.';

create or replace function bonchi.is_valid_time_zone(p_time_zone text)
returns boolean
language plpgsql
stable
as $$
begin
  perform now() at time zone p_time_zone;
  return true;
exception
  when others then
    return false;
end;
$$;

-- =============================================================================
-- 0002_identity.sql — users, organizations, membership, shops, devices
-- =============================================================================
-- The tenancy hierarchy:
--
--   auth.users -> profiles
--                 organizations
--                 organization_members (user x organization, with a role)
--                 shops               (an organization has one or more)
--                 devices             (a phone signed in to an organization)
--
-- The first release shows one shop per owner, but every business row already
-- carries organization_id, so multi-shop and staff accounts are a UI change
-- rather than a migration of live financial data.
-- =============================================================================

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  phone text check (phone is null or length(phone) between 6 and 24),
  locale text not null default 'km' check (locale in ('km', 'en')),
  avatar_attachment_id uuid,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per authenticated user. Holds no financial data.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function bonchi.set_updated_at();

-- -----------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  -- Every date comparison for this tenant resolves against this timezone.
  time_zone text not null default 'Asia/Phnom_Penh'
    check (bonchi.is_valid_time_zone(time_zone)),
  default_locale text not null default 'km' check (default_locale in ('km', 'en')),
  currency_usage bonchi.currency_usage not null default 'BOTH',
  created_by uuid not null references auth.users (id),
  -- Platform-level suspension. Merchants keep read access to their own data.
  suspended_at timestamptz,
  suspended_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.organizations is
  'A tenant. Owns shops, customers and the ledger. time_zone decides what "today" means.';

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function bonchi.set_updated_at();

-- -----------------------------------------------------------------------------

create table public.organization_members (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  -- Set while an invitation is outstanding, before the invitee has an account.
  invited_email extensions.citext,
  role bonchi.organization_role not null,
  status bonchi.membership_status not null default 'INVITED',
  invited_by uuid references auth.users (id),
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A membership is either attached to a user or waiting on an email, never neither.
  constraint organization_members_identity_present
    check (user_id is not null or invited_email is not null),
  -- An accepted membership must have a user.
  constraint organization_members_active_has_user
    check (status <> 'ACTIVE' or user_id is not null),
  constraint organization_members_archived_consistent
    check ((status = 'ARCHIVED') = (archived_at is not null))
);

comment on table public.organization_members is
  'Who may act inside an organization, and as what. ARCHIVED members keep their row so audit history can still name them, but lose all access.';

-- One membership per user per organization.
create unique index organization_members_unique_user
  on public.organization_members (organization_id, user_id)
  where user_id is not null;

create unique index organization_members_unique_invite
  on public.organization_members (organization_id, invited_email)
  where invited_email is not null and status = 'INVITED';

create index organization_members_user_idx
  on public.organization_members (user_id, status)
  where user_id is not null;

create index organization_members_org_idx
  on public.organization_members (organization_id, status);

create trigger organization_members_set_updated_at
  before update on public.organization_members
  for each row execute function bonchi.set_updated_at();

create trigger organization_members_freeze_org
  before update on public.organization_members
  for each row execute function bonchi.freeze_organization_id();

-- An organization with no owner can never be administered again, so the last
-- active owner cannot be demoted, archived or deleted.
create or replace function bonchi.protect_last_owner()
returns trigger
language plpgsql
as $$
declare
  v_remaining integer;
begin
  if old.role <> 'OWNER' or old.status <> 'ACTIVE' then
    return coalesce(new, old);
  end if;

  -- Still an active owner after this change? Nothing to protect.
  if tg_op = 'UPDATE' and new.role = 'OWNER' and new.status = 'ACTIVE' then
    return new;
  end if;

  select count(*) into v_remaining
  from public.organization_members
  where organization_id = old.organization_id
    and role = 'OWNER'
    and status = 'ACTIVE'
    and id <> old.id;

  if v_remaining = 0 then
    raise exception
      'Cannot remove or demote the last active owner of organization %.', old.organization_id
      using errcode = 'restrict_violation';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger organization_members_protect_last_owner
  before update or delete on public.organization_members
  for each row execute function bonchi.protect_last_owner();

-- -----------------------------------------------------------------------------

create table public.shops (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  business_category bonchi.business_category not null default 'OTHER',
  phone text check (phone is null or length(phone) between 6 and 24),
  address text check (address is null or length(address) <= 300),
  currency_usage bonchi.currency_usage not null default 'BOTH',
  time_zone text not null default 'Asia/Phnom_Penh'
    check (bonchi.is_valid_time_zone(time_zone)),
  logo_attachment_id uuid,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.shops is
  'A physical or online shop. Customers and transactions belong to exactly one shop.';

create index shops_organization_idx on public.shops (organization_id) where archived_at is null;

create trigger shops_set_updated_at
  before update on public.shops
  for each row execute function bonchi.set_updated_at();

create trigger shops_freeze_org
  before update on public.shops
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------

create table public.devices (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Human-recognizable in the "signed-in devices" list. No hardware identifier.
  label text not null check (length(trim(label)) between 1 and 80),
  platform text not null check (platform in ('android', 'ios', 'web')),
  app_version text,
  os_version text,
  push_token text,
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz,
  -- Set when the merchant signs this device out remotely.
  revoked_at timestamptz,
  revoked_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.devices is
  'A phone or tablet signed in to an organization. Identified by an app-generated UUID, never by a hardware id — we do not want a durable device fingerprint.';

create index devices_organization_idx on public.devices (organization_id, user_id);
create index devices_active_idx on public.devices (organization_id) where revoked_at is null;

create trigger devices_set_updated_at
  before update on public.devices
  for each row execute function bonchi.set_updated_at();

create trigger devices_freeze_org
  before update on public.devices
  for each row execute function bonchi.freeze_organization_id();

-- =============================================================================
-- 0003_customers.sql — customers and their contact details
-- =============================================================================
-- A customer needs a NAME and nothing else. Every other column is nullable
-- because the merchant recording a sale has a person waiting at the counter.
--
-- Customers are archived, never deleted: their transactions are financial
-- history and must survive.
-- =============================================================================

create table public.customers (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,

  name text not null check (length(trim(name)) between 1 and 120),

  -- Everything below is optional, by design.
  phone text check (phone is null or length(phone) between 6 and 24),
  -- E.164 form of `phone`, filled by the app. Used for search and dedupe hints.
  phone_normalized text,
  telegram text check (telegram is null or telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  address text check (address is null or length(address) <= 300),
  note text check (note is null or length(note) <= 1000),
  photo_attachment_id uuid,

  -- Short code a merchant can read aloud: "C-7K4QM".
  customer_code text check (customer_code is null or customer_code ~ '^C-[A-Z0-9]{4,8}$'),

  archived_at timestamptz,
  archived_by uuid references auth.users (id),
  archive_reason text check (archive_reason is null or length(archive_reason) <= 300),

  -- Offline provenance. `client_generated_id` equals `id`: the device mints it.
  device_id uuid references public.devices (id) on delete set null,
  created_by uuid references auth.users (id),
  -- Optimistic-concurrency token for editable metadata. Bumped by trigger.
  version integer not null default 1 check (version > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now()
);

comment on table public.customers is
  'A person who buys on credit. Only `name` is required. Archived rather than deleted so their ledger history survives.';

comment on column public.customers.version is
  'Incremented on every metadata edit. The client sends the version it read; a mismatch is a conflict the merchant resolves, not a silent overwrite.';

-- A customer code, where present, must be unique within the organization so it
-- can be quoted unambiguously over the phone.
create unique index customers_code_unique
  on public.customers (organization_id, customer_code)
  where customer_code is not null;

-- Customer lists and search always scope to one shop and exclude archived rows.
create index customers_shop_active_idx
  on public.customers (shop_id, name)
  where archived_at is null;

create index customers_organization_idx on public.customers (organization_id);

create index customers_phone_idx
  on public.customers (organization_id, phone_normalized)
  where phone_normalized is not null;

-- Server-side name search. The device does its own SQLite search offline; this
-- index serves the admin dashboard and any future web merchant view.
create index customers_name_search_idx
  on public.customers using gin (to_tsvector('simple', name));

create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function bonchi.set_updated_at();

create trigger customers_freeze_org
  before update on public.customers
  for each row execute function bonchi.freeze_organization_id();

-- Version is owned by the database, not the client: a client that forgets to
-- bump it must not be able to defeat conflict detection.
create or replace function bonchi.bump_customer_version()
returns trigger
language plpgsql
as $$
begin
  if (new.name, new.phone, new.telegram, new.address, new.note, new.photo_attachment_id)
     is distinct from
     (old.name, old.phone, old.telegram, old.address, old.note, old.photo_attachment_id)
  then
    new.version = old.version + 1;
  end if;
  return new;
end;
$$;

create trigger customers_bump_version
  before update on public.customers
  for each row execute function bonchi.bump_customer_version();

-- Customers are archived, never removed.
create trigger customers_no_delete
  before delete on public.customers
  for each row execute function bonchi.reject_delete();

-- -----------------------------------------------------------------------------
-- Additional contact channels
-- -----------------------------------------------------------------------------

create table public.customer_contacts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  kind text not null check (kind in ('PHONE', 'TELEGRAM', 'FACEBOOK', 'EMAIL', 'OTHER')),
  value text not null check (length(trim(value)) between 1 and 200),
  label text check (label is null or length(label) <= 60),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.customer_contacts is
  'Extra ways to reach a customer. Populated only when the merchant enters them — never harvested from the phone''s contact list.';

create index customer_contacts_customer_idx on public.customer_contacts (customer_id);

create unique index customer_contacts_one_primary
  on public.customer_contacts (customer_id, kind)
  where is_primary;

create trigger customer_contacts_set_updated_at
  before update on public.customer_contacts
  for each row execute function bonchi.set_updated_at();

create trigger customer_contacts_freeze_org
  before update on public.customer_contacts
  for each row execute function bonchi.freeze_organization_id();

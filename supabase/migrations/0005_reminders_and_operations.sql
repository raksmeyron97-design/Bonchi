-- =============================================================================
-- 0005_reminders_and_operations.sql
-- Reminders, notification preferences, installments, audit, sync bookkeeping,
-- subscriptions and feature flags.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Reminders (merchant-facing notifications)
-- -----------------------------------------------------------------------------
-- These schedule notifications to the MERCHANT. Nothing here messages a
-- customer: a reminder becomes a message only when the merchant reads it and
-- shares it themselves.

create table public.notification_preferences (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,

  day_before_enabled boolean not null default true,
  on_due_date_enabled boolean not null default true,
  overdue_follow_up_enabled boolean not null default true,
  reminder_hour smallint not null default 8 check (reminder_hour between 0 and 23),
  reminder_minute smallint not null default 0 check (reminder_minute between 0 and 59),
  overdue_follow_up_days smallint[] not null default array[1, 7]::smallint[],

  -- Defaults to hiding detail: a debt notification is readable by anyone who
  -- picks up the phone.
  lock_screen_detail bonchi.lock_screen_detail not null default 'HIDE_CUSTOMER_AND_AMOUNT',
  permission_granted_at timestamptz,
  permission_denied_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_preferences_unique unique (organization_id, user_id),
  constraint notification_preferences_follow_up_bounds
    check (array_length(overdue_follow_up_days, 1) is null or array_length(overdue_follow_up_days, 1) <= 5)
);

comment on table public.notification_preferences is
  'Per-user reminder settings. lock_screen_detail defaults to hiding the customer and amount.';

create trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function bonchi.set_updated_at();

create trigger notification_preferences_freeze_org
  before update on public.notification_preferences
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------

create table public.reminders (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,

  kind bonchi.reminder_kind not null,
  -- Merchant-local calendar day the reminder belongs to.
  on_date date not null,
  -- Resolved UTC instant handed to the OS scheduler.
  fire_at timestamptz not null,

  -- Local notification identifier, so it can be cancelled when the debt is paid.
  os_notification_id text,
  cancelled_at timestamptz,
  cancelled_reason text check (
    cancelled_reason is null
    or cancelled_reason in ('SETTLED', 'REVERSED', 'MERCHANT_DISABLED', 'RESCHEDULED')
  ),
  fired_at timestamptz,

  created_by uuid references auth.users (id),
  device_id uuid references public.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint reminders_unique_per_kind unique (transaction_id, kind, on_date)
);

comment on table public.reminders is
  'A scheduled nudge to the merchant. Cancelled as soon as the debt is settled or reversed — reminding someone to chase money already paid destroys trust in the app.';

create index reminders_pending_idx
  on public.reminders (organization_id, fire_at)
  where cancelled_at is null and fired_at is null;

create index reminders_transaction_idx on public.reminders (transaction_id);

create trigger reminders_set_updated_at
  before update on public.reminders
  for each row execute function bonchi.set_updated_at();

create trigger reminders_freeze_org
  before update on public.reminders
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------
-- Installments (schema only — the MVP does not expose an installment UI)
-- -----------------------------------------------------------------------------

create table public.installment_plans (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  currency bonchi.currency_code not null,
  total_minor bigint not null check (total_minor > 0),
  instalment_count smallint not null check (instalment_count between 2 and 60),
  -- No interest anywhere in this product. Documented as a constraint so a future
  -- change has to be deliberate rather than incidental.
  interest_minor bigint not null default 0 check (interest_minor = 0),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.installment_plans is
  'Reserved for a future instalment feature. interest_minor is constrained to zero: this is a record-keeping tool, not a lending product.';

create index installment_plans_customer_idx on public.installment_plans (customer_id);

create trigger installment_plans_freeze_org
  before update on public.installment_plans
  for each row execute function bonchi.freeze_organization_id();

create table public.installment_schedules (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id uuid not null references public.installment_plans (id) on delete cascade,
  sequence smallint not null check (sequence > 0),
  due_at date not null,
  amount_minor bigint not null check (amount_minor > 0),
  settled_at timestamptz,
  created_at timestamptz not null default now(),

  constraint installment_schedules_unique unique (plan_id, sequence)
);

create index installment_schedules_due_idx on public.installment_schedules (organization_id, due_at);

create trigger installment_schedules_freeze_org
  before update on public.installment_schedules
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------
-- Audit log (append-only)
-- -----------------------------------------------------------------------------

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_user_id uuid references auth.users (id) on delete set null,
  -- Denormalized so the log still names the actor after a membership is archived
  -- or a user row is removed.
  actor_label text,
  action text not null check (length(action) between 3 and 80),
  target_type text check (target_type is null or length(target_type) <= 60),
  target_id text check (target_id is null or length(target_id) <= 100),
  -- Safe metadata only: ids, counts, enum values. Never amounts, names, notes or
  -- tokens. See docs/security/threat-model.md.
  metadata jsonb not null default '{}'::jsonb,
  device_id uuid,
  ip_address inet,
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

comment on table public.audit_logs is
  'Append-only record of sensitive actions. metadata carries identifiers and counts only — never customer names, amounts or secrets.';

create index audit_logs_organization_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_user_id, created_at desc);
create index audit_logs_action_idx on public.audit_logs (action, created_at desc);

create trigger audit_logs_no_delete
  before delete on public.audit_logs
  for each row execute function bonchi.reject_delete();

-- An audit entry that can be edited is not an audit entry.
create or replace function bonchi.reject_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Rows in % cannot be updated.', tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

create trigger audit_logs_no_update
  before update on public.audit_logs
  for each row execute function bonchi.reject_update();

-- -----------------------------------------------------------------------------
-- Sync bookkeeping (server-side view of what devices have sent)
-- -----------------------------------------------------------------------------

create table public.sync_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  device_id uuid references public.devices (id) on delete set null,
  user_id uuid references auth.users (id) on delete set null,

  kind text not null check (length(kind) between 3 and 60),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  entity_type text not null,
  entity_id uuid,

  state bonchi.sync_state not null default 'PENDING',
  attempts integer not null default 0 check (attempts >= 0),
  -- Classification only ('TRANSIENT', 'CONFLICT', …), never a raw payload.
  last_error_kind text check (last_error_kind is null or length(last_error_kind) <= 40),
  last_error_at timestamptz,

  received_at timestamptz not null default now(),
  completed_at timestamptz,

  constraint sync_operations_unique_key unique (organization_id, idempotency_key)
);

comment on table public.sync_operations is
  'Server-side record of operations received from devices. Powers the sync-health view in the admin dashboard and makes a replayed key observable.';

create index sync_operations_device_idx on public.sync_operations (device_id, received_at desc);
create index sync_operations_failed_idx
  on public.sync_operations (organization_id, state)
  where state in ('FAILED', 'CONFLICT');

create trigger sync_operations_freeze_org
  before update on public.sync_operations
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------
-- Subscriptions and feature flags
-- -----------------------------------------------------------------------------

create table public.subscription_plans (
  id text primary key check (length(id) between 2 and 40),
  name text not null,
  price_minor bigint not null check (price_minor >= 0),
  currency bonchi.currency_code not null default 'USD',
  max_customers integer check (max_customers is null or max_customers > 0),
  max_members integer check (max_members is null or max_members > 0),
  features text[] not null default array[]::text[],
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.subscription_plans is 'Plan catalogue. Readable by any authenticated user.';

create table public.subscriptions (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id text not null references public.subscription_plans (id),
  status bonchi.subscription_status not null default 'TRIALING',
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint subscriptions_one_per_organization unique (organization_id)
);

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function bonchi.set_updated_at();

create trigger subscriptions_freeze_org
  before update on public.subscriptions
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------

create table public.feature_flags (
  key text primary key check (length(key) between 3 and 60),
  description text,
  -- Default for every organization.
  enabled_globally boolean not null default false,
  -- Organizations that override the global default.
  enabled_organization_ids uuid[] not null default array[]::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.feature_flags is
  'Server-controlled feature gates. `khqr_payments` stays off until real Bakong credentials and a verified integration exist.';

create trigger feature_flags_set_updated_at
  before update on public.feature_flags
  for each row execute function bonchi.set_updated_at();

insert into public.feature_flags (key, description, enabled_globally) values
  ('khqr_payments',
   'KHQR payment requests and verification. Requires official Bakong merchant credentials; a debt is never marked paid without server-verified confirmation.',
   false),
  ('staff_accounts', 'Invite managers, cashiers and viewers into an organization.', false),
  ('installments', 'Split a debt into scheduled instalments.', false),
  ('customer_statement_links', 'Share a customer statement through a secure expiring link.', false),
  ('contact_import', 'Import a single, explicitly chosen contact from the device.', false);

-- -----------------------------------------------------------------------------
-- Platform administration (Bonchi staff, not merchants)
-- -----------------------------------------------------------------------------

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('SUPPORT', 'ENGINEER', 'ADMIN')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id)
);

comment on table public.platform_admins is
  'Bonchi staff. Being listed here grants access to aggregate operational data only — never to a merchant''s customer records. Reading merchant data requires a support_access_grant.';

-- Merchant data is not browsable by staff. Reading it requires an explicit,
-- time-boxed, reason-carrying grant that is itself audited.
create table public.support_access_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  admin_user_id uuid not null references auth.users (id) on delete cascade,
  reason text not null check (length(trim(reason)) between 10 and 500),
  -- Who at the merchant approved it, when consent was captured in-app.
  approved_by_user_id uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),

  constraint support_access_grants_window check (expires_at > granted_at)
);

comment on table public.support_access_grants is
  'Time-boxed permission for one staff member to read one organization''s data, with a recorded reason. Expiry is enforced by bonchi.has_support_access().';

create index support_access_grants_active_idx
  on public.support_access_grants (organization_id, admin_user_id, expires_at)
  where revoked_at is null;

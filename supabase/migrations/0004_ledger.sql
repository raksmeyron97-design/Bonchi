-- =============================================================================
-- 0004_ledger.sql — the financial ledger
-- =============================================================================
-- Design rules, enforced here rather than trusted to application code:
--
--  1. Money is an integer in the currency's minor unit. `amount_minor bigint`.
--     KHR has exponent 0 (50,000 riel -> 50000); USD has exponent 2 ($12.50 ->
--     1250). There is no numeric/float money column anywhere.
--
--  2. `amount_minor` is always > 0. Direction comes from `transaction_type`,
--     never from a sign, so a negative amount cannot silently invert a balance.
--
--  3. Transactions are append-only. Financial columns cannot be updated and rows
--     cannot be deleted — both blocked by trigger. A mistake is corrected with a
--     REVERSAL plus a replacement.
--
--  4. KHR and USD never mix. Balances are per (customer, currency), and a
--     reversal must match its target's currency.
--
--  5. Every client-created row carries (client_generated_id, idempotency_key,
--     device_id). A unique index on the idempotency key makes a replayed offline
--     retry a no-op instead of a duplicate debt.
-- =============================================================================

-- A per-customer, per-currency account. Gives cached balances a stable home and
-- a natural row to lock when several payments land at once.
create table public.ledger_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  currency bonchi.currency_code not null,

  -- Cached aggregates. Always reproducible from `transactions`; see the
  -- `customer_balances` view and bonchi.verify_balances().
  total_charged_minor bigint not null default 0 check (total_charged_minor >= 0),
  total_paid_minor bigint not null default 0 check (total_paid_minor >= 0),
  outstanding_minor bigint not null default 0,
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  last_transaction_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ledger_accounts_unique unique (customer_id, currency)
);

comment on table public.ledger_accounts is
  'One account per customer per currency. Holds cached totals for fast list rendering; the transactions table remains the source of truth.';

comment on column public.ledger_accounts.outstanding_minor is
  'total_charged_minor - total_paid_minor, floored at 0. Overpayment lands in credit_minor instead of driving this negative.';

create index ledger_accounts_customer_idx on public.ledger_accounts (customer_id);
create index ledger_accounts_shop_idx on public.ledger_accounts (shop_id, currency);
create index ledger_accounts_outstanding_idx
  on public.ledger_accounts (shop_id, currency, outstanding_minor desc)
  where outstanding_minor > 0;

create trigger ledger_accounts_set_updated_at
  before update on public.ledger_accounts
  for each row execute function bonchi.set_updated_at();

create trigger ledger_accounts_freeze_org
  before update on public.ledger_accounts
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------
-- Transactions
-- -----------------------------------------------------------------------------

create table public.transactions (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  ledger_account_id uuid references public.ledger_accounts (id) on delete restrict,

  transaction_type bonchi.transaction_type not null,
  currency bonchi.currency_code not null,
  -- Integer minor units, strictly positive. See rules 1 and 2 above.
  amount_minor bigint not null check (amount_minor > 0),

  -- When it happened, in UTC. May be backdated by the merchant.
  occurred_at timestamptz not null default now(),
  -- The repayment day as a calendar date in the organization's timezone.
  -- Deliberately `date`, not `timestamptz`: "due on 30 July" must not shift.
  due_at date,

  adjustment_direction bonchi.adjustment_direction,
  payment_method bonchi.payment_method,

  description text check (description is null or length(description) <= 300),
  product_name text check (product_name is null or length(product_name) <= 160),
  quantity numeric(12, 3) check (quantity is null or quantity > 0),
  internal_note text check (internal_note is null or length(internal_note) <= 1000),
  customer_note text check (customer_note is null or length(customer_note) <= 500),
  reference_number text check (reference_number is null or length(reference_number) <= 60),

  parent_transaction_id uuid references public.transactions (id) on delete restrict,
  reversal_of_transaction_id uuid references public.transactions (id) on delete restrict,
  reversal_reason text check (reversal_reason is null or length(reversal_reason) between 3 and 500),

  -- Offline provenance and replay protection.
  client_generated_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  device_id uuid references public.devices (id) on delete set null,

  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),

  -- --- Shape constraints ----------------------------------------------------

  -- ADJUSTMENT is the only type whose direction is not implied by the type.
  constraint transactions_adjustment_direction
    check (
      (transaction_type = 'ADJUSTMENT' and adjustment_direction is not null)
      or (transaction_type <> 'ADJUSTMENT' and adjustment_direction is null)
    ),

  -- A REVERSAL must name its target and carry a reason; nothing else may.
  constraint transactions_reversal_shape
    check (
      (
        transaction_type = 'REVERSAL'
        and reversal_of_transaction_id is not null
        and reversal_reason is not null
      )
      or (
        transaction_type <> 'REVERSAL'
        and reversal_of_transaction_id is null
      )
    ),

  constraint transactions_no_self_reversal
    check (reversal_of_transaction_id is null or reversal_of_transaction_id <> id),

  -- A due date only means something on a charge. A payment has no due date.
  constraint transactions_due_at_only_on_charges
    check (due_at is null or transaction_type in ('DEBT', 'OPENING_BALANCE')),

  -- A payment method only means something on a payment.
  constraint transactions_payment_method_only_on_payments
    check (payment_method is null or transaction_type = 'PAYMENT'),

  -- The device mints the row id, so these must agree. Keeping the column
  -- explicit documents the provenance and lets the constraint prove it.
  constraint transactions_client_id_matches
    check (client_generated_id = id)
);

comment on table public.transactions is
  'Append-only financial ledger. Amounts are positive integers in minor units; direction comes from transaction_type. Corrections are REVERSAL rows, never edits.';

comment on column public.transactions.due_at is
  'Repayment day as a calendar date in the organization timezone. A date, not a timestamp, so it cannot shift across midnight.';

comment on column public.transactions.idempotency_key is
  'Stable across every retry of one logical operation. The unique index below is what makes an offline replay harmless.';

-- === The single most important index in this schema ==========================
-- A phone on a weak connection sends a debt, loses the response, and sends it
-- again. This turns that second write into a detectable duplicate instead of a
-- second debt the merchant never granted.
create unique index transactions_idempotency_unique
  on public.transactions (organization_id, idempotency_key);

-- A transaction can be reversed at most once.
create unique index transactions_one_reversal_per_target
  on public.transactions (reversal_of_transaction_id)
  where reversal_of_transaction_id is not null;

-- Customer timeline: newest first, paginated.
create index transactions_customer_timeline_idx
  on public.transactions (customer_id, occurred_at desc, id desc);

-- Balance replay for one account.
create index transactions_account_idx
  on public.transactions (ledger_account_id, occurred_at, id);

-- Shop-wide activity feeds and date-range reports.
create index transactions_shop_occurred_idx
  on public.transactions (shop_id, occurred_at desc);

-- Due-today and overdue lists. Partial: only unsettled charges can be due.
create index transactions_due_at_idx
  on public.transactions (organization_id, due_at)
  where due_at is not null and transaction_type in ('DEBT', 'OPENING_BALANCE');

create index transactions_reference_idx
  on public.transactions (organization_id, reference_number)
  where reference_number is not null;

create index transactions_created_by_idx
  on public.transactions (organization_id, created_by, occurred_at desc);

-- --- Immutability -----------------------------------------------------------

-- Financial columns are frozen after insert. `synced_at` and `ledger_account_id`
-- stay writable so the sync layer can do its bookkeeping without being able to
-- alter an amount.
create or replace function bonchi.enforce_transaction_immutability()
returns trigger
language plpgsql
as $$
begin
  if (
    new.id,
    new.organization_id,
    new.shop_id,
    new.customer_id,
    new.transaction_type,
    new.currency,
    new.amount_minor,
    new.occurred_at,
    new.due_at,
    new.adjustment_direction,
    new.reversal_of_transaction_id,
    new.client_generated_id,
    new.idempotency_key,
    new.created_by
  ) is distinct from (
    old.id,
    old.organization_id,
    old.shop_id,
    old.customer_id,
    old.transaction_type,
    old.currency,
    old.amount_minor,
    old.occurred_at,
    old.due_at,
    old.adjustment_direction,
    old.reversal_of_transaction_id,
    old.client_generated_id,
    old.idempotency_key,
    old.created_by
  ) then
    raise exception
      'Transaction % is immutable. Record a REVERSAL and a replacement instead of editing it.',
      old.id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger transactions_immutable
  before update on public.transactions
  for each row execute function bonchi.enforce_transaction_immutability();

create trigger transactions_no_delete
  before delete on public.transactions
  for each row execute function bonchi.reject_delete();

create trigger transactions_set_updated_at
  before update on public.transactions
  for each row execute function bonchi.set_updated_at();

-- --- Reversal integrity -----------------------------------------------------

-- Constraints cannot compare two rows, so the cross-row rules for a reversal
-- live here: same currency, same customer, exact amount, and never a reversal
-- of a reversal.
create or replace function bonchi.validate_reversal()
returns trigger
language plpgsql
as $$
declare
  v_target public.transactions;
begin
  if new.transaction_type <> 'REVERSAL' then
    return new;
  end if;

  select * into v_target
  from public.transactions
  where id = new.reversal_of_transaction_id
  for update;

  if not found then
    raise exception 'Reversal target % does not exist.', new.reversal_of_transaction_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_target.transaction_type = 'REVERSAL' then
    raise exception
      'Cannot reverse a REVERSAL (%). Record a new transaction instead.', v_target.id
      using errcode = 'check_violation';
  end if;

  if v_target.organization_id <> new.organization_id then
    raise exception 'A reversal cannot cross organizations.'
      using errcode = 'check_violation';
  end if;

  if v_target.customer_id <> new.customer_id then
    raise exception 'A reversal must belong to the same customer as its target.'
      using errcode = 'check_violation';
  end if;

  if v_target.currency <> new.currency then
    raise exception
      'Reversal currency (%) must match the target currency (%).', new.currency, v_target.currency
      using errcode = 'check_violation';
  end if;

  -- Partial corrections are ADJUSTMENTs. A reversal is all-or-nothing.
  if v_target.amount_minor <> new.amount_minor then
    raise exception
      'A reversal must carry the full amount of its target (% vs %).',
      new.amount_minor, v_target.amount_minor
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger transactions_validate_reversal
  before insert on public.transactions
  for each row execute function bonchi.validate_reversal();

-- -----------------------------------------------------------------------------
-- Explicit payment-to-debt allocations
-- -----------------------------------------------------------------------------
-- Recorded when the merchant chooses which debt a payment settles. Anything not
-- allocated explicitly is settled oldest-first by the FIFO logic in
-- bonchi.charge_settlements (and identically by @bonchi/domain on the device).

create table public.transaction_allocations (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- The payment (or other credit) providing the funds.
  credit_transaction_id uuid not null references public.transactions (id) on delete cascade,
  -- The debt being settled.
  charge_transaction_id uuid not null references public.transactions (id) on delete cascade,
  amount_minor bigint not null check (amount_minor > 0),
  created_at timestamptz not null default now(),

  constraint transaction_allocations_distinct
    check (credit_transaction_id <> charge_transaction_id),
  constraint transaction_allocations_unique
    unique (credit_transaction_id, charge_transaction_id)
);

comment on table public.transaction_allocations is
  'Merchant-directed link between a payment and a specific debt. Optional: unallocated credit is applied oldest-first.';

create index transaction_allocations_charge_idx
  on public.transaction_allocations (charge_transaction_id);
create index transaction_allocations_credit_idx
  on public.transaction_allocations (credit_transaction_id);

create trigger transaction_allocations_freeze_org
  before update on public.transaction_allocations
  for each row execute function bonchi.freeze_organization_id();

-- An allocation must join two transactions of the same customer and currency,
-- and must not exceed either side.
create or replace function bonchi.validate_allocation()
returns trigger
language plpgsql
as $$
declare
  v_credit public.transactions;
  v_charge public.transactions;
  v_allocated_from_credit bigint;
  v_allocated_to_charge bigint;
begin
  select * into v_credit from public.transactions where id = new.credit_transaction_id;
  select * into v_charge from public.transactions where id = new.charge_transaction_id;

  if v_credit is null or v_charge is null then
    raise exception 'Both sides of an allocation must exist.'
      using errcode = 'foreign_key_violation';
  end if;

  if v_credit.customer_id <> v_charge.customer_id then
    raise exception 'An allocation cannot span two customers.' using errcode = 'check_violation';
  end if;

  if v_credit.currency <> v_charge.currency then
    raise exception
      'An allocation cannot span currencies (% and %).', v_credit.currency, v_charge.currency
      using errcode = 'check_violation';
  end if;

  if v_credit.transaction_type not in ('PAYMENT', 'ADJUSTMENT') then
    raise exception 'Only a payment or adjustment can settle a debt.'
      using errcode = 'check_violation';
  end if;

  if v_charge.transaction_type not in ('DEBT', 'OPENING_BALANCE') then
    raise exception 'Only a debt or opening balance can be settled.'
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_minor), 0) into v_allocated_from_credit
  from public.transaction_allocations
  where credit_transaction_id = new.credit_transaction_id
    and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_allocated_from_credit + new.amount_minor > v_credit.amount_minor then
    raise exception
      'Allocations from payment % would exceed the payment amount.', new.credit_transaction_id
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount_minor), 0) into v_allocated_to_charge
  from public.transaction_allocations
  where charge_transaction_id = new.charge_transaction_id
    and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_allocated_to_charge + new.amount_minor > v_charge.amount_minor then
    raise exception
      'Allocations to debt % would exceed the debt amount.', new.charge_transaction_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger transaction_allocations_validate
  before insert or update on public.transaction_allocations
  for each row execute function bonchi.validate_allocation();

-- -----------------------------------------------------------------------------
-- Line items (optional detail on a debt)
-- -----------------------------------------------------------------------------

create table public.transaction_items (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 160),
  quantity numeric(12, 3) not null default 1 check (quantity > 0),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  line_total_minor bigint not null check (line_total_minor >= 0),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.transaction_items is
  'Optional itemization of a debt. Never authoritative: the transaction amount is what the customer owes.';

create index transaction_items_transaction_idx
  on public.transaction_items (transaction_id, position);

create trigger transaction_items_freeze_org
  before update on public.transaction_items
  for each row execute function bonchi.freeze_organization_id();

-- -----------------------------------------------------------------------------
-- Attachments
-- -----------------------------------------------------------------------------

create table public.attachments (
  id uuid primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  shop_id uuid references public.shops (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete cascade,
  transaction_id uuid references public.transactions (id) on delete cascade,

  kind bonchi.attachment_kind not null,
  -- Tenant-scoped object path inside the private bucket. Enforced by the
  -- storage policies in 0007_storage.sql, which require the path to begin with
  -- the organization id.
  storage_path text not null unique,
  mime_type text not null check (
    mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  ),
  byte_size bigint not null check (byte_size > 0 and byte_size <= 8388608),
  file_name text not null check (length(file_name) between 1 and 140),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),

  uploaded_by uuid references auth.users (id),
  device_id uuid references public.devices (id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id)
);

comment on table public.attachments is
  'Metadata for a private storage object. Files live in the tenant-scoped `attachments` bucket and are only ever served through short-lived signed URLs.';

comment on column public.attachments.storage_path is
  'Must start with the organization id — see the storage policies. This is what stops one shop reading another shop''s receipts.';

create index attachments_transaction_idx on public.attachments (transaction_id)
  where deleted_at is null;
create index attachments_customer_idx on public.attachments (customer_id)
  where deleted_at is null;
create index attachments_organization_idx on public.attachments (organization_id);

create trigger attachments_freeze_org
  before update on public.attachments
  for each row execute function bonchi.freeze_organization_id();

-- The storage path is the security boundary, so it may never be rewritten.
create or replace function bonchi.freeze_storage_path()
returns trigger
language plpgsql
as $$
begin
  if new.storage_path is distinct from old.storage_path then
    raise exception 'attachments.storage_path is immutable.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger attachments_freeze_path
  before update on public.attachments
  for each row execute function bonchi.freeze_storage_path();

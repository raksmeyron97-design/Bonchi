-- =============================================================================
-- 0008_balances_and_audit.sql
-- Derived balances, the cached-balance maintenance trigger, consistency
-- verification, and audit helpers.
-- =============================================================================
-- The authoritative balance is always derived from `transactions`. The cached
-- totals on `ledger_accounts` exist so a list of thousands of customers renders
-- instantly; `bonchi.verify_balances()` proves the cache still agrees with the
-- ledger, and the diagnostics screen surfaces any drift.
--
-- The allocation model implemented here is identical to `allocate()` in
-- packages/domain/src/ledger/allocation.ts:
--
--   1. Reversal pairs (a reversed transaction and the REVERSAL that cancels it)
--      drop out of the economic picture entirely. Both rows stay in history.
--   2. Explicit merchant allocations are honoured first.
--   3. Whatever credit remains settles the oldest unpaid debts first.
--   4. Credit beyond the total debt is held as `credit_minor`, never as a
--      negative balance.
--
-- Step 3 is expressed with window functions rather than a loop: for charges in
-- age order, the amount settled by free credit is
--     clamp(free_credit - (remaining owed by older charges), 0, this charge's remainder)
-- which is exactly what FIFO produces, because credit is fungible.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Active (non-reversed) transactions
-- -----------------------------------------------------------------------------

create or replace view public.active_transactions
with (security_invoker = true) as
select t.*
from public.transactions t
where t.transaction_type <> 'REVERSAL'
  and not exists (
    select 1
    from public.transactions r
    where r.reversal_of_transaction_id = t.id
  );

comment on view public.active_transactions is
  'Transactions that still have economic effect: excludes REVERSAL rows and anything a reversal has cancelled. security_invoker keeps the caller''s RLS in force.';

-- -----------------------------------------------------------------------------
-- Per-charge settlement
-- -----------------------------------------------------------------------------

create or replace view public.charge_settlements
with (security_invoker = true) as
with charges as (
  select
    t.id,
    t.organization_id,
    t.shop_id,
    t.customer_id,
    t.currency,
    t.amount_minor,
    t.occurred_at,
    t.due_at,
    -- Credit the merchant explicitly directed at this debt.
    coalesce(
      (
        select sum(a.amount_minor)
        from public.transaction_allocations a
        join public.active_transactions credit on credit.id = a.credit_transaction_id
        where a.charge_transaction_id = t.id
      ),
      0
    )::bigint as explicit_settled_minor
  from public.active_transactions t
  where t.transaction_type in ('DEBT', 'OPENING_BALANCE')
),
charges_with_remainder as (
  select
    c.*,
    (c.amount_minor - c.explicit_settled_minor) as remainder_after_explicit
  from charges c
),
credit_totals as (
  select
    t.customer_id,
    t.currency,
    coalesce(sum(t.amount_minor), 0)::bigint as total_credit_minor
  from public.active_transactions t
  where t.transaction_type = 'PAYMENT'
     or (t.transaction_type = 'ADJUSTMENT' and t.adjustment_direction = 'DECREASE')
  group by t.customer_id, t.currency
),
explicit_totals as (
  select
    credit.customer_id,
    credit.currency,
    coalesce(sum(a.amount_minor), 0)::bigint as explicit_total_minor
  from public.transaction_allocations a
  join public.active_transactions credit on credit.id = a.credit_transaction_id
  join public.active_transactions charge on charge.id = a.charge_transaction_id
  group by credit.customer_id, credit.currency
),
free_credit as (
  select
    ct.customer_id,
    ct.currency,
    greatest(ct.total_credit_minor - coalesce(et.explicit_total_minor, 0), 0)::bigint as free_credit_minor
  from credit_totals ct
  left join explicit_totals et
    on et.customer_id = ct.customer_id
   and et.currency = ct.currency
),
ordered as (
  select
    c.*,
    -- Remaining owed by strictly older charges. Ordering is (occurred_at, id) so
    -- the result is deterministic when two debts share a timestamp — the same
    -- tie-break the TypeScript engine uses.
    coalesce(
      sum(c.remainder_after_explicit) over (
        partition by c.customer_id, c.currency
        order by c.occurred_at, c.id
        rows between unbounded preceding and 1 preceding
      ),
      0
    )::bigint as older_remainder_minor
  from charges_with_remainder c
)
select
  o.id as charge_transaction_id,
  o.organization_id,
  o.shop_id,
  o.customer_id,
  o.currency,
  o.amount_minor as original_minor,
  o.occurred_at,
  o.due_at,
  (
    o.explicit_settled_minor
    + least(
        greatest(coalesce(fc.free_credit_minor, 0) - o.older_remainder_minor, 0),
        o.remainder_after_explicit
      )
  )::bigint as settled_minor,
  (
    o.remainder_after_explicit
    - least(
        greatest(coalesce(fc.free_credit_minor, 0) - o.older_remainder_minor, 0),
        o.remainder_after_explicit
      )
  )::bigint as remaining_minor
from ordered o
left join free_credit fc
  on fc.customer_id = o.customer_id
 and fc.currency = o.currency;

comment on view public.charge_settlements is
  'How much of each debt is settled and how much remains. Mirrors allocate() in @bonchi/domain: explicit allocations first, then oldest-first FIFO.';

-- -----------------------------------------------------------------------------
-- Derived customer balances
-- -----------------------------------------------------------------------------

create or replace view public.customer_balances
with (security_invoker = true) as
with charge_totals as (
  select
    customer_id,
    currency,
    sum(amount_minor)::bigint as total_charged_minor
  from public.active_transactions
  where transaction_type in ('DEBT', 'OPENING_BALANCE')
     or (transaction_type = 'ADJUSTMENT' and adjustment_direction = 'INCREASE')
  group by customer_id, currency
),
credit_totals as (
  select
    customer_id,
    currency,
    sum(amount_minor)::bigint as total_paid_minor
  from public.active_transactions
  where transaction_type = 'PAYMENT'
     or (transaction_type = 'ADJUSTMENT' and adjustment_direction = 'DECREASE')
  group by customer_id, currency
),
settlement_rollup as (
  select
    s.customer_id,
    s.currency,
    sum(s.remaining_minor)::bigint as outstanding_minor,
    count(*) filter (where s.remaining_minor > 0) as unpaid_charge_count,
    -- Overdue is decided against the ORGANIZATION's today, never the server's
    -- date or a device's.
    sum(
      case
        when s.remaining_minor > 0
         and s.due_at is not null
         and s.due_at < bonchi.merchant_today(o.time_zone)
        then s.remaining_minor
        else 0
      end
    )::bigint as overdue_minor,
    count(*) filter (
      where s.remaining_minor > 0
        and s.due_at is not null
        and s.due_at < bonchi.merchant_today(o.time_zone)
    ) as overdue_charge_count,
    min(
      case
        when s.remaining_minor > 0
         and s.due_at is not null
         and s.due_at >= bonchi.merchant_today(o.time_zone)
        then s.due_at
      end
    ) as next_due_at,
    min(
      case
        when s.remaining_minor > 0
         and s.due_at is not null
         and s.due_at < bonchi.merchant_today(o.time_zone)
        then s.due_at
      end
    ) as earliest_overdue_at
  from public.charge_settlements s
  join public.organizations o on o.id = s.organization_id
  group by s.customer_id, s.currency
),
last_activity as (
  select customer_id, currency, max(occurred_at) as last_transaction_at
  from public.transactions
  group by customer_id, currency
),
pairs as (
  select customer_id, currency from charge_totals
  union
  select customer_id, currency from credit_totals
)
select
  c.organization_id,
  c.shop_id,
  p.customer_id,
  p.currency,
  coalesce(ct.total_charged_minor, 0) as total_charged_minor,
  coalesce(cr.total_paid_minor, 0) as total_paid_minor,
  coalesce(sr.outstanding_minor, 0) as outstanding_minor,
  coalesce(sr.overdue_minor, 0) as overdue_minor,
  -- Overpayment is held as credit rather than pushing the balance negative.
  greatest(
    coalesce(cr.total_paid_minor, 0)
      - (coalesce(ct.total_charged_minor, 0) - coalesce(sr.outstanding_minor, 0)),
    0
  ) as credit_minor,
  coalesce(sr.unpaid_charge_count, 0) as unpaid_charge_count,
  coalesce(sr.overdue_charge_count, 0) as overdue_charge_count,
  sr.next_due_at,
  sr.earliest_overdue_at,
  la.last_transaction_at
from pairs p
join public.customers c on c.id = p.customer_id
left join charge_totals ct on ct.customer_id = p.customer_id and ct.currency = p.currency
left join credit_totals cr on cr.customer_id = p.customer_id and cr.currency = p.currency
left join settlement_rollup sr on sr.customer_id = p.customer_id and sr.currency = p.currency
left join last_activity la on la.customer_id = p.customer_id and la.currency = p.currency;

comment on view public.customer_balances is
  'Authoritative per-customer, per-currency balance derived from the ledger. KHR and USD are separate rows and are never combined.';

-- -----------------------------------------------------------------------------
-- Cached balance maintenance
-- -----------------------------------------------------------------------------

-- Recomputes one account's cached totals from the ledger. Recomputing rather than
-- incrementing is deliberate: an incremental update that misses a case leaves a
-- balance permanently wrong, while a full recompute is self-healing.
create or replace function bonchi.refresh_ledger_account(
  p_customer_id uuid,
  p_currency bonchi.currency_code
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_balance record;
begin
  select * into v_customer from public.customers where id = p_customer_id;
  if not found then
    return;
  end if;

  select
    coalesce(b.total_charged_minor, 0) as total_charged_minor,
    coalesce(b.total_paid_minor, 0) as total_paid_minor,
    coalesce(b.outstanding_minor, 0) as outstanding_minor,
    coalesce(b.credit_minor, 0) as credit_minor,
    b.last_transaction_at
  into v_balance
  from public.customer_balances b
  where b.customer_id = p_customer_id
    and b.currency = p_currency;

  insert into public.ledger_accounts (
    organization_id, shop_id, customer_id, currency,
    total_charged_minor, total_paid_minor, outstanding_minor, credit_minor,
    last_transaction_at
  )
  values (
    v_customer.organization_id, v_customer.shop_id, p_customer_id, p_currency,
    coalesce(v_balance.total_charged_minor, 0),
    coalesce(v_balance.total_paid_minor, 0),
    coalesce(v_balance.outstanding_minor, 0),
    coalesce(v_balance.credit_minor, 0),
    v_balance.last_transaction_at
  )
  on conflict (customer_id, currency) do update
    set total_charged_minor = excluded.total_charged_minor,
        total_paid_minor = excluded.total_paid_minor,
        outstanding_minor = excluded.outstanding_minor,
        credit_minor = excluded.credit_minor,
        last_transaction_at = excluded.last_transaction_at,
        updated_at = now();
end;
$$;

comment on function bonchi.refresh_ledger_account is
  'Recomputes a cached balance from the ledger. Full recompute, not an increment, so the cache is self-healing.';

-- A reversal changes the standing of its target as well as itself, so both
-- accounts are refreshed.
create or replace function bonchi.on_transaction_written()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.transactions;
begin
  perform bonchi.refresh_ledger_account(new.customer_id, new.currency);

  if new.transaction_type = 'REVERSAL' and new.reversal_of_transaction_id is not null then
    select * into v_target from public.transactions where id = new.reversal_of_transaction_id;
    if found and (v_target.customer_id, v_target.currency) is distinct from (new.customer_id, new.currency) then
      perform bonchi.refresh_ledger_account(v_target.customer_id, v_target.currency);
    end if;
  end if;

  return new;
end;
$$;

create trigger transactions_refresh_balance
  after insert on public.transactions
  for each row execute function bonchi.on_transaction_written();

-- An explicit allocation changes which debt is settled, so the cache must follow.
create or replace function bonchi.on_allocation_written()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_charge public.transactions;
begin
  select * into v_charge from public.transactions where id = new.charge_transaction_id;
  if found then
    perform bonchi.refresh_ledger_account(v_charge.customer_id, v_charge.currency);
  end if;
  return new;
end;
$$;

create trigger transaction_allocations_refresh_balance
  after insert or update on public.transaction_allocations
  for each row execute function bonchi.on_allocation_written();

-- Links a transaction to its ledger account, creating the account if needed.
create or replace function bonchi.attach_ledger_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer public.customers;
  v_account_id uuid;
begin
  if new.ledger_account_id is not null then
    return new;
  end if;

  select * into v_customer from public.customers where id = new.customer_id;
  if not found then
    raise exception 'Customer % does not exist.', new.customer_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into public.ledger_accounts (organization_id, shop_id, customer_id, currency)
  values (v_customer.organization_id, v_customer.shop_id, new.customer_id, new.currency)
  on conflict (customer_id, currency) do update set updated_at = now()
  returning id into v_account_id;

  new.ledger_account_id := v_account_id;
  return new;
end;
$$;

create trigger transactions_attach_account
  before insert on public.transactions
  for each row execute function bonchi.attach_ledger_account();

-- -----------------------------------------------------------------------------
-- Consistency verification
-- -----------------------------------------------------------------------------

create or replace function public.verify_balances(p_organization_id uuid)
returns table (
  customer_id uuid,
  currency bonchi.currency_code,
  cached_minor bigint,
  derived_minor bigint,
  delta_minor bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    coalesce(la.customer_id, cb.customer_id) as customer_id,
    coalesce(la.currency, cb.currency) as currency,
    coalesce(la.outstanding_minor, 0) as cached_minor,
    coalesce(cb.outstanding_minor, 0) as derived_minor,
    coalesce(la.outstanding_minor, 0) - coalesce(cb.outstanding_minor, 0) as delta_minor
  from public.ledger_accounts la
  full outer join public.customer_balances cb
    on cb.customer_id = la.customer_id
   and cb.currency = la.currency
  where coalesce(la.organization_id, cb.organization_id) = p_organization_id
    and coalesce(la.outstanding_minor, 0) <> coalesce(cb.outstanding_minor, 0);
$$;

comment on function public.verify_balances is
  'Returns only rows where the cached balance disagrees with the ledger. An empty result is the healthy state; anything else means recompute, never trust the cache.';

-- Rebuilds every cached balance for an organization. Used after a restore and
-- available to support when drift is found.
create or replace function public.rebuild_ledger_accounts(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_count integer := 0;
begin
  if not bonchi.is_owner(p_organization_id) and not bonchi.is_platform_admin() then
    raise exception 'Only an organization owner may rebuild balances.'
      using errcode = 'insufficient_privilege';
  end if;

  for v_row in
    select distinct t.customer_id, t.currency
    from public.transactions t
    where t.organization_id = p_organization_id
  loop
    perform bonchi.refresh_ledger_account(v_row.customer_id, v_row.currency);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Shop dashboard roll-up
-- -----------------------------------------------------------------------------

create or replace view public.shop_totals
with (security_invoker = true) as
select
  b.organization_id,
  b.shop_id,
  b.currency,
  sum(b.outstanding_minor)::bigint as outstanding_minor,
  sum(b.overdue_minor)::bigint as overdue_minor,
  count(*) filter (where b.outstanding_minor > 0) as customers_with_outstanding,
  count(*) filter (where b.overdue_minor > 0) as customers_overdue
from public.customer_balances b
group by b.organization_id, b.shop_id, b.currency;

comment on view public.shop_totals is
  'Dashboard roll-up, one row per currency. There is deliberately no combined total: KHR and USD are separate obligations.';

-- -----------------------------------------------------------------------------
-- Audit helper
-- -----------------------------------------------------------------------------

-- Writes an audit entry with the actor pinned to the caller. Callers cannot
-- forge an entry against another user, and cannot suppress one.
create or replace function public.write_audit_log(
  p_organization_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_device_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id bigint;
  v_actor_label text;
  v_safe_metadata jsonb;
begin
  if p_organization_id is not null and not bonchi.is_active_member(p_organization_id) then
    raise exception 'Cannot write an audit entry for an organization you do not belong to.'
      using errcode = 'insufficient_privilege';
  end if;

  select display_name into v_actor_label from public.profiles where id = auth.uid();

  -- Defence in depth against a caller putting sensitive content in metadata.
  -- The application already restricts what it sends; this strips the obvious
  -- offenders regardless.
  v_safe_metadata := coalesce(p_metadata, '{}'::jsonb)
    - 'name' - 'customer_name' - 'phone' - 'note' - 'description'
    - 'amount' - 'amount_minor' - 'token' - 'pin' - 'password' - 'reason_text';

  insert into public.audit_logs (
    organization_id, actor_user_id, actor_label, action,
    target_type, target_id, metadata, device_id
  )
  values (
    p_organization_id, auth.uid(), v_actor_label, p_action,
    p_target_type, p_target_id, v_safe_metadata, p_device_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.write_audit_log is
  'Appends an audit entry with the actor pinned to auth.uid(). Strips obviously sensitive metadata keys as defence in depth.';

-- A reversal is a sensitive action, so it is audited by the database rather than
-- relying on the client to remember.
create or replace function bonchi.audit_reversal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.transaction_type <> 'REVERSAL' then
    return new;
  end if;

  insert into public.audit_logs (
    organization_id, actor_user_id, action, target_type, target_id, metadata, device_id
  )
  values (
    new.organization_id,
    new.created_by,
    'transaction.reversed',
    'transaction',
    new.reversal_of_transaction_id::text,
    jsonb_build_object(
      'reversal_transaction_id', new.id,
      'currency', new.currency,
      -- A bucket, not the amount: the audit log is not a second copy of the ledger.
      'amount_bucket', case
        when new.amount_minor < 1000 then 'lt_1k'
        when new.amount_minor < 10000 then '1k_10k'
        when new.amount_minor < 100000 then '10k_100k'
        when new.amount_minor < 1000000 then '100k_1m'
        else 'gte_1m'
      end
    ),
    new.device_id
  );

  return new;
end;
$$;

create trigger transactions_audit_reversal
  after insert on public.transactions
  for each row execute function bonchi.audit_reversal();

-- -----------------------------------------------------------------------------
-- Reminder cancellation when a debt is settled
-- -----------------------------------------------------------------------------

-- Runs after any credit lands. Cancels reminders for debts that are now fully
-- settled, and for anything a reversal has cancelled.
create or replace function bonchi.cancel_settled_reminders()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.reminders r
  set cancelled_at = now(),
      cancelled_reason = 'SETTLED',
      updated_at = now()
  where r.customer_id = new.customer_id
    and r.cancelled_at is null
    and r.fired_at is null
    and exists (
      select 1
      from public.charge_settlements s
      where s.charge_transaction_id = r.transaction_id
        and s.remaining_minor <= 0
    );

  if new.transaction_type = 'REVERSAL' then
    update public.reminders r
    set cancelled_at = now(),
        cancelled_reason = 'REVERSED',
        updated_at = now()
    where r.transaction_id = new.reversal_of_transaction_id
      and r.cancelled_at is null
      and r.fired_at is null;
  end if;

  return new;
end;
$$;

create trigger transactions_cancel_reminders
  after insert on public.transactions
  for each row
  when (new.transaction_type in ('PAYMENT', 'ADJUSTMENT', 'REVERSAL'))
  execute function bonchi.cancel_settled_reminders();

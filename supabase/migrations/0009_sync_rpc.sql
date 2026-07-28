-- =============================================================================
-- 0009_sync_rpc.sql — idempotent write endpoints for the sync engine
-- =============================================================================
-- Acceptance Scenario D, implemented server-side:
--
--   A phone creates a debt offline. The upload reaches the server, the row is
--   written, and the response is lost. The phone retries with the same
--   idempotency key. The merchant must end up with ONE debt.
--
-- `record_transaction` makes that outcome structural rather than a matter of
-- client discipline: a replay returns the original row and reports
-- `replayed = true`, doing nothing else. It never raises, so a retry loop does
-- not have to distinguish "already applied" from "failed".
-- =============================================================================

create type public.record_transaction_result as (
  transaction_id uuid,
  ledger_account_id uuid,
  replayed boolean
);

create or replace function public.record_transaction(
  p_id uuid,
  p_shop_id uuid,
  p_customer_id uuid,
  p_transaction_type bonchi.transaction_type,
  p_currency bonchi.currency_code,
  p_amount_minor bigint,
  p_occurred_at timestamptz,
  p_idempotency_key text,
  p_device_id uuid default null,
  p_due_at date default null,
  p_adjustment_direction bonchi.adjustment_direction default null,
  p_payment_method bonchi.payment_method default null,
  p_description text default null,
  p_product_name text default null,
  p_quantity numeric default null,
  p_internal_note text default null,
  p_customer_note text default null,
  p_reference_number text default null,
  p_reversal_of_transaction_id uuid default null,
  p_reversal_reason text default null,
  p_allocations jsonb default '[]'::jsonb
)
returns public.record_transaction_result
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_existing public.transactions;
  v_inserted public.transactions;
  v_allocation jsonb;
  v_result public.record_transaction_result;
begin
  -- Tenancy is derived from the shop, never accepted from the caller. This is
  -- what stops a tampered payload writing into another organization.
  select organization_id into v_organization_id from public.shops where id = p_shop_id;
  if v_organization_id is null then
    raise exception 'Unknown shop %.', p_shop_id using errcode = 'foreign_key_violation';
  end if;

  -- Replay check first: an already-applied operation must be cheap and silent.
  select * into v_existing
  from public.transactions
  where organization_id = v_organization_id
    and idempotency_key = p_idempotency_key;

  if found then
    v_result.transaction_id := v_existing.id;
    v_result.ledger_account_id := v_existing.ledger_account_id;
    v_result.replayed := true;
    return v_result;
  end if;

  insert into public.transactions (
    id, organization_id, shop_id, customer_id,
    transaction_type, currency, amount_minor, occurred_at, due_at,
    adjustment_direction, payment_method,
    description, product_name, quantity,
    internal_note, customer_note, reference_number,
    reversal_of_transaction_id, reversal_reason,
    client_generated_id, idempotency_key, device_id, created_by, synced_at
  )
  values (
    p_id, v_organization_id, p_shop_id, p_customer_id,
    p_transaction_type, p_currency, p_amount_minor, coalesce(p_occurred_at, now()), p_due_at,
    p_adjustment_direction, p_payment_method,
    p_description, p_product_name, p_quantity,
    p_internal_note, p_customer_note, p_reference_number,
    p_reversal_of_transaction_id, p_reversal_reason,
    p_id, p_idempotency_key, p_device_id, auth.uid(), now()
  )
  returning * into v_inserted;

  -- Explicit merchant allocations, when the payment was directed at named debts.
  for v_allocation in select * from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb))
  loop
    insert into public.transaction_allocations (
      organization_id, credit_transaction_id, charge_transaction_id, amount_minor
    )
    values (
      v_organization_id,
      v_inserted.id,
      (v_allocation ->> 'debtTransactionId')::uuid,
      (v_allocation ->> 'amountMinor')::bigint
    )
    on conflict (credit_transaction_id, charge_transaction_id) do nothing;
  end loop;

  v_result.transaction_id := v_inserted.id;
  v_result.ledger_account_id := v_inserted.ledger_account_id;
  v_result.replayed := false;
  return v_result;

exception
  -- Two devices (or two retries) racing on the same key: whoever lost the race
  -- adopts the winner's row. Still exactly one debt.
  when unique_violation then
    select * into v_existing
    from public.transactions
    where organization_id = v_organization_id
      and idempotency_key = p_idempotency_key;

    if not found then
      raise;
    end if;

    v_result.transaction_id := v_existing.id;
    v_result.ledger_account_id := v_existing.ledger_account_id;
    v_result.replayed := true;
    return v_result;
end;
$$;

comment on function public.record_transaction is
  'Idempotent ledger write. A replayed idempotency key returns the original row with replayed=true and writes nothing. RLS on public.transactions still applies — this function is SECURITY INVOKER by design.';

-- -----------------------------------------------------------------------------
-- Restore: bulk pull for a new device
-- -----------------------------------------------------------------------------

-- Acceptance Scenario F. Paginated so a large ledger streams onto a low-memory
-- phone instead of arriving as one oversized response.
create or replace function public.pull_changes(
  p_organization_id uuid,
  p_since timestamptz default '-infinity'::timestamptz,
  p_limit integer default 500
)
returns table (
  entity_type text,
  entity_id uuid,
  updated_at timestamptz,
  payload jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with bounded as (select least(greatest(coalesce(p_limit, 500), 1), 1000) as page_size)
  select * from (
    select
      'customer'::text as entity_type,
      c.id as entity_id,
      c.updated_at,
      to_jsonb(c) as payload
    from public.customers c
    where c.organization_id = p_organization_id
      and c.updated_at > p_since

    union all

    select
      'transaction'::text,
      t.id,
      t.updated_at,
      to_jsonb(t)
    from public.transactions t
    where t.organization_id = p_organization_id
      and t.updated_at > p_since

    union all

    select
      'allocation'::text,
      a.id,
      a.created_at,
      to_jsonb(a)
    from public.transaction_allocations a
    where a.organization_id = p_organization_id
      and a.created_at > p_since
  ) changes
  order by changes.updated_at, changes.entity_id
  limit (select page_size from bounded);
$$;

comment on function public.pull_changes is
  'Incremental pull for restore and catch-up sync, ordered by updated_at so a client can resume from its last cursor. Page size is clamped server-side.';

-- -----------------------------------------------------------------------------
-- Device registration
-- -----------------------------------------------------------------------------

create or replace function public.register_device(
  p_device_id uuid,
  p_organization_id uuid,
  p_label text,
  p_platform text,
  p_app_version text default null,
  p_os_version text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.devices (
    id, organization_id, user_id, label, platform, app_version, os_version, last_seen_at
  )
  values (
    p_device_id, p_organization_id, auth.uid(), p_label, p_platform,
    p_app_version, p_os_version, now()
  )
  on conflict (id) do update
    set label = excluded.label,
        app_version = excluded.app_version,
        os_version = excluded.os_version,
        last_seen_at = now(),
        updated_at = now()
  where public.devices.user_id = auth.uid();

  return p_device_id;
end;
$$;

comment on function public.register_device is
  'Registers or refreshes the current device. The WHERE clause on the upsert stops one user reclaiming another user''s device row.';

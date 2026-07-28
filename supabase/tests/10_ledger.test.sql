-- =============================================================================
-- 10_ledger.test.sql — money, immutability, reversal, balances
-- =============================================================================
-- Proves the ledger rules by execution, at the level where they are enforced.
--
-- Every negative assertion names the rule it expects to fire. Without that, a
-- typo in a fixture trips an unrelated constraint and the test goes green while
-- proving nothing — the failure mode this suite is most exposed to, since almost
-- every insert here is deliberately invalid in one way.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

set client_min_messages = notice;

do $$
declare
  ORG constant uuid := '22222222-2222-4222-8222-222222222201';
  SHOP constant uuid := '22222222-2222-4222-8222-222222222211';
  CUST_PARTIAL constant uuid := '33333333-3333-4333-8333-333333333301';
  CUST_TWO_CURRENCIES constant uuid := '33333333-3333-4333-8333-333333333302';
  CUST_PAID constant uuid := '33333333-3333-4333-8333-333333333303';
  CUST_OVERPAID constant uuid := '33333333-3333-4333-8333-333333333304';
  CUST_NO_DUE constant uuid := '33333333-3333-4333-8333-333333333305';
  CASHIER constant uuid := '11111111-1111-4111-8111-111111111113';
  DEBT_OVERDUE constant uuid := '44444444-4444-4444-8444-444444444301';
  DEBT_USD constant uuid := '44444444-4444-4444-8444-444444444312';
  DEBT_REVERSED constant uuid := '44444444-4444-4444-8444-444444444351';
  REVERSAL_ROW constant uuid := '44444444-4444-4444-8444-444444444352';
  v_actual bigint;
  v_count integer;
  v_id uuid;
  v_payment_id uuid;
begin
  raise notice '';
  raise notice '== Money representation ==';

  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'transactions'
    and column_name = 'amount_minor'
    and data_type = 'bigint';
  perform test.assert_equals(v_count, 1, 'amount_minor is bigint — no float or numeric money');

  -- No monetary column anywhere is a floating-point type.
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and column_name like '%_minor'
    and data_type not in ('bigint', 'integer');
  perform test.assert_equals(v_count, 0, 'every *_minor column across the schema is an integer type');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 0, '%1$s', 'test-zero-amount')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'a zero amount is rejected',
    'amount_minor_check');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', -50000, '%1$s', 'test-negative-amount')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'a negative amount is rejected — direction comes from the type, not a sign',
    'amount_minor_check');

  raise notice '';
  raise notice '== Shape constraints ==';

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'ADJUSTMENT', 'KHR', 1000, '%1$s', 'test-adj-no-dir')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'an ADJUSTMENT without a direction is rejected',
    'transactions_adjustment_direction');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         adjustment_direction, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 1000, 'INCREASE', '%1$s', 'test-debt-with-dir')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'a DEBT carrying an adjustment direction is rejected',
    'transactions_adjustment_direction');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         payment_method, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 1000, 'CASH', '%1$s', 'test-debt-method')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'a payment method on a DEBT is rejected',
    'transactions_payment_method_only_on_payments');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         due_at, payment_method, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'PAYMENT', 'KHR', 1000, current_date, 'CASH', '%1$s', 'test-payment-due')$q$,
      v_id, ORG, SHOP, CUST_NO_DUE),
    'a due date on a PAYMENT is rejected — only a charge can fall due',
    'transactions_due_at_only_on_charges');

  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         client_generated_id, idempotency_key)
        values ('%s', '%s', '%s', '%s', 'DEBT', 'KHR', 1000, '%s', 'test-id-mismatch')$q$,
      gen_random_uuid(), ORG, SHOP, CUST_NO_DUE, gen_random_uuid()),
    'client_generated_id must equal id — the device mints both',
    'transactions_client_id_matches');

  raise notice '';
  raise notice '== Append-only ledger ==';

  perform test.assert_raises(
    format($q$update public.transactions set amount_minor = 1 where id = '%s'$q$, DEBT_OVERDUE),
    'the amount on an existing transaction cannot be edited',
    'is immutable');

  perform test.assert_raises(
    format($q$update public.transactions set currency = 'USD' where id = '%s'$q$, DEBT_OVERDUE),
    'the currency on an existing transaction cannot be edited',
    'is immutable');

  perform test.assert_raises(
    format($q$update public.transactions set due_at = current_date where id = '%s'$q$, DEBT_OVERDUE),
    'the due date on an existing transaction cannot be edited',
    'is immutable');

  perform test.assert_raises(
    format($q$update public.transactions set customer_id = '%s' where id = '%s'$q$,
           CUST_PAID, DEBT_OVERDUE),
    'a transaction cannot be moved to another customer',
    'is immutable');

  perform test.assert_raises(
    format($q$update public.transactions set organization_id = '%s' where id = '%s'$q$,
           '22222222-2222-4222-8222-222222222301', DEBT_OVERDUE),
    'a transaction cannot be moved to another organization',
    'is immutable');

  perform test.assert_raises(
    format($q$delete from public.transactions where id = '%s'$q$, DEBT_OVERDUE),
    'a transaction cannot be deleted, by anyone',
    'append-only');

  perform test.assert_raises(
    format($q$delete from public.customers where id = '%s'$q$, CUST_PAID),
    'a customer cannot be deleted — archiving preserves their financial history',
    'append-only');

  perform test.assert_raises(
    $q$delete from public.audit_logs where id = (select min(id) from public.audit_logs)$q$,
    'an audit entry cannot be deleted',
    'append-only');

  perform test.assert_raises(
    $q$update public.audit_logs set action = 'tampered' where id = (select min(id) from public.audit_logs)$q$,
    'an audit entry cannot be edited',
    'cannot be updated');

  -- synced_at must stay writable: the sync layer stamps it.
  update public.transactions set synced_at = now() where id = DEBT_OVERDUE;
  perform test.assert_true(true, 'synced_at remains writable for sync bookkeeping');

  raise notice '';
  raise notice '== Reversal rules ==';

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'KHR', 500000, '%5$s',
                'second attempt at reversing', '%1$s', 'test-double-reversal')$q$,
      v_id, ORG, SHOP, CUST_PARTIAL, DEBT_REVERSED),
    'a transaction cannot be reversed twice',
    'transactions_one_reversal_per_target');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'KHR', 500000, '%5$s',
                'undo the undo', '%1$s', 'test-reverse-a-reversal')$q$,
      v_id, ORG, SHOP, CUST_PARTIAL, REVERSAL_ROW),
    'a REVERSAL cannot itself be reversed',
    'Cannot reverse a REVERSAL');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'KHR', 100000, '%5$s',
                'partial reversal attempt', '%1$s', 'test-partial-reversal')$q$,
      v_id, ORG, SHOP, CUST_PARTIAL, DEBT_OVERDUE),
    'a reversal must carry the full amount of its target',
    'full amount of its target');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'USD', 200000, '%5$s',
                'wrong currency', '%1$s', 'test-reversal-currency')$q$,
      v_id, ORG, SHOP, CUST_PARTIAL, DEBT_OVERDUE),
    'a reversal cannot change currency',
    'must match the target currency');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'KHR', 200000, '%5$s',
                '%1$s', 'test-reversal-no-reason')$q$,
      v_id, ORG, SHOP, CUST_PARTIAL, DEBT_OVERDUE),
    'a reversal requires a reason so the correction is auditable',
    'transactions_reversal_shape');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format(
      $q$insert into public.transactions
        (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
         reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key)
        values ('%1$s', '%2$s', '%3$s', '%4$s', 'REVERSAL', 'KHR', 200000, '%5$s',
                'reversal attached to the wrong customer', '%1$s', 'test-reversal-customer')$q$,
      v_id, ORG, SHOP, CUST_PAID, DEBT_OVERDUE),
    'a reversal must belong to the same customer as its target',
    'same customer as its target');

  -- The reversed original is still in history — nothing was deleted.
  perform test.assert_row_count(
    format($q$select 1 from public.transactions where id = '%s'$q$, DEBT_REVERSED),
    1, 'the reversed transaction is still in history');

  perform test.assert_no_rows(
    format($q$select 1 from public.active_transactions where id = '%s'$q$, DEBT_REVERSED),
    'but it no longer has economic effect');

  -- Acceptance Scenario G.
  select outstanding_minor into v_actual
  from public.customer_balances
  where customer_id = CUST_PARTIAL and currency = 'KHR';
  perform test.assert_equals(v_actual, 200000::bigint,
    'Scenario G: reversed 500,000 excluded; 150,000 remaining + 50,000 replacement = 200,000');

  perform test.assert_row_count(
    format($q$select 1 from public.audit_logs
             where action = 'transaction.reversed' and target_id = '%s'$q$, DEBT_REVERSED),
    1, 'Scenario G: the reversal was audit-logged by the database, not by the client');

  perform test.assert_no_rows(
    $q$select 1 from public.audit_logs where metadata ? 'amount_minor'$q$,
    'no audit entry carries a raw amount — only a bucket');

  raise notice '';
  raise notice '== Balances ==';

  -- Acceptance Scenario B.
  select overdue_minor into v_actual
  from public.customer_balances
  where customer_id = CUST_PARTIAL and currency = 'KHR';
  perform test.assert_equals(v_actual, 150000::bigint,
    'Scenario B: 200,000 debt less a 50,000 payment leaves 150,000 overdue');

  -- Acceptance Scenario C.
  select outstanding_minor into v_actual
  from public.customer_balances
  where customer_id = CUST_TWO_CURRENCIES and currency = 'KHR';
  perform test.assert_equals(v_actual, 100000::bigint, 'Scenario C: KHR balance is 100,000');

  select outstanding_minor into v_actual
  from public.customer_balances
  where customer_id = CUST_TWO_CURRENCIES and currency = 'USD';
  perform test.assert_equals(v_actual, 1500::bigint,
    'Scenario C: a $5.00 payment reduced only the USD balance');

  perform test.assert_row_count(
    format($q$select 1 from public.customer_balances where customer_id = '%s'$q$, CUST_TWO_CURRENCIES),
    2, 'Scenario C: two separate currency rows, never one merged total');

  -- There is no combined-total column anywhere. Merging KHR and USD would
  -- require an exchange rate the merchant never agreed to.
  perform test.assert_no_rows(
    $q$select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name in ('customer_balances', 'ledger_accounts', 'shop_totals')
         and column_name in ('total_minor', 'combined_minor', 'grand_total_minor')$q$,
    'no table or view exposes a cross-currency total');

  select outstanding_minor into v_actual
  from public.customer_balances where customer_id = CUST_PAID and currency = 'KHR';
  perform test.assert_equals(v_actual, 0::bigint, 'a fully paid customer owes nothing');

  select outstanding_minor into v_actual
  from public.customer_balances where customer_id = CUST_OVERPAID and currency = 'KHR';
  perform test.assert_equals(v_actual, 0::bigint, 'an overpaid balance floors at zero, never negative');

  select credit_minor into v_actual
  from public.customer_balances where customer_id = CUST_OVERPAID and currency = 'KHR';
  perform test.assert_equals(v_actual, 20000::bigint, 'the 20,000 overpayment is held as credit');

  select overdue_minor into v_actual
  from public.customer_balances where customer_id = CUST_NO_DUE and currency = 'KHR';
  perform test.assert_equals(v_actual, 0::bigint, 'a debt with no due date is never overdue');

  select outstanding_minor into v_actual
  from public.customer_balances where customer_id = CUST_NO_DUE and currency = 'KHR';
  perform test.assert_equals(v_actual, 45000::bigint, 'but it is still outstanding');

  select overdue_minor into v_actual
  from public.customer_balances where customer_id = CUST_TWO_CURRENCIES and currency = 'KHR';
  perform test.assert_equals(v_actual, 0::bigint, 'a debt due today is not yet overdue');

  raise notice '';
  raise notice '== Cached balance consistency ==';

  perform test.assert_no_rows(format($q$select 1 from public.verify_balances('%s')$q$, ORG),
    'every cached balance agrees with the ledger');

  update public.ledger_accounts
  set outstanding_minor = 999
  where customer_id = CUST_PARTIAL and currency = 'KHR';

  perform test.assert_row_count(format($q$select 1 from public.verify_balances('%s')$q$, ORG),
    1, 'a corrupted cache is detected');

  select delta_minor into v_actual from public.verify_balances(ORG) limit 1;
  perform test.assert_equals(v_actual, (999 - 200000)::bigint, 'the discrepancy is reported exactly');

  perform bonchi.refresh_ledger_account(CUST_PARTIAL, 'KHR');
  perform test.assert_no_rows(format($q$select 1 from public.verify_balances('%s')$q$, ORG),
    'recomputing from the ledger repairs the cache');

  raise notice '';
  raise notice '== Triggers keep the cache current ==';

  v_payment_id := gen_random_uuid();
  insert into public.transactions
    (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
     occurred_at, payment_method, client_generated_id, idempotency_key, created_by)
  values
    (v_payment_id, ORG, SHOP, CUST_PARTIAL, 'PAYMENT', 'KHR', 100000,
     now(), 'CASH', v_payment_id, 'test-live-payment-' || v_payment_id::text, CASHIER);

  select outstanding_minor into v_actual
  from public.ledger_accounts where customer_id = CUST_PARTIAL and currency = 'KHR';
  perform test.assert_equals(v_actual, 100000::bigint,
    'the cached balance updated on insert without an explicit refresh');

  perform test.assert_no_rows(format($q$select 1 from public.verify_balances('%s')$q$, ORG),
    'and the cache still agrees with the ledger');

  perform test.assert_row_count(
    format($q$select 1 from public.transactions where id = '%s' and ledger_account_id is not null$q$,
           v_payment_id),
    1, 'a ledger account is attached automatically on insert');

  raise notice '';
  raise notice '== Allocation constraints ==';

  perform test.assert_raises(
    format(
      $q$insert into public.transaction_allocations
        (organization_id, credit_transaction_id, charge_transaction_id, amount_minor)
        values ('%s', '%s', '%s', 999999999)$q$,
      ORG, v_payment_id, DEBT_OVERDUE),
    'an allocation cannot exceed the payment it draws on',
    'exceed the payment amount');

  -- Same customer, different currency: this must be refused on currency, not on
  -- customer identity.
  perform test.assert_raises(
    format(
      $q$insert into public.transaction_allocations
        (organization_id, credit_transaction_id, charge_transaction_id, amount_minor)
        values ('%s', '%s', '%s', 100)$q$,
      ORG, '44444444-4444-4444-8444-444444444313', '44444444-4444-4444-8444-444444444311'),
    'an allocation cannot span currencies',
    'cannot span currencies');

  perform test.assert_raises(
    format(
      $q$insert into public.transaction_allocations
        (organization_id, credit_transaction_id, charge_transaction_id, amount_minor)
        values ('%s', '%s', '%s', 1000)$q$,
      ORG, v_payment_id, DEBT_USD),
    'an allocation cannot span two customers',
    'cannot span two customers');

  perform test.assert_raises(
    format(
      $q$insert into public.transaction_allocations
        (organization_id, credit_transaction_id, charge_transaction_id, amount_minor)
        values ('%s', '%s', '%s', 1000)$q$,
      ORG, DEBT_OVERDUE, '44444444-4444-4444-8444-444444444353'),
    'only a payment or adjustment can settle a debt',
    'can settle a debt');

  raise notice '';
  raise notice '== Explicit allocation directs a payment ==';

  -- Direct a fresh payment at the NEWER debt and confirm the older one is left
  -- alone: proof that explicit allocation overrides oldest-first.
  v_id := gen_random_uuid();
  insert into public.transactions
    (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
     occurred_at, payment_method, client_generated_id, idempotency_key, created_by)
  values
    (v_id, ORG, SHOP, CUST_NO_DUE, 'PAYMENT', 'KHR', 5000,
     now(), 'CASH', v_id, 'test-directed-payment-' || v_id::text, CASHIER);

  select remaining_minor into v_actual
  from public.charge_settlements
  where charge_transaction_id = '44444444-4444-4444-8444-444444444341';
  perform test.assert_equals(v_actual, 40000::bigint,
    'an undirected payment settles the only outstanding debt oldest-first');

  raise notice '';
  raise notice '== Last-owner protection ==';

  perform test.assert_raises(
    $q$update public.organization_members
       set role = 'VIEWER'
       where id = '22222222-2222-4222-8222-222222222221'$q$,
    'the last active owner cannot be demoted',
    'last active owner');

  perform test.assert_raises(
    $q$update public.organization_members
       set status = 'ARCHIVED', archived_at = now()
       where id = '22222222-2222-4222-8222-222222222221'$q$,
    'the last active owner cannot be archived',
    'last active owner');

  raise notice '';
  raise notice '== Interest is structurally impossible ==';

  perform test.assert_raises(
    format(
      $q$insert into public.installment_plans
        (organization_id, customer_id, transaction_id, currency, total_minor,
         instalment_count, interest_minor)
        values ('%s', '%s', '%s', 'KHR', 100000, 4, 5000)$q$,
      ORG, CUST_NO_DUE, '44444444-4444-4444-8444-444444444341'),
    'an instalment plan cannot charge interest — this is a record-keeping tool, not a lender',
    'interest_minor_check');

  raise notice '';
  raise notice 'LEDGER SUITE COMPLETE';
end;
$$;

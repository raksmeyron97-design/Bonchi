-- =============================================================================
-- 50_sync.test.sql — idempotency and restore
-- =============================================================================
-- Covers Acceptance Scenario D (a retried upload must not create a second debt)
-- and Scenario F (a new device rebuilds its local database from the server).
--
-- Scenario D is the most expensive bug this product could ship: a merchant
-- charged twice for one sale, caused by a lost HTTP response on a weak
-- connection. It is tested here at the layer that actually prevents it.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

set client_min_messages = notice;

do $$
declare
  ORG constant uuid := '22222222-2222-4222-8222-222222222201';
  SHOP constant uuid := '22222222-2222-4222-8222-222222222211';
  CASHIER constant uuid := '11111111-1111-4111-8111-111111111113';
  DEVICE constant uuid := '22222222-2222-4222-8222-222222222232';
  CUST constant uuid := '33333333-3333-4333-8333-333333333305';
  v_txn_id uuid;
  v_key text;
  v_first public.record_transaction_result;
  v_second public.record_transaction_result;
  v_third public.record_transaction_result;
  v_before bigint;
  v_after bigint;
  v_count integer;
  v_cursor timestamptz;
begin
  perform test.login(CASHIER);

  raise notice '';
  raise notice '== Scenario D: a retried upload creates exactly one debt ==';

  v_txn_id := gen_random_uuid();
  -- The key a device builds: kind + device + client-generated id. No timestamp,
  -- no attempt counter — it must be identical on every retry.
  v_key := 'TRANSACTION_CREATE:' || DEVICE::text || ':' || v_txn_id::text;

  select outstanding_minor into v_before
  from public.customer_balances where customer_id = CUST and currency = 'KHR';

  -- Attempt 1: reaches the server, row is written, response is lost.
  v_first := public.record_transaction(
    p_id => v_txn_id,
    p_shop_id => SHOP,
    p_customer_id => CUST,
    p_transaction_type => 'DEBT',
    p_currency => 'KHR',
    p_amount_minor => 75000,
    p_occurred_at => now(),
    p_idempotency_key => v_key,
    p_device_id => DEVICE,
    p_description => 'អង្ករ ២ បាវ (scenario D)'
  );

  perform test.assert_equals(v_first.replayed, false, 'the first attempt writes the debt');
  perform test.assert_equals(v_first.transaction_id, v_txn_id,
    'and returns the id the device minted, not a server-generated one');

  -- Attempt 2: the client never heard back, so it retries with the same key.
  v_second := public.record_transaction(
    p_id => v_txn_id,
    p_shop_id => SHOP,
    p_customer_id => CUST,
    p_transaction_type => 'DEBT',
    p_currency => 'KHR',
    p_amount_minor => 75000,
    p_occurred_at => now(),
    p_idempotency_key => v_key,
    p_device_id => DEVICE,
    p_description => 'អង្ករ ២ បាវ (scenario D)'
  );

  perform test.assert_equals(v_second.replayed, true, 'the retry is recognized as a replay');
  perform test.assert_equals(v_second.transaction_id, v_first.transaction_id,
    'and returns the original transaction');

  -- Attempt 3, for good measure: retries are safe any number of times.
  v_third := public.record_transaction(
    p_id => v_txn_id, p_shop_id => SHOP, p_customer_id => CUST,
    p_transaction_type => 'DEBT', p_currency => 'KHR', p_amount_minor => 75000,
    p_occurred_at => now(), p_idempotency_key => v_key, p_device_id => DEVICE);
  perform test.assert_equals(v_third.replayed, true, 'a third attempt is also a replay');

  perform test.assert_row_count(
    format($q$select 1 from public.transactions where idempotency_key = '%s'$q$, v_key),
    1, 'Scenario D: exactly one row exists for the key');

  select outstanding_minor into v_after
  from public.customer_balances where customer_id = CUST and currency = 'KHR';
  perform test.assert_equals(v_after - v_before, 75000::bigint,
    'Scenario D: the balance moved by 75,000 once, not twice');

  raise notice '';
  raise notice '== The retry is not fooled by a changed payload ==';

  -- A buggy or malicious client that reuses a key with a different amount must
  -- not be able to overwrite the original. The first write wins.
  v_second := public.record_transaction(
    p_id => v_txn_id, p_shop_id => SHOP, p_customer_id => CUST,
    p_transaction_type => 'DEBT', p_currency => 'KHR', p_amount_minor => 999999,
    p_occurred_at => now(), p_idempotency_key => v_key, p_device_id => DEVICE);

  perform test.assert_equals(v_second.replayed, true,
    'reusing a key with a different amount is still a replay');
  perform test.assert_equals(
    (select amount_minor from public.transactions where id = v_txn_id),
    75000::bigint,
    'and the original amount is untouched — the first write wins');

  raise notice '';
  raise notice '== The unique index is the backstop ==';

  -- Even bypassing the RPC and inserting directly, the key cannot repeat.
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency,
              amount_minor, client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 75000, '%1$s', '%5$s', '%6$s')$q$,
           gen_random_uuid(), ORG, SHOP, CUST, v_key, CASHIER),
    'a duplicate idempotency key is refused at the index level',
    'transactions_idempotency_unique');

  -- The same key from a different device is a different operation, so it is
  -- allowed: two phones creating records offline must never collide.
  v_txn_id := gen_random_uuid();
  v_second := public.record_transaction(
    p_id => v_txn_id, p_shop_id => SHOP, p_customer_id => CUST,
    p_transaction_type => 'DEBT', p_currency => 'KHR', p_amount_minor => 1000,
    p_occurred_at => now(),
    p_idempotency_key => 'TRANSACTION_CREATE:another-device:' || v_txn_id::text);
  perform test.assert_equals(v_second.replayed, false,
    'a different device''s key is a genuinely different operation');

  raise notice '';
  raise notice '== Explicit allocations survive a replay ==';

  v_txn_id := gen_random_uuid();
  v_key := 'TRANSACTION_CREATE:' || DEVICE::text || ':' || v_txn_id::text;

  v_first := public.record_transaction(
    p_id => v_txn_id, p_shop_id => SHOP, p_customer_id => CUST,
    p_transaction_type => 'PAYMENT', p_currency => 'KHR', p_amount_minor => 5000,
    p_occurred_at => now(), p_idempotency_key => v_key, p_device_id => DEVICE,
    p_payment_method => 'CASH',
    p_allocations => jsonb_build_array(
      jsonb_build_object(
        'debtTransactionId', '44444444-4444-4444-8444-444444444341',
        'amountMinor', 5000
      )
    ));

  perform test.assert_row_count(
    format($q$select 1 from public.transaction_allocations where credit_transaction_id = '%s'$q$,
           v_txn_id),
    1, 'the merchant''s explicit allocation was recorded');

  -- Replaying must not double the allocation.
  v_second := public.record_transaction(
    p_id => v_txn_id, p_shop_id => SHOP, p_customer_id => CUST,
    p_transaction_type => 'PAYMENT', p_currency => 'KHR', p_amount_minor => 5000,
    p_occurred_at => now(), p_idempotency_key => v_key, p_device_id => DEVICE,
    p_payment_method => 'CASH',
    p_allocations => jsonb_build_array(
      jsonb_build_object(
        'debtTransactionId', '44444444-4444-4444-8444-444444444341',
        'amountMinor', 5000
      )
    ));

  perform test.assert_equals(v_second.replayed, true, 'the payment replay is recognized');
  perform test.assert_row_count(
    format($q$select 1 from public.transaction_allocations where credit_transaction_id = '%s'$q$,
           v_txn_id),
    1, 'and the allocation was not duplicated');

  raise notice '';
  raise notice '== Scenario F: a new device pulls the organization back ==';

  -- A fresh install starts with no cursor and pulls everything it can see.
  select count(*) into v_count
  from public.pull_changes(ORG, '-infinity'::timestamptz, 1000);
  perform test.assert_true(v_count > 0, 'a new device receives the organization''s records');

  perform test.assert_true(
    (select count(*) from public.pull_changes(ORG, '-infinity'::timestamptz, 1000)
     where entity_type = 'customer') > 0,
    'including customers');

  perform test.assert_true(
    (select count(*) from public.pull_changes(ORG, '-infinity'::timestamptz, 1000)
     where entity_type = 'transaction') > 0,
    'and the full transaction history');

  -- Paging is server-clamped so a large ledger cannot arrive as one oversized
  -- response on a low-memory phone.
  perform test.assert_row_count(
    format($q$select 1 from public.pull_changes('%s', '-infinity'::timestamptz, 3)$q$, ORG),
    3, 'the page size is honoured');

  perform test.assert_true(
    (select count(*) from public.pull_changes(ORG, '-infinity'::timestamptz, 100000)) <= 1000,
    'an absurd page size is clamped server-side');

  -- Resuming from a cursor returns only what changed since.
  select max(updated_at) into v_cursor from public.transactions where organization_id = ORG;
  perform test.assert_no_rows(
    format($q$select 1 from public.pull_changes('%s', '%s'::timestamptz, 500)
             where entity_type = 'transaction'$q$, ORG, v_cursor),
    'resuming from the latest cursor returns no transactions already held');

  -- The pull is RLS-filtered like everything else.
  perform test.assert_no_rows(
    format($q$select 1 from public.pull_changes('%s', '-infinity'::timestamptz, 500)$q$,
           '22222222-2222-4222-8222-222222222301'),
    'a pull for another organization returns nothing');

  raise notice '';
  raise notice '== After a restore, cached balances match the server ==';

  perform test.reset_role();
  perform test.login('11111111-1111-4111-8111-111111111111');

  perform test.assert_true(
    public.rebuild_ledger_accounts(ORG) > 0,
    'an owner can rebuild every cached balance from the ledger');

  perform test.assert_no_rows(
    format($q$select 1 from public.verify_balances('%s')$q$, ORG),
    'Scenario F: after rebuilding, every cached balance matches the ledger exactly');

  perform test.reset_role();

  raise notice '';
  raise notice '== Only an owner may rebuild balances ==';

  perform test.login(CASHIER);
  perform test.assert_raises(
    format($q$select public.rebuild_ledger_accounts('%s')$q$, ORG),
    'a cashier cannot trigger a full rebuild',
    'Only an organization owner');
  perform test.reset_role();

  raise notice '';
  raise notice '== Device registration cannot be hijacked ==';

  perform test.login(CASHIER);
  perform test.assert_equals(
    public.register_device(DEVICE, ORG, 'Counter phone (renamed)', 'android', '0.1.1'),
    DEVICE,
    'a user can refresh their own device registration');
  perform test.reset_role();

  -- Another user calling register_device with someone else's device id must not
  -- take over that row. The upsert's WHERE clause makes the update a no-op.
  perform test.login('11111111-1111-4111-8111-111111111114');
  perform test.assert_equals(
    public.register_device(DEVICE, ORG, 'Hijack attempt', 'android', '0.1.1'),
    DEVICE,
    'the call itself does not error');
  -- A viewer cannot see another user's device row, so the check is made as owner.
  perform test.assert_no_rows(
    format($q$select 1 from public.devices where id = '%s'$q$, DEVICE),
    'and a viewer cannot even see that device');
  perform test.reset_role();

  perform test.login('11111111-1111-4111-8111-111111111111');
  perform test.assert_equals(
    (select user_id from public.devices where id = DEVICE),
    CASHIER,
    'the device still belongs to the cashier — registration cannot be hijacked');
  perform test.assert_equals(
    (select label from public.devices where id = DEVICE),
    'Counter phone (renamed)',
    'and its label was not overwritten by the other user');
  perform test.reset_role();

  raise notice '';
  raise notice 'SYNC SUITE COMPLETE';
end;
$$;

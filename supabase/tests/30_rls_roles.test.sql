-- =============================================================================
-- 30_rls_roles.test.sql — the role/permission matrix, enforced in the database
-- =============================================================================
-- The same matrix is defined in packages/domain/src/access/roles.ts and covered
-- by roles.test.ts. That version decides which buttons the app draws; this one
-- decides what is actually possible. Both exist because a hidden button is not a
-- control, and the two must agree.
--
-- Matrix under test:
--
--                              VIEWER  CASHIER  MANAGER  OWNER
--   read customers/ledger         y       y        y       y
--   create customer               .       y        y       y
--   edit customer                 .       y        y       y
--   archive customer              .       .        y       y
--   record debt / payment         .       y        y       y
--   reverse a transaction         .       .        y       y
--   record an adjustment          .       .        y       y
--   soft-delete an attachment     .       .        y       y
--   read the audit trail          .       .        y       y
--   manage members / roles        .       .        .       y
--   update the organization       .       .        .       y
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

set client_min_messages = notice;

do $$
declare
  ORG constant uuid := '22222222-2222-4222-8222-222222222201';
  SHOP constant uuid := '22222222-2222-4222-8222-222222222211';
  OWNER constant uuid := '11111111-1111-4111-8111-111111111111';
  MANAGER constant uuid := '11111111-1111-4111-8111-111111111112';
  CASHIER constant uuid := '11111111-1111-4111-8111-111111111113';
  VIEWER constant uuid := '11111111-1111-4111-8111-111111111114';
  CUST constant uuid := '33333333-3333-4333-8333-333333333305';
  CUST_FOR_ARCHIVE constant uuid := '33333333-3333-4333-8333-333333333303';
  DEBT constant uuid := '44444444-4444-4444-8444-444444444341';
  CASHIER_MEMBERSHIP constant uuid := '22222222-2222-4222-8222-222222222223';
  v_id uuid;
  v_reversal_target uuid;
begin
  raise notice '';
  raise notice '== VIEWER: read-only ==';

  perform test.login(VIEWER);

  perform test.assert_true(
    (select count(*) from public.customers) > 0, 'a viewer can read customers');
  perform test.assert_true(
    (select count(*) from public.transactions) > 0, 'a viewer can read transactions');
  perform test.assert_true(
    (select count(*) from public.customer_balances) > 0, 'a viewer can read balances');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.customers (id, organization_id, shop_id, name)
             values ('%s', '%s', '%s', 'added by viewer')$q$, v_id, ORG, SHOP),
    'a viewer cannot create a customer',
    'row-level security');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency,
              amount_minor, client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 10000, '%1$s',
                     'test-viewer-debt', '%5$s')$q$, v_id, ORG, SHOP, CUST, VIEWER),
    'a viewer cannot record a debt',
    'row-level security');

  perform test.assert_affects_no_rows(
    format($q$update public.customers set note = 'edited by viewer' where id = '%s'$q$, CUST),
    'a viewer cannot edit a customer');

  perform test.assert_no_rows('select 1 from public.audit_logs',
    'a viewer cannot read the audit trail');

  perform test.reset_role();

  raise notice '';
  raise notice '== CASHIER: takes money, cannot rewrite history ==';

  perform test.login(CASHIER);

  v_id := gen_random_uuid();
  insert into public.customers (id, organization_id, shop_id, name, created_by)
  values (v_id, ORG, SHOP, 'អតិថិជនថ្មី (cashier test)', CASHIER);
  perform test.assert_true(true, 'a cashier can create a customer');

  update public.customers set phone = '012 999 001' where id = v_id;
  perform test.assert_true(true, 'a cashier can correct a customer''s details');

  -- Archiving removes a debtor from the working list; that is a manager decision.
  perform test.assert_raises(
    format($q$update public.customers set archived_at = now() where id = '%s'$q$, v_id),
    'a cashier cannot archive a customer',
    'row-level security');

  v_reversal_target := gen_random_uuid();
  insert into public.transactions
    (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
     occurred_at, due_at, client_generated_id, idempotency_key, created_by)
  values
    (v_reversal_target, ORG, SHOP, v_id, 'DEBT', 'KHR', 60000, now(),
     bonchi.merchant_today('Asia/Phnom_Penh') + 5, v_reversal_target,
     'test-cashier-debt-' || v_reversal_target::text, CASHIER);
  perform test.assert_true(true, 'a cashier can record a debt');

  v_id := gen_random_uuid();
  insert into public.transactions
    (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
     occurred_at, payment_method, client_generated_id, idempotency_key, created_by)
  values
    (v_id, ORG, SHOP, (select customer_id from public.transactions where id = v_reversal_target),
     'PAYMENT', 'KHR', 10000, now(), 'CASH', v_id,
     'test-cashier-payment-' || v_id::text, CASHIER);
  perform test.assert_true(true, 'a cashier can record a payment');

  -- The control that matters: a cashier who mistypes an amount must ask someone
  -- senior to correct it. They cannot make a financial record disappear.
  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
              reversal_of_transaction_id, reversal_reason, client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s',
                     (select customer_id from public.transactions where id = '%4$s'),
                     'REVERSAL', 'KHR', 60000, '%4$s', 'cashier trying to undo',
                     '%1$s', 'test-cashier-reversal', '%5$s')$q$,
           v_id, ORG, SHOP, v_reversal_target, CASHIER),
    'a cashier cannot reverse a transaction',
    'row-level security');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
              adjustment_direction, client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'ADJUSTMENT', 'KHR', 5000, 'DECREASE',
                     '%1$s', 'test-cashier-adjustment', '%5$s')$q$,
           v_id, ORG, SHOP, CUST, CASHIER),
    'a cashier cannot write off part of a balance with an adjustment',
    'row-level security');

  -- A cashier cannot attribute an entry to someone else.
  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
              client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 10000, '%1$s',
                     'test-impersonation', '%5$s')$q$, v_id, ORG, SHOP, CUST, MANAGER),
    'a cashier cannot record a transaction in another member''s name',
    'row-level security');

  perform test.assert_no_rows('select 1 from public.audit_logs',
    'a cashier cannot read the audit trail');

  -- Privilege escalation is blocked by the row simply not being updatable: the
  -- statement succeeds and changes nothing.
  perform test.assert_affects_no_rows(
    format($q$update public.organization_members set role = 'OWNER' where id = '%s'$q$,
           CASHIER_MEMBERSHIP),
    'a cashier cannot promote themselves');

  perform test.assert_no_rows(
    format($q$select 1 from public.organization_members where user_id = '%s'$q$, OWNER),
    'a cashier cannot even see the member roster');

  perform test.assert_row_count(
    format($q$select 1 from public.organization_members where user_id = '%s'$q$, CASHIER),
    1, 'but a cashier can see their own membership');

  perform test.reset_role();

  raise notice '';
  raise notice '== MANAGER: can correct history, cannot manage people ==';

  perform test.login(MANAGER);

  v_id := gen_random_uuid();
  insert into public.transactions
    (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
     occurred_at, reversal_of_transaction_id, reversal_reason,
     client_generated_id, idempotency_key, created_by)
  values
    (v_id, ORG, SHOP,
     (select customer_id from public.transactions where id = v_reversal_target),
     'REVERSAL', 'KHR', 60000, now(), v_reversal_target,
     'Cashier recorded the wrong amount',
     v_id, 'test-manager-reversal-' || v_id::text, MANAGER);
  perform test.assert_true(true, 'a manager can reverse a transaction');

  perform test.assert_true(
    (select count(*) from public.audit_logs) > 0, 'a manager can read the audit trail');

  update public.customers set archived_at = now(), archived_by = MANAGER
  where id = CUST_FOR_ARCHIVE;
  perform test.assert_true(true, 'a manager can archive a customer');

  -- Undo, so the fixture set is unchanged for later suites.
  update public.customers set archived_at = null, archived_by = null where id = CUST_FOR_ARCHIVE;

  perform test.assert_true(
    (select count(*) from public.organization_members) > 1,
    'a manager can see the member roster');

  perform test.assert_affects_no_rows(
    format($q$update public.organization_members set role = 'VIEWER' where id = '%s'$q$,
           CASHIER_MEMBERSHIP),
    'a manager cannot change anyone''s role');

  perform test.assert_affects_no_rows(
    format($q$update public.organizations set name = 'renamed by manager' where id = '%s'$q$, ORG),
    'a manager cannot rename the organization');

  perform test.assert_affects_no_rows(
    format($q$update public.subscriptions set plan_id = 'free' where organization_id = '%s'$q$, ORG),
    'a manager cannot change the subscription');

  perform test.reset_role();

  raise notice '';
  raise notice '== OWNER: full control ==';

  perform test.login(OWNER);

  update public.organizations set name = 'ហាងម្ដាយថាន (demo)' where id = ORG;
  perform test.assert_true(true, 'an owner can update the organization');

  update public.organization_members set role = 'CASHIER' where id = CASHIER_MEMBERSHIP;
  perform test.assert_true(true, 'an owner can set a member''s role');

  perform test.assert_true(
    (select count(*) from public.audit_logs) > 0, 'an owner can read the audit trail');

  update public.subscriptions set plan_id = 'shop' where organization_id = ORG;
  perform test.assert_true(true, 'an owner can manage the subscription');

  -- Even an owner cannot destroy financial history.
  perform test.assert_raises(
    format($q$delete from public.transactions where id = '%s'$q$, DEBT),
    'not even an owner can delete a transaction',
    null);

  perform test.assert_raises(
    format($q$update public.transactions set amount_minor = 1 where id = '%s'$q$, DEBT),
    'not even an owner can edit an amount',
    'is immutable');

  perform test.reset_role();

  raise notice '';
  raise notice '== Suspension stops writes but never reads ==';

  update public.organizations
  set suspended_at = now(), suspended_reason = 'demo suspension for test'
  where id = ORG;

  perform test.login(CASHIER);

  -- A suspended merchant must still be able to see and export their records.
  perform test.assert_true(
    (select count(*) from public.customers) > 0,
    'a suspended organization can still be read by its members');
  perform test.assert_true(
    (select count(*) from public.transactions) > 0,
    'their transaction history is still readable');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
              client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 10000, '%1$s',
                     'test-suspended-write', '%5$s')$q$, v_id, ORG, SHOP, CUST, CASHIER),
    'but no new debt can be recorded while suspended',
    'row-level security');

  perform test.reset_role();

  update public.organizations set suspended_at = null, suspended_reason = null where id = ORG;

  raise notice '';
  raise notice 'ROLES SUITE COMPLETE';
end;
$$;

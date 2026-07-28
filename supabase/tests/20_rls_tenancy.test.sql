-- =============================================================================
-- 20_rls_tenancy.test.sql — tenant isolation
-- =============================================================================
-- The single most important property in this system: one shop's debt records must
-- be unreachable from another shop, and unreachable without authentication.
--
-- RLS denies by filtering, so a denied read looks like an empty result rather
-- than an error. Every read assertion here therefore checks for zero rows, and
-- every write assertion checks that the statement was refused.
--
-- Covers Acceptance Scenario E.
-- =============================================================================

\set ON_ERROR_STOP on
\set QUIET on

set client_min_messages = notice;

do $$
declare
  ORG_A constant uuid := '22222222-2222-4222-8222-222222222201';
  ORG_B constant uuid := '22222222-2222-4222-8222-222222222301';
  SHOP_A constant uuid := '22222222-2222-4222-8222-222222222211';
  SHOP_B constant uuid := '22222222-2222-4222-8222-222222222311';
  OWNER_A constant uuid := '11111111-1111-4111-8111-111111111111';
  OWNER_B constant uuid := '11111111-1111-4111-8111-111111111121';
  ARCHIVED_MEMBER constant uuid := '11111111-1111-4111-8111-111111111115';
  PLATFORM_ADMIN constant uuid := '11111111-1111-4111-8111-111111111116';
  CUST_A constant uuid := '33333333-3333-4333-8333-333333333301';
  CUST_B constant uuid := '33333333-3333-4333-8333-333333333401';
  TXN_B constant uuid := '44444444-4444-4444-8444-444444444401';
  v_id uuid;
begin
  raise notice '';
  raise notice '== Anonymous access is impossible ==';

  -- Note the difference in denial mechanism, which is deliberate:
  --   * anon is denied at the PRIVILEGE level, so the statement errors outright.
  --   * a cross-tenant authenticated read is denied by RLS FILTERING, so it
  --     returns no rows.
  -- Two independent layers. Even if a policy were mistakenly written for `anon`,
  -- the missing grant would still refuse the read.

  perform test.logout();

  perform test.assert_raises('select 1 from public.customers',
    'anon cannot read customers', 'permission denied');
  perform test.assert_raises('select 1 from public.transactions',
    'anon cannot read transactions', 'permission denied');
  perform test.assert_raises('select 1 from public.organizations',
    'anon cannot read organizations', 'permission denied');
  perform test.assert_raises('select 1 from public.customer_balances',
    'anon cannot read balances', 'permission denied');
  perform test.assert_raises('select 1 from public.audit_logs',
    'anon cannot read audit history', 'permission denied');
  perform test.assert_raises('select 1 from public.attachments',
    'anon cannot read attachment metadata', 'permission denied');
  perform test.assert_raises('select 1 from public.profiles',
    'anon cannot read profiles', 'permission denied');
  perform test.assert_raises('select 1 from public.devices',
    'anon cannot read devices', 'permission denied');
  perform test.assert_raises('select 1 from public.charge_settlements',
    'anon cannot read the settlement view', 'permission denied');

  perform test.assert_raises(
    format($q$insert into public.customers (id, organization_id, shop_id, name)
             values ('%s', '%s', '%s', 'injected by anon')$q$,
           gen_random_uuid(), ORG_A, SHOP_A),
    'anon cannot create a customer',
    'permission denied');

  perform test.assert_raises(
    format($q$select public.record_transaction(
             p_id => '%1$s', p_shop_id => '%2$s', p_customer_id => '%3$s',
             p_transaction_type => 'DEBT', p_currency => 'KHR', p_amount_minor => 1000,
             p_occurred_at => now(), p_idempotency_key => 'anon-attempt')$q$,
           gen_random_uuid(), SHOP_A, CUST_A),
    'anon cannot call the write RPC',
    'permission denied');

  perform test.reset_role();

  raise notice '';
  raise notice '== Organization A sees only its own data ==';

  perform test.login(OWNER_A);

  perform test.assert_row_count(
    format($q$select 1 from public.customers where id = '%s'$q$, CUST_A),
    1, 'owner A reads their own customer');

  -- Acceptance Scenario E: the request for another organization's customer
  -- returns nothing at all.
  perform test.assert_no_rows(
    format($q$select 1 from public.customers where id = '%s'$q$, CUST_B),
    'Scenario E: owner A cannot read organization B''s customer');

  perform test.assert_no_rows(
    format($q$select 1 from public.transactions where id = '%s'$q$, TXN_B),
    'Scenario E: owner A cannot read organization B''s transaction');

  perform test.assert_no_rows(
    format($q$select 1 from public.customers where organization_id = '%s'$q$, ORG_B),
    'filtering by the other organization''s id still returns nothing');

  perform test.assert_no_rows(
    format($q$select 1 from public.organizations where id = '%s'$q$, ORG_B),
    'owner A cannot read organization B itself');

  perform test.assert_no_rows(
    format($q$select 1 from public.shops where id = '%s'$q$, SHOP_B),
    'owner A cannot read organization B''s shop');

  perform test.assert_no_rows(
    format($q$select 1 from public.customer_balances where organization_id = '%s'$q$, ORG_B),
    'derived balance views respect tenancy too');

  perform test.assert_no_rows(
    format($q$select 1 from public.charge_settlements where organization_id = '%s'$q$, ORG_B),
    'the settlement view respects tenancy');

  perform test.assert_no_rows(
    format($q$select 1 from public.shop_totals where organization_id = '%s'$q$, ORG_B),
    'the dashboard roll-up respects tenancy');

  perform test.assert_no_rows(
    format($q$select 1 from public.verify_balances('%s')$q$, ORG_B),
    'the balance verification function respects tenancy');

  -- An aggregate must not leak the existence or size of another tenant's ledger.
  perform test.assert_equals(
    (select coalesce(sum(amount_minor), 0) from public.transactions
     where organization_id = ORG_B)::bigint,
    0::bigint,
    'an aggregate over another organization sums to zero, leaking nothing');

  raise notice '';
  raise notice '== Writing into another tenant is refused ==';

  perform test.assert_raises(
    format($q$insert into public.customers (id, organization_id, shop_id, name)
             values ('%s', '%s', '%s', 'planted in org B')$q$,
           gen_random_uuid(), ORG_B, SHOP_B),
    'owner A cannot create a customer inside organization B',
    'row-level security');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.transactions
             (id, organization_id, shop_id, customer_id, transaction_type, currency,
              amount_minor, client_generated_id, idempotency_key, created_by)
             values ('%1$s', '%2$s', '%3$s', '%4$s', 'DEBT', 'KHR', 50000, '%1$s',
                     'test-cross-tenant-debt', '%5$s')$q$,
           v_id, ORG_B, SHOP_B, CUST_B, OWNER_A),
    'owner A cannot record a debt inside organization B',
    'row-level security');

  -- RLS denies an UPDATE by making the row invisible, so the statement succeeds
  -- and changes nothing rather than raising.
  perform test.assert_affects_no_rows(
    format($q$update public.customers set name = 'renamed by outsider' where id = '%s'$q$, CUST_B),
    'an update targeting another tenant''s customer affects no rows');

  perform test.assert_affects_no_rows(
    format($q$update public.transactions set synced_at = now() where id = '%s'$q$, TXN_B),
    'an update targeting another tenant''s transaction affects no rows');

  raise notice '';
  raise notice '== Tenant escape via UPDATE is blocked ==';

  -- Moving a row into another organization would carry its whole debt history
  -- across the boundary. Blocked by trigger, independently of RLS.
  perform test.assert_raises(
    format($q$update public.customers set organization_id = '%s' where id = '%s'$q$, ORG_B, CUST_A),
    'a customer cannot be re-parented into another organization',
    'organization_id is immutable');

  perform test.assert_raises(
    format($q$update public.shops set organization_id = '%s' where id = '%s'$q$, ORG_B, SHOP_A),
    'a shop cannot be re-parented into another organization',
    'organization_id is immutable');

  perform test.assert_raises(
    format($q$update public.transactions set organization_id = '%s' where id = '%s'$q$,
           ORG_B, '44444444-4444-4444-8444-444444444301'),
    'a transaction cannot be re-parented into another organization',
    'is immutable');

  raise notice '';
  raise notice '== record_transaction derives tenancy from the shop ==';

  -- The RPC takes no organization_id at all, so a tampered payload has nothing to
  -- tamper with — tenancy is looked up from the shop.
  --
  -- The function is SECURITY INVOKER, so that lookup runs under the caller's own
  -- RLS: another tenant's shop is simply not visible, and the RPC fails closed
  -- with "Unknown shop". That is better than an RLS error, because it does not
  -- confirm to an attacker that the shop id exists.
  perform test.assert_raises(
    format(
      $q$select public.record_transaction(
        p_id => '%1$s',
        p_shop_id => '%2$s',
        p_customer_id => '%3$s',
        p_transaction_type => 'DEBT',
        p_currency => 'KHR',
        p_amount_minor => 50000,
        p_occurred_at => now(),
        p_idempotency_key => 'test-rpc-cross-tenant'
      )$q$,
      gen_random_uuid(), SHOP_B, CUST_B),
    'the write RPC fails closed on another tenant''s shop, without confirming it exists',
    'Unknown shop');

  perform test.reset_role();

  raise notice '';
  raise notice '== Organization B is equally isolated ==';

  perform test.login(OWNER_B);

  perform test.assert_row_count(
    format($q$select 1 from public.customers where id = '%s'$q$, CUST_B),
    1, 'owner B reads their own customer');

  perform test.assert_no_rows(
    format($q$select 1 from public.customers where id = '%s'$q$, CUST_A),
    'owner B cannot read organization A''s customer');

  perform test.assert_row_count(
    'select 1 from public.customers',
    1, 'owner B sees exactly one customer — their own');

  perform test.assert_row_count(
    'select 1 from public.transactions',
    1, 'owner B sees exactly one transaction — their own');

  perform test.reset_role();

  raise notice '';
  raise notice '== An archived member loses all access ==';

  perform test.login(ARCHIVED_MEMBER);

  perform test.assert_no_rows('select 1 from public.customers',
    'an archived member reads no customers');
  perform test.assert_no_rows('select 1 from public.transactions',
    'an archived member reads no transactions');
  perform test.assert_no_rows(
    format($q$select 1 from public.organizations where id = '%s'$q$, ORG_A),
    'an archived member cannot even see the organization');

  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.customers (id, organization_id, shop_id, name)
             values ('%s', '%s', '%s', 'added by archived member')$q$, v_id, ORG_A, SHOP_A),
    'an archived member cannot create a customer',
    'row-level security');

  -- Their row survives so audit history can still name them.
  perform test.reset_role();
  perform test.assert_row_count(
    format($q$select 1 from public.organization_members where user_id = '%s'$q$, ARCHIVED_MEMBER),
    1, 'the archived membership row is retained for audit history');

  raise notice '';
  raise notice '== Platform staff cannot browse merchant data ==';

  perform test.login(PLATFORM_ADMIN);

  -- Being staff grants aggregate operational access only. Reading a merchant's
  -- customer records requires an explicit, time-boxed, reasoned grant.
  perform test.assert_no_rows('select 1 from public.customers',
    'a platform admin with no grant reads no customers');
  perform test.assert_no_rows('select 1 from public.transactions',
    'a platform admin with no grant reads no transactions');
  perform test.assert_no_rows('select 1 from public.customer_balances',
    'a platform admin with no grant reads no balances');

  perform test.reset_role();

  raise notice '';
  raise notice '== A support grant opens a narrow, expiring window ==';

  insert into public.support_access_grants
    (organization_id, admin_user_id, reason, expires_at)
  values
    (ORG_A, PLATFORM_ADMIN, 'Merchant reported a balance mismatch, ticket DEMO-1', now() + interval '1 hour');

  perform test.login(PLATFORM_ADMIN);

  perform test.assert_row_count(
    format($q$select 1 from public.customers where id = '%s'$q$, CUST_A),
    1, 'with a live grant, support can read the organization that asked for help');

  perform test.assert_no_rows(
    format($q$select 1 from public.customers where organization_id = '%s'$q$, ORG_B),
    'the grant covers only the organization it names');

  -- Read-only: a grant never confers write access.
  v_id := gen_random_uuid();
  perform test.assert_raises(
    format($q$insert into public.customers (id, organization_id, shop_id, name)
             values ('%s', '%s', '%s', 'written by support')$q$, v_id, ORG_A, SHOP_A),
    'a support grant is read-only',
    'row-level security');

  perform test.reset_role();

  -- Expiry is enforced by the predicate, not by a cleanup job. The grant window
  -- must stay positive (a CHECK enforces expires_at > granted_at), so the whole
  -- window is moved into the past rather than inverted.
  update public.support_access_grants
  set granted_at = now() - interval '2 hours',
      expires_at = now() - interval '1 hour'
  where organization_id = ORG_A and admin_user_id = PLATFORM_ADMIN;

  perform test.login(PLATFORM_ADMIN);
  perform test.assert_no_rows('select 1 from public.customers',
    'an expired grant grants nothing');
  perform test.reset_role();

  update public.support_access_grants
  set granted_at = now(), expires_at = now() + interval '1 hour', revoked_at = now()
  where organization_id = ORG_A and admin_user_id = PLATFORM_ADMIN;

  perform test.login(PLATFORM_ADMIN);
  perform test.assert_no_rows('select 1 from public.customers',
    'a revoked grant grants nothing');
  perform test.reset_role();

  delete from public.support_access_grants
  where organization_id = ORG_A and admin_user_id = PLATFORM_ADMIN;

  raise notice '';
  raise notice '== Audit entries cannot be forged ==';

  perform test.login(OWNER_A);

  perform test.assert_raises(
    format($q$insert into public.audit_logs (organization_id, actor_user_id, action)
             values ('%s', '%s', 'forged.action')$q$, ORG_A, OWNER_B),
    'an audit entry cannot be attributed to another user',
    'row-level security');

  perform test.reset_role();

  raise notice '';
  raise notice 'TENANCY SUITE COMPLETE';
end;
$$;

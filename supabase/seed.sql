-- =============================================================================
-- seed.sql — development and test fixtures
-- =============================================================================
-- Every name, phone number and email here is obviously fictional. This file is
-- for local development and the automated test suite only; it is never applied to
-- a production database (see docs/deployment/admin-release.md, which lists the
-- migration command without a seed step).
--
-- Coverage is deliberate — the fixture set exercises every case the ledger must
-- get right:
--   * KHR debts, USD debts, and one customer owing both
--   * a partially paid debt, a fully paid debt, an overpaid customer
--   * an overdue debt, one due today, one due in the future, one with no due date
--   * a reversed transaction plus its replacement
--   * a pending offline sync operation
--   * one member at each of the four roles, plus an archived member
-- =============================================================================

-- Fixed UUIDs so tests can reference rows without lookups.
-- 1xxx users, 2xxx organizations/shops, 3xxx customers, 4xxx transactions.

begin;

-- --- Users -------------------------------------------------------------------

-- `aud`, `role` and `email_confirmed_at` are set explicitly: GoTrue will not let a
-- user sign in without them, and a row that exists but cannot authenticate is a
-- confusing way to lose an afternoon. Emails use the reserved .test TLD so they can
-- never resolve to a real mailbox.
--
-- Sign in as any of these locally with an email one-time code — the code is
-- delivered to the local mail catcher at http://localhost:54324, not to an inbox.
insert into auth.users (
  instance_id, id, aud, role, email, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  -- GoTrue scans these into non-nullable Go strings. Leaving them NULL makes every
  -- sign-in attempt fail with "Database error finding user" — a 500 that says
  -- nothing about the real cause. They must be EMPTY STRINGS, not NULL.
  confirmation_token, recovery_token, email_change_token_new,
  email_change_token_current, email_change, phone_change, phone_change_token,
  reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000',
  seeded.id::uuid,
  'authenticated',
  'authenticated',
  seeded.email,
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now(),
  '', '', '', '', '', '', '', ''
from (values
  ('11111111-1111-4111-8111-111111111111', 'owner.demo@example.test'),
  ('11111111-1111-4111-8111-111111111112', 'manager.demo@example.test'),
  ('11111111-1111-4111-8111-111111111113', 'cashier.demo@example.test'),
  ('11111111-1111-4111-8111-111111111114', 'viewer.demo@example.test'),
  ('11111111-1111-4111-8111-111111111115', 'archived.demo@example.test'),
  ('11111111-1111-4111-8111-111111111116', 'platform.admin@example.test'),
  -- A second, unrelated shop. Tenant-isolation tests read across this boundary.
  ('11111111-1111-4111-8111-111111111121', 'other.owner@example.test')
) as seeded(id, email)
on conflict (id) do nothing;

insert into public.profiles (id, display_name, phone, locale, onboarding_completed_at) values
  ('11111111-1111-4111-8111-111111111111', 'Sok Dara (demo owner)', '+85512000001', 'km', now()),
  ('11111111-1111-4111-8111-111111111112', 'Chan Mony (demo manager)', '+85512000002', 'km', now()),
  ('11111111-1111-4111-8111-111111111113', 'Kim Srey (demo cashier)', '+85512000003', 'km', now()),
  ('11111111-1111-4111-8111-111111111114', 'Pich Vanna (demo viewer)', '+85512000004', 'en', now()),
  ('11111111-1111-4111-8111-111111111115', 'Former Staff (demo archived)', null, 'km', now()),
  ('11111111-1111-4111-8111-111111111116', 'Platform Support (demo)', null, 'en', now()),
  ('11111111-1111-4111-8111-111111111121', 'Neang Kanha (other shop owner)', '+85512000021', 'km', now())
on conflict (id) do nothing;

insert into public.platform_admins (user_id, role) values
  ('11111111-1111-4111-8111-111111111116', 'SUPPORT')
on conflict (user_id) do nothing;

-- --- Organization A: the demo grocery shop -----------------------------------

insert into public.organizations (id, name, time_zone, default_locale, currency_usage, created_by) values
  (
    '22222222-2222-4222-8222-222222222201',
    'ហាងម្ដាយថាន (demo)',
    'Asia/Phnom_Penh',
    'km',
    'BOTH',
    '11111111-1111-4111-8111-111111111111'
  )
on conflict (id) do nothing;

insert into public.shops (id, organization_id, name, business_category, phone, address, currency_usage, time_zone) values
  (
    '22222222-2222-4222-8222-222222222211',
    '22222222-2222-4222-8222-222222222201',
    'ហាងម្ដាយថាន (demo)',
    'GROCERY',
    '+85512000001',
    'ផ្សារដើមគ08, ភ្នំពេញ (demo address)',
    'BOTH',
    'Asia/Phnom_Penh'
  )
on conflict (id) do nothing;

insert into public.organization_members
  (id, organization_id, user_id, role, status, joined_at, archived_at)
values
  ('22222222-2222-4222-8222-222222222221', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111111', 'OWNER', 'ACTIVE', now(), null),
  ('22222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111112', 'MANAGER', 'ACTIVE', now(), null),
  ('22222222-2222-4222-8222-222222222223', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111113', 'CASHIER', 'ACTIVE', now(), null),
  ('22222222-2222-4222-8222-222222222224', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111114', 'VIEWER', 'ACTIVE', now(), null),
  -- Archived: keeps their row so audit history can still name them, but has no access.
  ('22222222-2222-4222-8222-222222222225', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111115', 'CASHIER', 'ARCHIVED', now() - interval '90 days', now() - interval '10 days')
on conflict (id) do nothing;

insert into public.devices (id, organization_id, user_id, label, platform, app_version) values
  ('22222222-2222-4222-8222-222222222231', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111111', 'Owner phone (demo)', 'android', '0.1.0'),
  ('22222222-2222-4222-8222-222222222232', '22222222-2222-4222-8222-222222222201',
   '11111111-1111-4111-8111-111111111113', 'Counter phone (demo)', 'android', '0.1.0')
on conflict (id) do nothing;

-- --- Organization B: a completely separate shop ------------------------------

insert into public.organizations (id, name, time_zone, default_locale, currency_usage, created_by) values
  ('22222222-2222-4222-8222-222222222301', 'ហាងសម្ភារសំណង់ (other demo)', 'Asia/Phnom_Penh', 'km', 'KHR_ONLY',
   '11111111-1111-4111-8111-111111111121')
on conflict (id) do nothing;

insert into public.shops (id, organization_id, name, business_category, currency_usage, time_zone) values
  ('22222222-2222-4222-8222-222222222311', '22222222-2222-4222-8222-222222222301',
   'ហាងសម្ភារសំណង់ (other demo)', 'CONSTRUCTION_MATERIALS', 'KHR_ONLY', 'Asia/Phnom_Penh')
on conflict (id) do nothing;

insert into public.organization_members (id, organization_id, user_id, role, status, joined_at) values
  ('22222222-2222-4222-8222-222222222321', '22222222-2222-4222-8222-222222222301',
   '11111111-1111-4111-8111-111111111121', 'OWNER', 'ACTIVE', now())
on conflict (id) do nothing;

-- --- Customers ---------------------------------------------------------------

insert into public.customers
  (id, organization_id, shop_id, name, phone, phone_normalized, customer_code, note, created_by, device_id)
values
  -- Owes KHR only, partially paid, overdue.
  ('33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'ចាន់ សុភា (demo)', '012 111 001', '+85512111001', 'C-7K4QM',
   'ភរិយាលោក សុខ — ទិញអង្ករជាប្រចាំ (demo note)',
   '11111111-1111-4111-8111-111111111113', '22222222-2222-4222-8222-222222222232'),

  -- Owes both KHR and USD. Currency-separation fixture.
  ('33333333-3333-4333-8333-333333333302', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'លី ចន្ថា (demo)', '012 111 002', '+85512111002', 'C-9M3RT',
   null, '11111111-1111-4111-8111-111111111113', '22222222-2222-4222-8222-222222222232'),

  -- Fully paid.
  ('33333333-3333-4333-8333-333333333303', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'ម៉ៅ ស្រីមុំ (demo)', '012 111 003', '+85512111003', 'C-4TQKL',
   null, '11111111-1111-4111-8111-111111111113', null),

  -- Overpaid — holds credit.
  ('33333333-3333-4333-8333-333333333304', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'ហេង វិចិត្រ (demo)', null, null, 'C-KP34Y',
   'បង់មុនជាទៀងទាត់ (demo note)', '11111111-1111-4111-8111-111111111111', null),

  -- No due date on their debt.
  ('33333333-3333-4333-8333-333333333305', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'ណុប សុផល (demo)', '012 111 005', '+85512111005', null,
   null, '11111111-1111-4111-8111-111111111113', null),

  -- Archived customer with history that must survive.
  ('33333333-3333-4333-8333-333333333306', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', 'អតិថិជនចាស់ (demo archived)', null, null, null,
   null, '11111111-1111-4111-8111-111111111111', null),

  -- Organization B's customer. Must never be visible to organization A.
  ('33333333-3333-4333-8333-333333333401', '22222222-2222-4222-8222-222222222301',
   '22222222-2222-4222-8222-222222222311', 'អតិថិជនហាងផ្សេង (other demo)', '012 222 001', '+85512222001',
   'C-3WYHP', null, '11111111-1111-4111-8111-111111111121', null)
on conflict (id) do nothing;

update public.customers
set archived_at = now() - interval '30 days',
    archived_by = '11111111-1111-4111-8111-111111111111',
    archive_reason = 'ផ្លាស់ទីលំនៅ (demo)'
where id = '33333333-3333-4333-8333-333333333306';

-- --- Transactions ------------------------------------------------------------
-- Dates are relative to now() so the overdue / due-today / upcoming fixtures stay
-- meaningful however long after seeding the tests run.

-- Customer 301: 200,000 KHR debt, overdue, 50,000 paid -> 150,000 remaining.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, due_at, description, client_generated_id, idempotency_key, device_id, created_by
) values (
  '44444444-4444-4444-8444-444444444301', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  'DEBT', 'KHR', 200000,
  now() - interval '20 days',
  (bonchi.merchant_today('Asia/Phnom_Penh') - 7),
  'អង្ករ ៤ បាវ (demo)',
  '44444444-4444-4444-8444-444444444301',
  'TRANSACTION_CREATE:22222222-2222-4222-8222-222222222232:44444444-4444-4444-8444-444444444301',
  '22222222-2222-4222-8222-222222222232', '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, payment_method, description, client_generated_id, idempotency_key, device_id, created_by
) values (
  '44444444-4444-4444-8444-444444444302', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  'PAYMENT', 'KHR', 50000,
  now() - interval '10 days', 'CASH', 'សងមួយផ្នែក (demo)',
  '44444444-4444-4444-8444-444444444302',
  'TRANSACTION_CREATE:22222222-2222-4222-8222-222222222232:44444444-4444-4444-8444-444444444302',
  '22222222-2222-4222-8222-222222222232', '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

-- Customer 302: 100,000 KHR due today, plus $20.00 due in 14 days, minus a $5.00 payment.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, due_at, description, client_generated_id, idempotency_key, created_by
) values
  ('44444444-4444-4444-8444-444444444311', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333302',
   'DEBT', 'KHR', 100000, now() - interval '14 days',
   bonchi.merchant_today('Asia/Phnom_Penh'),
   'សម្ភារផ្សេងៗ (demo)',
   '44444444-4444-4444-8444-444444444311',
   'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444311',
   '11111111-1111-4111-8111-111111111113'),

  ('44444444-4444-4444-8444-444444444312', '22222222-2222-4222-8222-222222222201',
   '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333302',
   'DEBT', 'USD', 2000, now() - interval '7 days',
   (bonchi.merchant_today('Asia/Phnom_Penh') + 14),
   'ទំនិញនាំចូល (demo)',
   '44444444-4444-4444-8444-444444444312',
   'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444312',
   '11111111-1111-4111-8111-111111111113')
on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, payment_method, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444313', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333302',
  'PAYMENT', 'USD', 500, now() - interval '2 days', 'BANK_TRANSFER',
  '44444444-4444-4444-8444-444444444313',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444313',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

-- Customer 303: fully paid.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, due_at, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444321', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333303',
  'DEBT', 'KHR', 75000, now() - interval '30 days',
  (bonchi.merchant_today('Asia/Phnom_Penh') - 15),
  '44444444-4444-4444-8444-444444444321',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444321',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, payment_method, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444322', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333303',
  'PAYMENT', 'KHR', 75000, now() - interval '16 days', 'CASH',
  '44444444-4444-4444-8444-444444444322',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444322',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

-- Customer 304: overpaid — 30,000 debt, 50,000 paid, 20,000 held as credit.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444331', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333304',
  'DEBT', 'KHR', 30000, now() - interval '5 days',
  '44444444-4444-4444-8444-444444444331',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444331',
  '11111111-1111-4111-8111-111111111111'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, payment_method, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444332', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333304',
  'PAYMENT', 'KHR', 50000, now() - interval '4 days', 'CASH',
  '44444444-4444-4444-8444-444444444332',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444332',
  '11111111-1111-4111-8111-111111111111'
) on conflict (id) do nothing;

-- Customer 305: a debt with no due date.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, description, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444341', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333305',
  'DEBT', 'KHR', 45000, now() - interval '3 days',
  'គ្មានថ្ងៃកំណត់សង (demo)',
  '44444444-4444-4444-8444-444444444341',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444341',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

-- Customer 301: a mistyped 500,000 debt, reversed, then re-entered at 50,000.
-- Exercises Acceptance Scenario G end to end.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, description, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444351', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  'DEBT', 'KHR', 500000, now() - interval '2 days',
  'បញ្ចូលចំនួនខុស (demo)',
  '44444444-4444-4444-8444-444444444351',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444351',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, reversal_of_transaction_id, reversal_reason,
  client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444352', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  'REVERSAL', 'KHR', 500000, now() - interval '2 days' + interval '5 minutes',
  '44444444-4444-4444-8444-444444444351',
  'បញ្ចូល 500,000 ជំនួស 50,000 (demo reason)',
  '44444444-4444-4444-8444-444444444352',
  'TRANSACTION_REVERSE:seed:44444444-4444-4444-8444-444444444352',
  '11111111-1111-4111-8111-111111111112'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, due_at, description, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444353', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  'DEBT', 'KHR', 50000, now() - interval '2 days' + interval '6 minutes',
  (bonchi.merchant_today('Asia/Phnom_Penh') + 3),
  'ចំនួនត្រឹមត្រូវ (demo)',
  '44444444-4444-4444-8444-444444444353',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444353',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

-- Archived customer 306: history preserved after archiving.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444361', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333306',
  'DEBT', 'KHR', 20000, now() - interval '120 days',
  '44444444-4444-4444-8444-444444444361',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444361',
  '11111111-1111-4111-8111-111111111111'
) on conflict (id) do nothing;

insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, payment_method, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444362', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333306',
  'PAYMENT', 'KHR', 20000, now() - interval '100 days', 'CASH',
  '44444444-4444-4444-8444-444444444362',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444362',
  '11111111-1111-4111-8111-111111111111'
) on conflict (id) do nothing;

-- Organization B's transaction. Tenant-isolation tests target this row.
insert into public.transactions (
  id, organization_id, shop_id, customer_id, transaction_type, currency, amount_minor,
  occurred_at, client_generated_id, idempotency_key, created_by
) values (
  '44444444-4444-4444-8444-444444444401', '22222222-2222-4222-8222-222222222301',
  '22222222-2222-4222-8222-222222222311', '33333333-3333-4333-8333-333333333401',
  'DEBT', 'KHR', 800000, now() - interval '6 days',
  '44444444-4444-4444-8444-444444444401',
  'TRANSACTION_CREATE:seed:44444444-4444-4444-8444-444444444401',
  '11111111-1111-4111-8111-111111111121'
) on conflict (id) do nothing;

-- --- Reminders ---------------------------------------------------------------

insert into public.reminders
  (id, organization_id, shop_id, customer_id, transaction_id, kind, on_date, fire_at, created_by)
values (
  '55555555-5555-4555-8555-555555555301', '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301',
  '44444444-4444-4444-8444-444444444353', 'DAY_BEFORE',
  (bonchi.merchant_today('Asia/Phnom_Penh') + 2),
  (bonchi.merchant_today('Asia/Phnom_Penh') + 2)::timestamp at time zone 'Asia/Phnom_Penh' + interval '8 hours',
  '11111111-1111-4111-8111-111111111113'
) on conflict (id) do nothing;

insert into public.notification_preferences (organization_id, user_id) values
  ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111113')
on conflict (organization_id, user_id) do nothing;

-- --- A pending offline sync operation ----------------------------------------
-- Represents a debt recorded on the counter phone that has not uploaded yet.

insert into public.sync_operations
  (organization_id, device_id, user_id, kind, idempotency_key, entity_type, entity_id, state, attempts)
values (
  '22222222-2222-4222-8222-222222222201',
  '22222222-2222-4222-8222-222222222232',
  '11111111-1111-4111-8111-111111111113',
  'TRANSACTION_CREATE',
  'TRANSACTION_CREATE:22222222-2222-4222-8222-222222222232:pending-demo-operation',
  'transaction',
  null,
  'PENDING',
  2
) on conflict (organization_id, idempotency_key) do nothing;

-- --- Subscription ------------------------------------------------------------

insert into public.subscription_plans (id, name, price_minor, currency, max_customers, max_members, features) values
  ('free', 'Free', 0, 'USD', 100, 1, array['core_ledger', 'reminders', 'csv_export']),
  ('shop', 'Shop', 300, 'USD', 2000, 5, array['core_ledger', 'reminders', 'csv_export', 'pdf_statement', 'staff_accounts']),
  ('wholesale', 'Wholesale', 900, 'USD', null, 20,
   array['core_ledger', 'reminders', 'csv_export', 'pdf_statement', 'staff_accounts', 'installments'])
on conflict (id) do nothing;

insert into public.subscriptions (organization_id, plan_id, status, trial_ends_at) values
  ('22222222-2222-4222-8222-222222222201', 'shop', 'TRIALING', now() + interval '30 days'),
  ('22222222-2222-4222-8222-222222222301', 'free', 'ACTIVE', null)
on conflict (organization_id) do nothing;

commit;

-- Make the cached balances agree with the ledger we just inserted. In normal
-- operation the triggers keep this current; the seed calls it explicitly because
-- rows were inserted in bulk.
select bonchi.refresh_ledger_account(customer_id, currency)
from (select distinct customer_id, currency from public.transactions) accounts;

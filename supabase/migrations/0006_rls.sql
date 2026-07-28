-- =============================================================================
-- 0006_rls.sql — authorization helpers and row-level security
-- =============================================================================
-- This file is the security boundary. Client-side permission checks in
-- @bonchi/domain decide which buttons to draw; these policies decide what data
-- exists. Every tenant-owned table has RLS enabled with no permissive default.
--
-- The role/permission matrix here mirrors `packages/domain/src/access/roles.ts`.
-- supabase/tests/ asserts both, so the two cannot drift apart silently.
--
-- Helper functions are SECURITY DEFINER with a pinned search_path: they must read
-- organization_members regardless of the caller's own policies, and must not be
-- hijackable by a schema placed earlier on the caller's search_path.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Authorization predicates
-- -----------------------------------------------------------------------------

create or replace function bonchi.is_active_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.status = 'ACTIVE'
  );
$$;

comment on function bonchi.is_active_member is
  'True only for an ACTIVE membership. An INVITED or ARCHIVED member has no access at all.';

create or replace function bonchi.member_role(p_organization_id uuid)
returns bonchi.organization_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from public.organization_members m
  where m.organization_id = p_organization_id
    and m.user_id = auth.uid()
    and m.status = 'ACTIVE'
  limit 1;
$$;

-- Role ranking, so policies can express "manager or above" without listing roles.
create or replace function bonchi.role_rank(p_role bonchi.organization_role)
returns integer
language sql
immutable
as $$
  select case p_role
    when 'OWNER' then 40
    when 'MANAGER' then 30
    when 'CASHIER' then 20
    when 'VIEWER' then 10
    else 0
  end;
$$;

create or replace function bonchi.has_role_at_least(
  p_organization_id uuid,
  p_minimum bonchi.organization_role
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    bonchi.role_rank(bonchi.member_role(p_organization_id)) >= bonchi.role_rank(p_minimum),
    false
  );
$$;

comment on function bonchi.has_role_at_least is
  'Mirrors isAtLeast() in @bonchi/domain. OWNER > MANAGER > CASHIER > VIEWER.';

create or replace function bonchi.is_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select bonchi.member_role(p_organization_id) = 'OWNER';
$$;

-- Shop-level access. One shop per organization today, so membership is
-- sufficient; the seam exists so per-shop staff assignment does not require
-- rewriting every policy later.
create or replace function bonchi.can_access_shop(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.shops s
    where s.id = p_shop_id
      and bonchi.is_active_member(s.organization_id)
  );
$$;

-- Platform staff. Being staff grants aggregate operational access only.
create or replace function bonchi.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = auth.uid()
  );
$$;

-- Reading a merchant's records as staff requires a live, unexpired, unrevoked
-- grant. Expiry is checked here so no policy can forget it.
create or replace function bonchi.has_support_access(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.support_access_grants g
    where g.organization_id = p_organization_id
      and g.admin_user_id = auth.uid()
      and g.revoked_at is null
      and g.expires_at > now()
  );
$$;

comment on function bonchi.has_support_access is
  'Time-boxed staff access to one organization. Never true by default — a platform admin with no grant sees no merchant data.';

-- The predicate used by every read policy on tenant data.
create or replace function bonchi.can_read_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select bonchi.is_active_member(p_organization_id)
      or bonchi.has_support_access(p_organization_id);
$$;

-- Suspension stops writes but never reads: a suspended merchant must still be
-- able to see and export their own records.
create or replace function bonchi.organization_is_writable(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organizations o
    where o.id = p_organization_id
      and o.suspended_at is null
  );
$$;

create or replace function bonchi.can_write_organization(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select bonchi.is_active_member(p_organization_id)
     and bonchi.organization_is_writable(p_organization_id);
$$;

-- =============================================================================
-- Enable RLS everywhere. No table is left open.
-- =============================================================================

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.shops enable row level security;
alter table public.devices enable row level security;
alter table public.customers enable row level security;
alter table public.customer_contacts enable row level security;
alter table public.ledger_accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.transaction_allocations enable row level security;
alter table public.transaction_items enable row level security;
alter table public.attachments enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.reminders enable row level security;
alter table public.installment_plans enable row level security;
alter table public.installment_schedules enable row level security;
alter table public.audit_logs enable row level security;
alter table public.sync_operations enable row level security;
alter table public.subscription_plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.feature_flags enable row level security;
alter table public.platform_admins enable row level security;
alter table public.support_access_grants enable row level security;

-- Force RLS for table owners too, so a mistake in a SECURITY DEFINER function
-- cannot quietly bypass tenancy.
alter table public.transactions force row level security;
alter table public.customers force row level security;
alter table public.attachments force row level security;

-- -----------------------------------------------------------------------------
-- profiles
-- -----------------------------------------------------------------------------

create policy profiles_select_self
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Co-members can see each other's display names — the transaction timeline shows
-- who recorded each entry.
create policy profiles_select_co_members
  on public.profiles for select
  to authenticated
  using (
    exists (
      select 1
      from public.organization_members mine
      join public.organization_members theirs
        on theirs.organization_id = mine.organization_id
      where mine.user_id = auth.uid()
        and mine.status = 'ACTIVE'
        and theirs.user_id = public.profiles.id
        and theirs.status in ('ACTIVE', 'ARCHIVED')
    )
  );

create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------

create policy organizations_select_members
  on public.organizations for select
  to authenticated
  using (bonchi.can_read_organization(id));

-- Any authenticated user may create their own organization during onboarding.
-- `created_by` is pinned to the caller so a row cannot be attributed elsewhere.
create policy organizations_insert_self
  on public.organizations for insert
  to authenticated
  with check (created_by = auth.uid());

create policy organizations_update_owner
  on public.organizations for update
  to authenticated
  using (bonchi.is_owner(id) and bonchi.organization_is_writable(id))
  with check (bonchi.is_owner(id));

-- -----------------------------------------------------------------------------
-- organization_members
-- -----------------------------------------------------------------------------

create policy organization_members_select_own_row
  on public.organization_members for select
  to authenticated
  using (user_id = auth.uid());

-- Seeing the whole roster requires member:read, i.e. manager or above.
create policy organization_members_select_roster
  on public.organization_members for select
  to authenticated
  using (bonchi.has_role_at_least(organization_id, 'MANAGER'));

-- Bootstrapping: the creator of a brand-new organization inserts their own
-- OWNER membership. Anything else requires an existing owner.
create policy organization_members_insert_bootstrap
  on public.organization_members for insert
  to authenticated
  with check (
    (
      user_id = auth.uid()
      and role = 'OWNER'
      and status = 'ACTIVE'
      and exists (
        select 1
        from public.organizations o
        where o.id = organization_id
          and o.created_by = auth.uid()
      )
      and not exists (
        select 1
        from public.organization_members existing
        where existing.organization_id = organization_members.organization_id
      )
    )
    or bonchi.is_owner(organization_id)
  );

-- Only an owner manages membership. A cashier or manager cannot change roles;
-- this is asserted by supabase/tests/rls_tenancy.test.sql.
create policy organization_members_update_owner
  on public.organization_members for update
  to authenticated
  using (bonchi.is_owner(organization_id) and bonchi.organization_is_writable(organization_id))
  with check (bonchi.is_owner(organization_id));

-- -----------------------------------------------------------------------------
-- shops
-- -----------------------------------------------------------------------------

create policy shops_select_members
  on public.shops for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy shops_insert_owner
  on public.shops for insert
  to authenticated
  with check (bonchi.is_owner(organization_id) and bonchi.organization_is_writable(organization_id));

create policy shops_update_manager
  on public.shops for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.organization_is_writable(organization_id)
  )
  with check (bonchi.has_role_at_least(organization_id, 'MANAGER'));

-- -----------------------------------------------------------------------------
-- devices
-- -----------------------------------------------------------------------------

create policy devices_select_own
  on public.devices for select
  to authenticated
  using (user_id = auth.uid() or bonchi.is_owner(organization_id));

create policy devices_insert_own
  on public.devices for insert
  to authenticated
  with check (user_id = auth.uid() and bonchi.is_active_member(organization_id));

-- A user updates their own device; an owner may revoke any device in the
-- organization (remote sign-out).
create policy devices_update_own_or_owner
  on public.devices for update
  to authenticated
  using (user_id = auth.uid() or bonchi.is_owner(organization_id))
  with check (user_id = auth.uid() or bonchi.is_owner(organization_id));

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------

create policy customers_select_members
  on public.customers for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

-- Cashiers and above may add customers. A viewer may not.
create policy customers_insert_cashier
  on public.customers for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
    and bonchi.can_access_shop(shop_id)
  );

-- A cashier may correct a customer's details but may not archive or un-archive
-- one — `customer:archive` is a manager permission in the domain matrix, and
-- archiving is what removes a debtor from the working list.
--
-- Requiring `archived_at is null` in both USING and WITH CHECK expresses exactly
-- that: a cashier can only touch a live customer, and cannot produce an archived
-- row. Policies are OR-ed, so a manager still passes via the policy below.
create policy customers_update_cashier
  on public.customers for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
    and archived_at is null
  )
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and archived_at is null
  );

create policy customers_update_manager
  on public.customers for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (bonchi.has_role_at_least(organization_id, 'MANAGER'));

-- No DELETE policy exists for customers, DELETE is not granted, and the
-- reject_delete trigger backs both up. Archiving is an UPDATE.

-- -----------------------------------------------------------------------------
-- customer_contacts
-- -----------------------------------------------------------------------------

create policy customer_contacts_select_members
  on public.customer_contacts for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy customer_contacts_write_cashier
  on public.customer_contacts for all
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  );

-- -----------------------------------------------------------------------------
-- ledger_accounts
-- -----------------------------------------------------------------------------

create policy ledger_accounts_select_members
  on public.ledger_accounts for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

-- Cached totals are maintained by triggers, but a client may create the account
-- row so an offline-first write path does not need a round trip.
create policy ledger_accounts_insert_cashier
  on public.ledger_accounts for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  );

create policy ledger_accounts_update_cashier
  on public.ledger_accounts for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (bonchi.has_role_at_least(organization_id, 'CASHIER'));

-- -----------------------------------------------------------------------------
-- transactions — the most important policies in the system
-- -----------------------------------------------------------------------------

create policy transactions_select_members
  on public.transactions for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

-- Cashiers record debts and payments. `created_by` is pinned to the caller so
-- one member cannot attribute an entry to another.
create policy transactions_insert_cashier
  on public.transactions for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
    and bonchi.can_access_shop(shop_id)
    and created_by = auth.uid()
    -- A reversal requires manager or above. A cashier who mistypes an amount
    -- must ask someone senior to correct it; that is the control.
    and (
      transaction_type <> 'REVERSAL'
      or bonchi.has_role_at_least(organization_id, 'MANAGER')
    )
    -- Adjustments rewrite a balance, so they need the same authority.
    and (
      transaction_type <> 'ADJUSTMENT'
      or bonchi.has_role_at_least(organization_id, 'MANAGER')
    )
  );

-- UPDATE is permitted only so the sync layer can stamp synced_at. Every
-- financial column is frozen by the immutability trigger, so this policy cannot
-- be used to alter an amount.
create policy transactions_update_sync_metadata
  on public.transactions for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (bonchi.has_role_at_least(organization_id, 'CASHIER'));

-- Deliberately no DELETE policy. Combined with the reject_delete trigger, a
-- financial record cannot be removed by anyone, including an owner.

-- -----------------------------------------------------------------------------
-- transaction_allocations / transaction_items
-- -----------------------------------------------------------------------------

create policy transaction_allocations_select_members
  on public.transaction_allocations for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy transaction_allocations_insert_cashier
  on public.transaction_allocations for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  );

create policy transaction_items_select_members
  on public.transaction_items for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy transaction_items_insert_cashier
  on public.transaction_items for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  );

-- -----------------------------------------------------------------------------
-- attachments
-- -----------------------------------------------------------------------------

create policy attachments_select_members
  on public.attachments for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy attachments_insert_cashier
  on public.attachments for insert
  to authenticated
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
    and uploaded_by = auth.uid()
    -- The path must be inside this organization's prefix. Mirrors the storage
    -- policy in 0007_storage.sql: metadata and object must agree.
    and storage_path like (organization_id::text || '/%')
  );

-- Deleting an attachment is a soft delete (an UPDATE) and needs manager or above.
create policy attachments_update_manager
  on public.attachments for update
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (bonchi.has_role_at_least(organization_id, 'MANAGER'));

-- -----------------------------------------------------------------------------
-- notification_preferences / reminders
-- -----------------------------------------------------------------------------

create policy notification_preferences_own
  on public.notification_preferences for all
  to authenticated
  using (user_id = auth.uid() and bonchi.is_active_member(organization_id))
  with check (user_id = auth.uid() and bonchi.is_active_member(organization_id));

create policy reminders_select_members
  on public.reminders for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy reminders_write_cashier
  on public.reminders for all
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (
    bonchi.has_role_at_least(organization_id, 'CASHIER')
    and bonchi.can_write_organization(organization_id)
  );

-- -----------------------------------------------------------------------------
-- installments
-- -----------------------------------------------------------------------------

create policy installment_plans_select_members
  on public.installment_plans for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy installment_plans_write_manager
  on public.installment_plans for all
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  );

create policy installment_schedules_select_members
  on public.installment_schedules for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy installment_schedules_write_manager
  on public.installment_schedules for all
  to authenticated
  using (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  )
  with check (
    bonchi.has_role_at_least(organization_id, 'MANAGER')
    and bonchi.can_write_organization(organization_id)
  );

-- -----------------------------------------------------------------------------
-- audit_logs
-- -----------------------------------------------------------------------------

-- Reading the audit trail requires audit:view, i.e. manager or above.
create policy audit_logs_select_manager
  on public.audit_logs for select
  to authenticated
  using (
    organization_id is not null
    and bonchi.has_role_at_least(organization_id, 'MANAGER')
  );

-- Any active member may append an entry for their own actions. `actor_user_id`
-- is pinned so an entry cannot be forged against someone else.
create policy audit_logs_insert_member
  on public.audit_logs for insert
  to authenticated
  with check (
    actor_user_id = auth.uid()
    and (organization_id is null or bonchi.is_active_member(organization_id))
  );

-- -----------------------------------------------------------------------------
-- sync_operations
-- -----------------------------------------------------------------------------

create policy sync_operations_select_members
  on public.sync_operations for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

create policy sync_operations_write_member
  on public.sync_operations for all
  to authenticated
  using (user_id = auth.uid() and bonchi.is_active_member(organization_id))
  with check (user_id = auth.uid() and bonchi.is_active_member(organization_id));

-- -----------------------------------------------------------------------------
-- subscriptions, plans, flags
-- -----------------------------------------------------------------------------

create policy subscription_plans_select_all
  on public.subscription_plans for select
  to authenticated
  using (is_active);

create policy subscriptions_select_members
  on public.subscriptions for select
  to authenticated
  using (bonchi.can_read_organization(organization_id));

-- Billing changes are the owner's alone.
create policy subscriptions_update_owner
  on public.subscriptions for update
  to authenticated
  using (bonchi.is_owner(organization_id))
  with check (bonchi.is_owner(organization_id));

create policy feature_flags_select_all
  on public.feature_flags for select
  to authenticated
  using (true);

-- -----------------------------------------------------------------------------
-- platform administration
-- -----------------------------------------------------------------------------

create policy platform_admins_select_self
  on public.platform_admins for select
  to authenticated
  using (user_id = auth.uid());

-- A staff member sees their own grants; a merchant owner sees who has been
-- granted access to their organization, and why.
create policy support_access_grants_select
  on public.support_access_grants for select
  to authenticated
  using (admin_user_id = auth.uid() or bonchi.is_owner(organization_id));

-- =============================================================================
-- Table privileges
-- =============================================================================
-- Supabase grants broad privileges to `authenticated` by default. They are
-- restated explicitly here so this schema is self-describing, and so DELETE can
-- be withheld from the financial tables at the privilege level as well as by
-- trigger. Two independent mechanisms have to fail before financial history can
-- be destroyed.
-- =============================================================================

grant select, insert, update on
  public.profiles,
  public.organizations,
  public.organization_members,
  public.shops,
  public.devices,
  public.customers,
  public.customer_contacts,
  public.ledger_accounts,
  public.transactions,
  public.transaction_allocations,
  public.transaction_items,
  public.attachments,
  public.notification_preferences,
  public.reminders,
  public.installment_plans,
  public.installment_schedules,
  public.sync_operations,
  public.subscriptions
to authenticated;

-- Append-only: insert and read, never update or delete.
grant select, insert on public.audit_logs to authenticated;
grant usage, select on sequence public.audit_logs_id_seq to authenticated;

-- Read-only catalogues.
grant select on public.subscription_plans, public.feature_flags to authenticated;
grant select on public.platform_admins, public.support_access_grants to authenticated;

-- DELETE is granted on nothing. Contact rows and reminders are the only
-- genuinely removable data, and both are handled by soft-delete columns.
revoke delete on all tables in schema public from authenticated;

-- Privileges on the derived views and RPCs are granted in 0010_grants.sql, once
-- those objects exist.

-- =============================================================================
-- Anonymous access: none
-- =============================================================================
-- Every policy above is scoped `to authenticated`, so the `anon` role matches no
-- policy on any table and can read nothing. The privileges are revoked as well,
-- so the denial does not depend on RLS alone. Asserted by
-- supabase/tests/rls_tenancy.test.sql.
-- =============================================================================

revoke all on all tables in schema public from anon;

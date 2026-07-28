-- =============================================================================
-- 0010_grants.sql — privileges on derived views and RPCs
-- =============================================================================
-- Runs last, once every view and function exists. Keeping these grants in one
-- place after the objects are defined avoids the ordering trap of granting on
-- something a later migration creates.
-- =============================================================================

-- The views are declared `security_invoker`, so a SELECT here is still filtered
-- by the caller's own RLS policies on the underlying tables. Granting select is
-- not granting a way around tenancy.
grant select on
  public.active_transactions,
  public.charge_settlements,
  public.customer_balances,
  public.shop_totals
to authenticated;

grant execute on function
  public.record_transaction(
    uuid, uuid, uuid, bonchi.transaction_type, bonchi.currency_code, bigint, timestamptz, text,
    uuid, date, bonchi.adjustment_direction, bonchi.payment_method, text, text, numeric,
    text, text, text, uuid, text, jsonb
  ),
  public.pull_changes(uuid, timestamptz, integer),
  public.register_device(uuid, uuid, text, text, text, text),
  public.verify_balances(uuid),
  public.rebuild_ledger_accounts(uuid),
  public.write_audit_log(uuid, text, text, text, jsonb, uuid),
  public.build_attachment_path(uuid, uuid, uuid, text)
to authenticated;

-- Helper predicates are called from inside policies, which run as the policy
-- owner, but the storage policies evaluate them in the caller's context.
grant execute on function
  bonchi.is_active_member(uuid),
  bonchi.member_role(uuid),
  bonchi.has_role_at_least(uuid, bonchi.organization_role),
  bonchi.is_owner(uuid),
  bonchi.can_access_shop(uuid),
  bonchi.can_read_organization(uuid),
  bonchi.can_write_organization(uuid),
  bonchi.organization_is_writable(uuid),
  bonchi.is_platform_admin(),
  bonchi.has_support_access(uuid),
  bonchi.merchant_today(text),
  bonchi.storage_path_organization(text),
  bonchi.role_rank(bonchi.organization_role)
to authenticated;

-- `refresh_ledger_account` is called by triggers running as the definer, and by
-- the seed script. It is not part of the client surface.
revoke all on function bonchi.refresh_ledger_account(uuid, bonchi.currency_code)
  from authenticated, anon;

-- Nothing in the private helper schema is reachable anonymously.
revoke all on all functions in schema bonchi from anon;
revoke usage on schema bonchi from anon;

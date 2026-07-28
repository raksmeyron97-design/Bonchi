-- =============================================================================
-- 0007_storage.sql — private attachment storage
-- =============================================================================
-- Attachments are receipts, debt evidence and customer photos. They are private
-- without exception: the bucket is not public, and files are only ever reached
-- through short-lived signed URLs created for an authorized member.
--
-- The tenant boundary is the first path segment:
--
--     <organization_id>/<shop_id>/<attachment_id>.<ext>
--
-- Every policy below compares that first segment to the caller's memberships, so
-- one shop cannot enumerate or read another shop's files even if it guesses a
-- path. `attachments.storage_path` carries the same rule as a CHECK in
-- 0006_rls.sql, so metadata and object storage cannot disagree.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments',
  'attachments',
  false, -- never public
  8388608, -- 8 MB, matches MAX_ATTACHMENT_BYTES
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Extracts the organization id from an object path, returning null when the
-- leading segment is not a UUID. A malformed path therefore fails closed.
create or replace function bonchi.storage_path_organization(p_name text)
returns uuid
language plpgsql
immutable
as $$
declare
  v_first text;
begin
  v_first := split_part(p_name, '/', 1);
  if v_first = '' then
    return null;
  end if;
  return v_first::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;

comment on function bonchi.storage_path_organization is
  'First path segment as a UUID, or null. Null means the path is malformed, and every policy below then denies.';

-- Enabling RLS is conditional, and the reason is worth stating.
--
-- On a real Supabase instance `storage.objects` is owned by
-- `supabase_storage_admin`, RLS is ALREADY enabled, and the `postgres` role that
-- runs migrations may not ALTER the table — an unconditional
-- `alter table ... enable row level security` fails with
-- "must be owner of table objects".
--
-- The test harness (supabase/tests/00_auth_shim.sql) creates its own
-- `storage.objects` owned by the migration role, where RLS must be enabled
-- explicitly. Checking first makes this one migration correct in both places.
--
-- `postgres` IS permitted to create policies on the table, which is why the
-- policies below need no special handling.
do $$
declare
  v_rls_enabled boolean;
begin
  select c.relrowsecurity
  into v_rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage'
    and c.relname = 'objects';

  if v_rls_enabled is false then
    alter table storage.objects enable row level security;
  end if;
end;
$$;

-- --- Read --------------------------------------------------------------------
-- Any active member of the owning organization may read. Support staff may read
-- only while holding a live, reasoned access grant.

drop policy if exists attachments_read_own_organization on storage.objects;
create policy attachments_read_own_organization
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and bonchi.storage_path_organization(name) is not null
    and bonchi.can_read_organization(bonchi.storage_path_organization(name))
  );

-- --- Write -------------------------------------------------------------------
-- Cashiers and above may upload, but only inside their own organization's prefix.

drop policy if exists attachments_insert_own_organization on storage.objects;
create policy attachments_insert_own_organization
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'attachments'
    and bonchi.storage_path_organization(name) is not null
    and bonchi.has_role_at_least(bonchi.storage_path_organization(name), 'CASHIER')
    and bonchi.can_write_organization(bonchi.storage_path_organization(name))
    and owner_id = auth.uid()::text
  );

-- Overwriting an existing receipt is a form of editing financial evidence, so it
-- requires manager or above — the same authority as reversing a transaction.
drop policy if exists attachments_update_manager on storage.objects;
create policy attachments_update_manager
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'attachments'
    and bonchi.storage_path_organization(name) is not null
    and bonchi.has_role_at_least(bonchi.storage_path_organization(name), 'MANAGER')
  )
  with check (
    bucket_id = 'attachments'
    and bonchi.storage_path_organization(name) is not null
    and bonchi.has_role_at_least(bonchi.storage_path_organization(name), 'MANAGER')
  );

-- Hard deletion is restricted to managers and above and is audited by the
-- application. Merchants normally soft-delete via attachments.deleted_at, which
-- keeps the evidence trail intact.
drop policy if exists attachments_delete_manager on storage.objects;
create policy attachments_delete_manager
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'attachments'
    and bonchi.storage_path_organization(name) is not null
    and bonchi.has_role_at_least(bonchi.storage_path_organization(name), 'MANAGER')
    and bonchi.can_write_organization(bonchi.storage_path_organization(name))
  );

-- =============================================================================
-- Path builder
-- =============================================================================
-- Used by the client so a path is never hand-assembled at a call site.

create or replace function public.build_attachment_path(
  p_organization_id uuid,
  p_shop_id uuid,
  p_attachment_id uuid,
  p_extension text
)
returns text
language plpgsql
immutable
as $$
declare
  v_extension text;
begin
  -- Extension is constrained to a short alphanumeric token: it becomes part of
  -- an object key, so nothing else may enter it.
  v_extension := lower(regexp_replace(coalesce(p_extension, 'bin'), '[^A-Za-z0-9]', '', 'g'));
  if v_extension = '' or length(v_extension) > 10 then
    v_extension := 'bin';
  end if;

  return p_organization_id::text || '/' || p_shop_id::text || '/'
    || p_attachment_id::text || '.' || v_extension;
end;
$$;

comment on function public.build_attachment_path is
  'Builds a tenant-scoped object key. The organization id must lead the path — that is what the storage policies enforce.';

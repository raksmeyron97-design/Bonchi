-- =============================================================================
-- 40_storage.test.sql — attachment isolation
-- =============================================================================
-- Attachments are photographed receipts and debt evidence. The tenant boundary is
-- the first segment of the object path, so these tests concentrate on path
-- handling: a crafted or malformed path must fail closed rather than land in
-- another shop's prefix.
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
  CASHIER constant uuid := '11111111-1111-4111-8111-111111111113';
  VIEWER constant uuid := '11111111-1111-4111-8111-111111111114';
  CUST_A constant uuid := '33333333-3333-4333-8333-333333333301';
  v_id uuid;
  v_path text;
  v_bucket_public boolean;
begin
  raise notice '';
  raise notice '== The bucket is private ==';

  select public into v_bucket_public from storage.buckets where id = 'attachments';
  perform test.assert_equals(v_bucket_public, false,
    'the attachments bucket is not public — files are only reachable through signed URLs');

  perform test.assert_equals(
    (select file_size_limit from storage.buckets where id = 'attachments'),
    8388608::bigint,
    'the bucket enforces the 8 MB limit server-side, not just in the client');

  perform test.assert_true(
    (select 'application/pdf' = any(allowed_mime_types) from storage.buckets where id = 'attachments'),
    'the bucket restricts MIME types server-side');

  perform test.assert_true(
    (select not ('text/html' = any(allowed_mime_types)) from storage.buckets where id = 'attachments'),
    'HTML cannot be uploaded — it would be a stored-XSS vector if ever served inline');

  raise notice '';
  raise notice '== Path construction ==';

  v_id := gen_random_uuid();
  v_path := public.build_attachment_path(ORG_A, SHOP_A, v_id, 'jpg');
  perform test.assert_true(v_path like ORG_A::text || '/%',
    'a built path always begins with the organization id');
  perform test.assert_equals(
    bonchi.storage_path_organization(v_path), ORG_A,
    'the organization is recoverable from the path');

  -- A hostile extension cannot escape the key.
  perform test.assert_equals(
    public.build_attachment_path(ORG_A, SHOP_A, v_id, '../../etc/passwd'),
    ORG_A::text || '/' || SHOP_A::text || '/' || v_id::text || '.etcpasswd',
    'a traversal sequence in the extension is stripped');

  perform test.assert_equals(
    public.build_attachment_path(ORG_A, SHOP_A, v_id, ''),
    ORG_A::text || '/' || SHOP_A::text || '/' || v_id::text || '.bin',
    'an empty extension falls back to .bin');

  -- Malformed paths resolve to null, and every policy denies on null.
  perform test.assert_equals(bonchi.storage_path_organization('not-a-uuid/file.jpg'), null::uuid,
    'a non-UUID leading segment resolves to null, so policies fail closed');
  perform test.assert_equals(bonchi.storage_path_organization('file.jpg'), null::uuid,
    'a bare filename resolves to null');
  perform test.assert_equals(bonchi.storage_path_organization(''), null::uuid,
    'an empty path resolves to null');
  perform test.assert_equals(bonchi.storage_path_organization('../secret/file.jpg'), null::uuid,
    'a traversal prefix resolves to null');

  raise notice '';
  raise notice '== Uploading is confined to your own prefix ==';

  perform test.login(CASHIER);

  v_id := gen_random_uuid();
  v_path := public.build_attachment_path(ORG_A, SHOP_A, v_id, 'jpg');
  insert into storage.objects (bucket_id, name, owner_id)
  values ('attachments', v_path, CASHIER::text);
  perform test.assert_true(true, 'a cashier can upload into their own organization''s prefix');

  -- The metadata row carries the same rule as a CHECK, so the two cannot disagree.
  insert into public.attachments
    (id, organization_id, shop_id, customer_id, kind, storage_path, mime_type, byte_size,
     file_name, uploaded_by)
  values
    (v_id, ORG_A, SHOP_A, CUST_A, 'RECEIPT', v_path, 'image/jpeg', 20480,
     'receipt.jpg', CASHIER);
  perform test.assert_true(true, 'and record the matching metadata row');

  perform test.assert_raises(
    format($q$insert into storage.objects (bucket_id, name, owner_id)
             values ('attachments', '%s', '%s')$q$,
           public.build_attachment_path(ORG_B, SHOP_B, gen_random_uuid(), 'jpg'), CASHIER::text),
    'a cashier cannot upload into another organization''s prefix',
    'row-level security');

  perform test.assert_raises(
    format($q$insert into storage.objects (bucket_id, name, owner_id)
             values ('attachments', 'receipt-at-the-root.jpg', '%s')$q$, CASHIER::text),
    'an object cannot be written outside any organization prefix',
    'row-level security');

  perform test.assert_raises(
    format($q$insert into storage.objects (bucket_id, name, owner_id)
             values ('attachments', '../%s/escape.jpg', '%s')$q$, ORG_B::text, CASHIER::text),
    'a traversal path is refused',
    'row-level security');

  -- Metadata whose path points at another tenant is refused even though the
  -- organization_id column says otherwise.
  perform test.assert_raises(
    format($q$insert into public.attachments
             (id, organization_id, shop_id, kind, storage_path, mime_type, byte_size,
              file_name, uploaded_by)
             values ('%s', '%s', '%s', 'RECEIPT', '%s/stolen.jpg', 'image/jpeg', 1024,
                     'stolen.jpg', '%s')$q$,
           gen_random_uuid(), ORG_A, SHOP_A, ORG_B::text, CASHIER),
    'attachment metadata cannot claim a path outside its own organization',
    'row-level security');

  perform test.assert_raises(
    format($q$insert into public.attachments
             (id, organization_id, shop_id, kind, storage_path, mime_type, byte_size,
              file_name, uploaded_by)
             values ('%s', '%s', '%s', 'RECEIPT', '%s', 'text/html', 1024,
                     'evil.html', '%s')$q$,
           gen_random_uuid(), ORG_A, SHOP_A,
           public.build_attachment_path(ORG_A, SHOP_A, gen_random_uuid(), 'html'), CASHIER),
    'an HTML attachment is refused by the metadata constraint too',
    'mime_type_check');

  -- A cashier may upload evidence but not remove it.
  perform test.assert_affects_no_rows(
    format($q$update public.attachments set deleted_at = now() where id = '%s'$q$, v_id),
    'a cashier cannot soft-delete an attachment');

  perform test.assert_affects_no_rows(
    format($q$delete from storage.objects where bucket_id = 'attachments' and name = '%s'$q$, v_path),
    'a cashier cannot hard-delete a stored object');

  perform test.reset_role();

  raise notice '';
  raise notice '== Reading is confined to your own organization ==';

  perform test.login(OWNER_A);
  perform test.assert_row_count(
    format($q$select 1 from storage.objects where name = '%s'$q$, v_path),
    1, 'owner A can read an object in their own prefix');
  perform test.reset_role();

  perform test.login(OWNER_B);
  perform test.assert_no_rows(
    format($q$select 1 from storage.objects where name = '%s'$q$, v_path),
    'owner B cannot see organization A''s object, even knowing the exact path');
  perform test.assert_no_rows(
    'select 1 from storage.objects',
    'and cannot enumerate the bucket at all');
  perform test.assert_no_rows(
    format($q$select 1 from public.attachments where id = '%s'$q$, v_id),
    'owner B cannot read organization A''s attachment metadata');
  perform test.reset_role();

  perform test.logout();
  perform test.assert_raises(
    'select 1 from storage.objects',
    'anon cannot read stored objects',
    'permission denied');
  perform test.reset_role();

  raise notice '';
  raise notice '== A viewer cannot upload ==';

  perform test.login(VIEWER);
  perform test.assert_raises(
    format($q$insert into storage.objects (bucket_id, name, owner_id)
             values ('attachments', '%s', '%s')$q$,
           public.build_attachment_path(ORG_A, SHOP_A, gen_random_uuid(), 'jpg'), VIEWER::text),
    'a viewer cannot upload an attachment',
    'row-level security');
  perform test.reset_role();

  raise notice '';
  raise notice '== A manager can remove evidence, and the path stays frozen ==';

  perform test.login('11111111-1111-4111-8111-111111111112');
  update public.attachments set deleted_at = now(), deleted_by = '11111111-1111-4111-8111-111111111112'
  where id = v_id;
  perform test.assert_true(true, 'a manager can soft-delete an attachment');

  perform test.assert_raises(
    format($q$update public.attachments set storage_path = 'somewhere/else.jpg' where id = '%s'$q$, v_id),
    'the storage path is immutable — it is the security boundary',
    'storage_path is immutable');
  perform test.reset_role();

  -- Clean up so later runs start from the seeded fixture set.
  delete from storage.objects where bucket_id = 'attachments' and name = v_path;
  delete from public.attachments where id = v_id;

  raise notice '';
  raise notice 'STORAGE SUITE COMPLETE';
end;
$$;

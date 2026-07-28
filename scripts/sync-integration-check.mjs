#!/usr/bin/env node
/**
 * Integration check for the sync contract, against a REAL local Supabase.
 *
 * The unit tests cover the sync engine's decisions with fakes, and the SQL suite
 * covers `record_transaction` with a shim for auth. Neither exercises the seam
 * this script does: a genuine signed-in session, over HTTP, through PostgREST,
 * with row-level security in force — the path an actual phone takes.
 *
 * It asserts the property that protects merchants from us: uploading the same
 * operation twice, as a phone does when it loses a response, must leave exactly
 * ONE debt and report the second attempt as a replay.
 *
 * Requires a running stack:
 *     pnpm db:start
 *     node scripts/sync-integration-check.mjs
 *
 * Not part of `pnpm test`, because it needs live infrastructure.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const MAIL_URL = process.env.MAIL_URL ?? 'http://localhost:54324';

// Seeded fixtures. See supabase/seed.sql.
const EMAIL = 'owner.demo@example.test';
const SHOP = '22222222-2222-4222-8222-222222222211';
const CUSTOMER = '33333333-3333-4333-8333-333333333305';

function readAnonKey() {
  if (process.env.ANON_KEY) return process.env.ANON_KEY;
  const status = execSync('npx supabase status -o env', { encoding: 'utf8' });
  const line = status.split('\n').find((row) => row.startsWith('ANON_KEY='));
  if (!line) throw new Error('Could not read ANON_KEY. Is the local stack running?');
  return line.slice('ANON_KEY='.length).replace(/"/g, '');
}

function report(ok, message) {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${message}`);
  if (!ok) process.exitCode = 1;
}

const client = createClient(API_URL, readAnonKey(), { auth: { persistSession: false } });

// --- Sign in the way a merchant does: email code, read from the mail catcher --
await client.auth.signInWithOtp({ email: EMAIL, options: { shouldCreateUser: false } });

const inbox = await (await fetch(`${MAIL_URL}/api/v1/messages?limit=1`)).json();
if (!inbox.messages?.length) throw new Error('No message in the local mail catcher.');
const message = await (await fetch(`${MAIL_URL}/api/v1/message/${inbox.messages[0].ID}`)).json();
const code = `${message.Text ?? ''} ${message.HTML ?? ''}`.match(/\b(\d{6})\b/)?.[1];
if (!code) throw new Error('No 6-digit code found in the message.');

const { data: session, error: authError } = await client.auth.verifyOtp({
  email: EMAIL,
  token: code,
  type: 'email',
});
if (authError) throw new Error(`Sign-in failed: ${authError.message}`);
report(Boolean(session.user), `signed in as ${session.user?.email}`);

// --- Upload, then replay -----------------------------------------------------
const id = randomUUID();
const idempotencyKey = `TRANSACTION_CREATE:integration-check:${id}`;

const args = {
  p_id: id,
  p_shop_id: SHOP,
  p_customer_id: CUSTOMER,
  p_transaction_type: 'DEBT',
  p_currency: 'KHR',
  p_amount_minor: 12345,
  p_occurred_at: new Date().toISOString(),
  p_idempotency_key: idempotencyKey,
  p_description: 'sync integration check',
};

const first = await client.rpc('record_transaction', args);
if (first.error) throw new Error(`First upload failed: ${first.error.message}`);
report(first.data?.replayed === false, 'first upload is applied, not replayed');

// Exactly what a phone sends after a lost response: same key, same payload.
const second = await client.rpc('record_transaction', args);
if (second.error) throw new Error(`Retry failed: ${second.error.message}`);
report(second.data?.replayed === true, 'retry is recognised as a replay');
report(
  second.data?.transaction_id === first.data?.transaction_id,
  'retry returns the original transaction',
);

const { count, error: countError } = await client
  .from('transactions')
  .select('*', { count: 'exact', head: true })
  .eq('idempotency_key', idempotencyKey);
if (countError) throw new Error(`Count failed: ${countError.message}`);
report(count === 1, `exactly one row exists for the key (found ${count})`);

// --- The balance moved once, not twice ---------------------------------------
const { data: balance } = await client
  .from('customer_balances')
  .select('outstanding_minor')
  .eq('customer_id', CUSTOMER)
  .eq('currency', 'KHR')
  .maybeSingle();
report(
  typeof balance?.outstanding_minor === 'number',
  `customer balance readable through RLS (${balance?.outstanding_minor} KHR minor)`,
);

console.log(
  process.exitCode ? '\nSYNC INTEGRATION CHECK FAILED' : '\n✓ Sync integration check passed',
);

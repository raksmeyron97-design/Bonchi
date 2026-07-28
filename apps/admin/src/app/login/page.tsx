import React from 'react';
import { redirect } from 'next/navigation';
import { getPlatformAdmin } from '@/lib/auth';
import { requestAdminMagicLink } from './actions';

/**
 * Staff sign-in.
 *
 * Email magic link only — no password to phish or reuse. Being able to sign in
 * does NOT make someone an admin: authorization comes from a row in
 * `platform_admins`, checked server-side on every page.
 */
export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ sent?: string; error?: string }>;
}): Promise<React.ReactElement> {
  const admin = await getPlatformAdmin();
  if (admin) redirect('/');

  const params = await searchParams;

  return (
    <main className="shell">
      <form className="login" action={requestAdminMagicLink}>
        <h1>Bonchi Admin</h1>
        <p className="muted">Staff access. Sign in with your work email.</p>

        <label htmlFor="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-describedby={params.error ? 'login-error' : undefined}
        />

        <button type="submit">Send sign-in link</button>

        {params.sent ? (
          <p className="muted" role="status">
            If that address belongs to a staff account, a sign-in link is on its way.
          </p>
        ) : null}

        {params.error ? (
          <p id="login-error" className="muted" role="alert" style={{ color: 'var(--red-600)' }}>
            That request could not be completed.
          </p>
        ) : null}
      </form>
    </main>
  );
}

'use server';

import { redirect } from 'next/navigation';
import { emailSchema } from '@bonchi/validation';
import { getSessionClient } from '@/lib/supabase/server';

/**
 * Sends a staff sign-in link.
 *
 * Two deliberate choices:
 *
 *  - `shouldCreateUser: false`. This endpoint must not be able to mint accounts;
 *    staff are provisioned by inserting into `platform_admins`.
 *  - The response is identical whether or not the address exists. Otherwise this
 *    form becomes an oracle for enumerating staff emails.
 */
export async function requestAdminMagicLink(formData: FormData): Promise<void> {
  const parsed = emailSchema.safeParse(String(formData.get('email') ?? ''));

  if (!parsed.success) {
    redirect('/login?error=invalid');
  }

  const client = await getSessionClient();
  await client.auth.signInWithOtp({
    email: parsed.data,
    options: { shouldCreateUser: false },
  });

  // Always the same outcome, regardless of whether the account exists.
  redirect('/login?sent=1');
}

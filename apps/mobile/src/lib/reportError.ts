/**
 * Screen-level error reporting.
 *
 * A merchant should never see a stack trace or a Postgres code — they get a short,
 * translated message. But a `catch` that shows that message and discards the error
 * makes the failure invisible to whoever has to fix it, which is how a broken
 * onboarding step can look identical to a working one.
 *
 * This keeps both: the caller renders the translated string, and in development
 * the underlying error is logged with the context that identifies where it came
 * from. In production nothing is logged, because the error may quote customer data.
 */
export function reportScreenError(context: string, error: unknown): void {
  if (!__DEV__) return;

  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'object' && error !== null
        ? JSON.stringify(error)
        : String(error);

  console.error(`[${context}] ${detail}`, error);
}

/**
 * A short, safe description for a dev-only inline hint.
 * Never call this to build text shown in a production build.
 */
export function describeErrorForDev(error: unknown): string | null {
  if (!__DEV__) return null;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'object' && error !== null) return JSON.stringify(error).slice(0, 200);
  return String(error);
}

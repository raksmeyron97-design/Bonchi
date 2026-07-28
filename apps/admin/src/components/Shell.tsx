import React from 'react';
import Link from 'next/link';
import type { PlatformAdmin } from '@/lib/auth';

/**
 * Admin chrome.
 *
 * Navigation is keyboard-reachable with visible focus (see globals.css) and marks
 * the current page with `aria-current`, so the dashboard is usable without a
 * mouse — the accessibility requirement for this surface.
 */
export function Shell({
  admin,
  current,
  children,
}: {
  readonly admin: PlatformAdmin;
  readonly current: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const tabs = [
    { href: '/', label: 'Overview' },
    { href: '/organizations', label: 'Organizations' },
    { href: '/health', label: 'Sync health' },
  ];

  return (
    <main className="shell">
      <header className="top">
        <div>
          <h1>Bonchi Admin</h1>
          <p className="muted">Platform operations</p>
        </div>
        <div className="muted">
          {admin.email} · <strong>{admin.role}</strong>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.href === current ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {children}
    </main>
  );
}

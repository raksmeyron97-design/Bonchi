import type { NextConfig } from 'next';

/**
 * Admin dashboard configuration.
 *
 * `transpilePackages` covers the workspace packages, which ship CommonJS builds.
 * Security headers are set here rather than at the edge so they apply in local
 * development too — a header that only exists in production is a header nobody
 * has tested.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@bonchi/domain', '@bonchi/database', '@bonchi/localization', '@bonchi/validation'],
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self' https://*.supabase.co",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;

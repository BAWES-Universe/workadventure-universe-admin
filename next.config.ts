import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Headers for security
  async headers() {
    return [
      {
        // Allow profile pages to be embedded in iframes (used by WorkAdventure visit cards)
        // This must come BEFORE the general /api/:path* rule to take precedence
        // We set X-Frame-Options to SAMEORIGIN to override the general rule's DENY
        // The route handler sets CSP frame-ancestors for cross-origin support (CSP takes precedence in modern browsers)
        source: '/api/profile/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN', // Override general rule's DENY - CSP will handle cross-origin
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
      {
        // General API routes - profile routes are handled above with more specific rule
        // Note: We need to be careful here - if a route matches both this and the profile rule,
        // Next.js will merge headers. The profile rule should take precedence due to order.
        source: '/api/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
        ],
      },
      {
        // Allow admin pages to be embedded in iframes (needed for WorkAdventure integration)
        // We explicitly don't set X-Frame-Options here (or set it to empty) to allow cross-origin embedding
        // Content-Security-Policy with frame-ancestors provides better security control
        source: '/admin/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' http://play.workadventure.localhost https://play.workadventure.localhost http://play.bawes.localhost https://play.bawes.localhost http://play.bawes.net https://play.bawes.net *;",
          },
          // Explicitly remove X-Frame-Options by not setting it (Next.js won't add default if we define headers)
        ],
      },
      {
        // Also handle root /admin path
        source: '/admin',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: "frame-ancestors 'self' http://play.workadventure.localhost https://play.workadventure.localhost http://play.bawes.localhost https://play.bawes.localhost http://play.bawes.net https://play.bawes.net *;",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

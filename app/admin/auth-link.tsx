'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { ReactNode, MouseEvent } from 'react';

/**
 * Link component that preserves the auth token in URL during navigation
 * Uses router.push instead of Link to ensure token is always included
 * This works reliably for both client-side and server-side navigation
 */
export default function AuthLink({
  href,
  children,
  className,
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  [key: string]: any;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    
    // Get token from URL or localStorage
    // Always check URL first (most up-to-date)
    const sessionToken = searchParams.get('_token');
    const sessionId = searchParams.get('_session');
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('admin_session_token') : null;
    const storedSessionId = typeof window !== 'undefined' ? localStorage.getItem('admin_session_id') : null;
    
    // Prefer token from URL, fallback to localStorage
    const tokenToUse = sessionToken || storedToken;
    const idToUse = sessionId || storedSessionId;
    
    // Build URL with token - ALWAYS include it if available
    const url = new URL(href, window.location.origin);
    
    // Preserve existing query params from href if any
    if (href.includes('?')) {
      const hrefUrl = new URL(href, window.location.origin);
      hrefUrl.searchParams.forEach((value, key) => {
        url.searchParams.set(key, value);
      });
    }
    
    // Always add token if we have one (overwrites any existing _token/_session)
    if (tokenToUse) {
      url.searchParams.set('_token', tokenToUse);
      // Remove _session if we're using _token
      url.searchParams.delete('_session');
    } else if (idToUse) {
      url.searchParams.set('_session', idToUse);
      // Remove _token if we're using _session
      url.searchParams.delete('_token');
    }
    
    // Use window.location.href instead of router.push to ensure token is in URL
    // before middleware runs. This prevents the flash of login page.
    // router.push does client-side navigation but middleware still runs server-side
    // and doesn't see the token until after the redirect.
    window.location.href = url.pathname + url.search;
  };

  return (
    <a href={href} onClick={handleClick} className={className} {...props}>
      {children}
    </a>
  );
}


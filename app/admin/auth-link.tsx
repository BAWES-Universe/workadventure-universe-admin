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
    const sessionToken = searchParams.get('_token');
    const sessionId = searchParams.get('_session');
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('admin_session_token') : null;
    const storedSessionId = typeof window !== 'undefined' ? localStorage.getItem('admin_session_id') : null;
    
    const tokenToUse = sessionToken || storedToken;
    const idToUse = sessionId || storedSessionId;
    
    // Build URL with token
    const url = new URL(href, window.location.origin);
    if (tokenToUse) {
      url.searchParams.set('_token', tokenToUse);
    } else if (idToUse) {
      url.searchParams.set('_session', idToUse);
    }
    
    // Navigate with router.push to ensure token is included
    router.push(url.pathname + url.search);
  };

  return (
    <a href={href} onClick={handleClick} className={className} {...props}>
      {children}
    </a>
  );
}


'use client';

import { useEffect } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';

/**
 * Client component to handle session token from URL and ensure it's preserved
 * This runs on admin pages to:
 * 1. Capture the session token from the redirect URL and store in localStorage
 * 2. Automatically add token to URL if missing (for middleware access on server-side navigation)
 */
export default function TokenHandler() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  useEffect(() => {
    // Check for session token (preferred - contains full session data)
    const sessionToken = searchParams.get('_token');
    const sessionId = searchParams.get('_session');
    
    // Get token from localStorage if not in URL
    const storedToken = typeof window !== 'undefined' ? localStorage.getItem('admin_session_token') : null;
    const storedSessionId = typeof window !== 'undefined' ? localStorage.getItem('admin_session_id') : null;

    // If we have a token in URL, store it in localStorage
    if (sessionToken) {
      try {
        localStorage.setItem('admin_session_token', sessionToken);
        console.log('[TokenHandler] Session token stored from URL to localStorage');
      } catch (error) {
        console.error('[TokenHandler] Failed to store session token from URL:', error);
      }
    } else if (sessionId) {
      try {
        localStorage.setItem('admin_session_id', sessionId);
        console.log('[TokenHandler] Session ID stored from URL to localStorage');
      } catch (error) {
        console.error('[TokenHandler] Failed to store session ID from URL:', error);
      }
    }

    // If we have a stored token but it's not in the URL, add it to preserve session
    // This ensures middleware can always find it on server-side navigation
    // Only do this on admin pages (not login page)
    if (!sessionToken && !sessionId && pathname.startsWith('/admin') && pathname !== '/admin/login') {
      const tokenToUse = storedToken || storedSessionId;
      const paramName = storedToken ? '_token' : '_session';
      
      if (tokenToUse) {
        // Use replaceState to add token to URL without page reload
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set(paramName, tokenToUse);
        
        // Only update if URL actually changed
        if (newUrl.toString() !== window.location.href) {
          window.history.replaceState({}, '', newUrl.toString());
          console.log('[TokenHandler] Added token to URL for middleware access');
        }
      } else {
        // Check if server sent a token in response header
        // This happens when middleware adds token but it's not in URL yet
        // Note: We can't read response headers in client components easily,
        // so we rely on the cookie being set and working, or the URL token
      }
    }
  }, [searchParams, pathname]);

  return null; // This component doesn't render anything
}


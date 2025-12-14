'use client';

import { useEffect, useLayoutEffect } from 'react';
import { useSearchParams, usePathname } from 'next/navigation';

// Helper to check if we're in development mode
const isDev = process.env.NODE_ENV === 'development';

// Helper function for conditional logging (only in dev)
const devLog = (...args: any[]) => {
  if (isDev) {
    console.log(...args);
  }
};

const devError = (...args: any[]) => {
  if (isDev) {
    console.error(...args);
  }
};

const devWarn = (...args: any[]) => {
  if (isDev) {
    console.warn(...args);
  }
};

/**
 * Client component to handle session token from URL and ensure it's preserved
 * This runs on admin pages to:
 * 1. Capture the session token from the redirect URL and store in localStorage
 * 2. Automatically add token to URL if missing (for middleware access on server-side navigation)
 * 
 * Uses useLayoutEffect to run synchronously before paint, ensuring token is in URL before any navigation
 */
export default function TokenHandler() {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Use useLayoutEffect to run synchronously before paint
  // This ensures the token is added to URL before any navigation happens
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    
    // Check for session token (preferred - contains full session data)
    const sessionToken = searchParams.get('_token');
    const sessionId = searchParams.get('_session');
    
    // Get token from localStorage if not in URL
    const storedToken = localStorage.getItem('admin_session_token');
    const storedSessionId = localStorage.getItem('admin_session_id');

    // If we have a token in URL, store it in localStorage
    if (sessionToken) {
      try {
        localStorage.setItem('admin_session_token', sessionToken);
        // Clear redirect flag since we have a token (we're authenticated)
        sessionStorage.removeItem('admin_redirect_in_progress');
        devLog('[TokenHandler] Session token stored from URL to localStorage');
      } catch (error) {
        devError('[TokenHandler] Failed to store session token from URL:', error);
      }
    } else if (sessionId) {
      try {
        localStorage.setItem('admin_session_id', sessionId);
        // Clear redirect flag since we have a token (we're authenticated)
        sessionStorage.removeItem('admin_redirect_in_progress');
        devLog('[TokenHandler] Session ID stored from URL to localStorage');
      } catch (error) {
        devError('[TokenHandler] Failed to store session ID from URL:', error);
      }
    }

    // If we have a stored token but it's not in the URL, add it IMMEDIATELY
    // This ensures middleware can find it on server-side navigation
    // Only do this on admin pages (not login page)
    if (!sessionToken && !sessionId && pathname.startsWith('/admin') && pathname !== '/admin/login') {
      const tokenToUse = storedToken || storedSessionId;
      
      if (tokenToUse) {
        const paramName = storedToken ? '_token' : '_session';
        // Use replaceState to add token to URL immediately (synchronously)
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set(paramName, tokenToUse);
        
        // Only update if URL actually changed
        if (newUrl.toString() !== window.location.href) {
          // Ensure URL is same-origin before using replaceState
          // Using toString() preserves the full URL which Next.js router expects
          if (newUrl.origin === window.location.origin) {
            // Use a flag to prevent this from triggering navigation events in Arc
            // that might cause the login page to re-check
            const updateKey = `token_update_${Date.now()}`;
            sessionStorage.setItem('last_token_update', updateKey);
            
            window.history.replaceState({}, '', newUrl.toString());
            devLog('[TokenHandler] Added token to URL synchronously for middleware access');
          } else {
            devWarn('[TokenHandler] Cannot update URL - cross-origin mismatch:', newUrl.origin, 'vs', window.location.origin);
          }
        }
      } else {
        // No token in localStorage, but middleware let us through
        // This means we're authenticated via cookie (which works in most cases)
        // Don't redirect to login - trust that middleware knows what it's doing
        // Only redirect if we're absolutely sure we're not authenticated
        // Check if we have a cookie by trying to fetch /api/auth/me
        devLog('[TokenHandler] No token in localStorage, but middleware allowed access - checking session');
        
        // Check session asynchronously (don't block)
        fetch('/api/auth/me', {
          credentials: 'include',
          // Use no-cache to allow browser caching but revalidate with server
          // This improves performance when reopening iframes while maintaining security
          cache: 'no-cache',
        })
          .then(response => {
            if (!response.ok) {
              // Not authenticated - redirect to login
              devLog('[TokenHandler] Session check failed, redirecting to login');
              const loginUrl = new URL('/admin/login', window.location.origin);
              loginUrl.searchParams.set('redirect', pathname);
              window.location.href = loginUrl.toString();
            } else {
              // Authenticated via cookie - that's fine, don't redirect
              devLog('[TokenHandler] Session valid via cookie, no redirect needed');
            }
          })
          .catch(error => {
            devError('[TokenHandler] Error checking session:', error);
            // On error, don't redirect - trust middleware
          });
      }
    }
  }, [searchParams, pathname]);

  return null; // This component doesn't render anything
}


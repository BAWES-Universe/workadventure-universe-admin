'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

// Check if manual login form should be enabled (for developers)
// Note: NEXT_PUBLIC_ variables are embedded at build time
// If you change this, you MUST restart the dev server/container
const ENABLE_MANUAL_LOGIN = process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN === 'true';

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

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(true); // Start with loading state
  const [error, setError] = useState<string | null>(null);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const redirectAttemptedRef = useRef(false); // Track if we've already attempted redirect

  // Early check: If we have a token in URL, we're authenticated - redirect immediately
  // This prevents the login page from even rendering in Arc browser
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    // If we're already on an admin page (not login), don't do anything
    // This prevents redirects when navigating between admin pages
    const currentPath = pathname || window.location.pathname;
    if (currentPath !== '/admin/login' && currentPath.startsWith('/admin')) {
      devLog('[Login] Already on admin page, skipping early check');
      setLoading(false);
      return;
    }
    
    const urlToken = searchParams.get('_token') || searchParams.get('_session');
    if (urlToken) {
      // We have a token, which means we're authenticated
      // Check if we're already on the target page to prevent loops
      const redirectTo = searchParams.get('redirect') || '/admin';
      
      // If we're already on the target admin page, don't redirect
      if (currentPath !== '/admin/login' && 
          (currentPath === redirectTo || 
           (redirectTo === '/admin' && currentPath.startsWith('/admin')))) {
        devLog('[Login] Token in URL and already on target page, clearing redirect flag');
        sessionStorage.removeItem('admin_redirect_in_progress');
        setLoading(false);
        return;
      }
      
      // Redirect to admin dashboard immediately without showing login page
      const redirectUrl = new URL(redirectTo, window.location.origin);
      const paramName = searchParams.get('_token') ? '_token' : '_session';
      redirectUrl.searchParams.set(paramName, urlToken);
      
      devLog('[Login] Token found in URL, redirecting immediately to prevent loop');
      window.location.replace(redirectUrl.toString());
      return;
    }
    
    // No token in URL - ensure loading state is handled by checkExistingSession
    // Don't interfere with the normal flow
  }, [searchParams, pathname]);

  // Debug logging on mount
  useEffect(() => {
    devLog('[Login] Component mounted');
    devLog('[Login] ENABLE_MANUAL_LOGIN constant:', ENABLE_MANUAL_LOGIN);
    devLog('[Login] process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN:', process.env.NEXT_PUBLIC_ENABLE_MANUAL_LOGIN);
  }, []);

      // Auto-login function - defined before useEffect
  const handleAutoLogin = async (token: string) => {
    setLoading(true);
    setError(null);

    try {
      // Add timeout to fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ accessToken: token }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        devError('Failed to parse login response:', parseError);
        throw new Error('Invalid response from server');
      }

      if (!response.ok) {
        throw new Error(data.error || `Login failed: ${response.status}`);
      }

      // Store session token in localStorage (works in iframes)
      // Prefer sessionToken (base64 encoded session data) over sessionId (just an ID)
      if (data.sessionToken) {
        try {
          localStorage.setItem('admin_session_token', data.sessionToken);
          if (data.expiresAt) {
            localStorage.setItem('admin_session_expires', data.expiresAt.toString());
          }
          devLog('Session token stored successfully');
        } catch (storageError) {
          devWarn('Failed to store session token in localStorage:', storageError);
          // Continue anyway - cookie might still work
        }
      } else if (data.sessionId) {
        // Fallback to session ID if token not available
        try {
          localStorage.setItem('admin_session_id', data.sessionId);
          devLog('Session ID stored successfully');
        } catch (storageError) {
          devWarn('Failed to store session ID in localStorage:', storageError);
        }
      } else {
        devError('No sessionToken or sessionId in login response:', data);
        throw new Error('Server did not return session data');
      }

      // Redirect to original destination or dashboard
      // Include session token in URL for first load (middleware can't read localStorage)
      // Use sessionToken (encoded session data) which middleware can parse directly
      const redirectTo = searchParams.get('redirect') || '/admin';
      const redirectUrl = new URL(redirectTo, window.location.origin);
      if (data.sessionToken) {
        redirectUrl.searchParams.set('_token', data.sessionToken);
      } else if (data.sessionId) {
        redirectUrl.searchParams.set('_session', data.sessionId);
      }
      
      devLog('[Login] Success! Redirecting to:', redirectUrl.toString());
      
      // Redirect immediately
      window.location.href = redirectUrl.toString();
    } catch (err) {
      devError('Login error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Login failed';
      
      // Handle specific error types
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Request timed out. Please try again.');
      } else {
        setError(errorMessage);
      }
      
      setLoading(false);
    }
  };

  // Check if already authenticated before attempting login
  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;
    let fallbackTimeoutId: NodeJS.Timeout | null = null;
    let isMounted = true; // Track if component is still mounted
    
    // Fallback timeout to ensure loading doesn't stay true forever
    // This prevents the page from being stuck on "Loading universe..." indefinitely
    fallbackTimeoutId = setTimeout(() => {
      if (isMounted) {
        devLog('[Login] Fallback timeout - ensuring loading state is cleared');
        setLoading(false);
        if (ENABLE_MANUAL_LOGIN) {
          setShowManualForm(true);
        }
      }
    }, 10000); // 10 second fallback
    
    const checkExistingSession = async () => {
      // CRITICAL: If we already have a token in the URL, we're authenticated and being redirected
      // Don't run the check again - this prevents loops in Arc browser
      const urlToken = searchParams.get('_token') || searchParams.get('_session');
      if (urlToken) {
        devLog('[Login] Token already in URL, skipping session check to prevent loop');
        // Don't set loading to false here - let the early check handle redirect
        return;
      }
      
      // Check sessionStorage for redirect flag (prevents loops across page reloads)
      // But if we're on the login page and there's a redirect flag, it might be stale
      // Clear it and proceed with normal login flow
      const redirectFlag = sessionStorage.getItem('admin_redirect_in_progress');
      if (redirectFlag) {
        const flagTimestamp = sessionStorage.getItem('admin_redirect_timestamp');
        const now = Date.now();
        // If flag is older than 5 seconds, it's probably stale - clear it
        if (flagTimestamp && (now - parseInt(flagTimestamp)) > 5000) {
          devLog('[Login] Stale redirect flag detected, clearing and proceeding');
          sessionStorage.removeItem('admin_redirect_in_progress');
          sessionStorage.removeItem('admin_redirect_timestamp');
          // Continue with normal flow below
        } else {
          devLog('[Login] Redirect already in progress, skipping check');
          // If redirect is in progress, we should wait - but set a timeout to prevent infinite loading
          timeoutId = setTimeout(() => {
            if (isMounted) {
              devLog('[Login] Redirect timeout - clearing flag and proceeding');
              sessionStorage.removeItem('admin_redirect_in_progress');
              sessionStorage.removeItem('admin_redirect_timestamp');
              setLoading(false);
              if (ENABLE_MANUAL_LOGIN) {
                setShowManualForm(true);
              }
            }
          }, 3000);
          return;
        }
      }
      
      // ALWAYS check for existing session first, even if manual login is enabled
      // This ensures authenticated users are redirected properly
      const tokenFromUrl = searchParams.get('accessToken');
      
      try {
        // Check if we have a valid session by calling /api/auth/me
        // Use plain fetch to avoid redirect loops (authenticatedFetch might redirect)
        // Try both localStorage token and cookies (cookies work even if localStorage doesn't)
        const storedToken = localStorage.getItem('admin_session_token') || localStorage.getItem('admin_session_id');
        const url = new URL('/api/auth/me', window.location.origin);
        if (storedToken) {
          url.searchParams.set('_token', storedToken);
        }
        
        // Add timeout to prevent hanging on slow/intermittent networks (mobile, etc.)
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => {
          controller.abort();
          devLog('[Login] Session check timed out after 5 seconds');
        }, 5000);
        
        // Always include credentials to send cookies (session might be in cookie)
        const response = await fetch(url.toString(), {
          credentials: 'include',
          signal: controller.signal,
          // Use no-cache to allow browser caching but revalidate with server
          // This improves performance when reopening iframes while maintaining security
          cache: 'no-cache',
        });

        clearTimeout(fetchTimeout);

        if (response.ok && isMounted) {
          const data = await response.json();
          if (data.user) {
            // Already authenticated, but check if we're already on an admin page
            // This prevents infinite redirect loops (especially in Arc browser)
            const redirectTo = searchParams.get('redirect') || '/admin';
            const currentPath = pathname || window.location.pathname;
            
            // If we're already on the target admin page (not login), don't redirect
            if (currentPath !== '/admin/login' && 
                (currentPath === redirectTo || 
                 (redirectTo === '/admin' && currentPath.startsWith('/admin')))) {
              devLog('[Login] Already on target admin page, skipping redirect to prevent loop');
              setLoading(false);
              // Clear redirect flag if set
              sessionStorage.removeItem('admin_redirect_in_progress');
              return;
            }
            
            // Prevent multiple redirect attempts using both ref and sessionStorage
            if (redirectAttemptedRef.current || redirectFlag) {
              devLog('[Login] Redirect already attempted, skipping to prevent loop');
              setLoading(false);
              return;
            }
            
            // Set flags to prevent multiple redirects
            redirectAttemptedRef.current = true;
            sessionStorage.setItem('admin_redirect_in_progress', 'true');
            sessionStorage.setItem('admin_redirect_timestamp', Date.now().toString());
            
            devLog('[Login] Already authenticated, redirecting to:', redirectTo);
            
            // Get token from localStorage to preserve in URL
            const storedToken = localStorage.getItem('admin_session_token');
            const storedSessionId = localStorage.getItem('admin_session_id');
            
            const redirectUrl = new URL(redirectTo, window.location.origin);
            if (storedToken) {
              redirectUrl.searchParams.set('_token', storedToken);
            } else if (storedSessionId) {
              redirectUrl.searchParams.set('_session', storedSessionId);
            }
            
            // Use a small delay to prevent rapid redirects in browsers like Arc
            setTimeout(() => {
              if (isMounted) {
                window.location.href = redirectUrl.toString();
              }
            }, 50);
            return;
          }
        } else if (isMounted && response.status !== 401) {
          // Response not OK and not 401 (unauthorized) - might be network error
          devLog('[Login] Session check returned non-OK status:', response.status);
          // Don't set loading to false here - let it fall through to show form or continue waiting
        } else if (isMounted && response.status === 401) {
          // 401 Unauthorized - definitely not authenticated
          devLog('[Login] Session check returned 401 - not authenticated');
          // Continue to normal login flow below
        }
      } catch (error) {
        // Not authenticated or error checking, continue with normal login flow
        devLog('[Login] No existing session found or error:', error);
        
        // If it's an abort error (timeout), ensure loading state is cleared
        if (error instanceof Error && error.name === 'AbortError' && isMounted) {
          devLog('[Login] Session check was aborted (timeout), clearing loading state');
          setLoading(false);
          if (ENABLE_MANUAL_LOGIN) {
            setShowManualForm(true);
          }
        }
      }

      // If not authenticated, check for accessToken in URL
      if (tokenFromUrl && !autoLoginAttempted && isMounted) {
        devLog('Auto-login: Token found in URL, attempting login...');
        setAccessToken(tokenFromUrl);
        setAutoLoginAttempted(true);
        handleAutoLogin(tokenFromUrl).catch((err) => {
          if (isMounted) {
            devError('Auto-login failed:', err);
            setError(err instanceof Error ? err.message : 'Auto-login failed');
            setLoading(false);
            // If manual login is enabled, show the form on error
            if (ENABLE_MANUAL_LOGIN) {
              setShowManualForm(true);
            }
          }
        });
      } else if (isMounted) {
        // No accessToken in URL - show manual form if enabled, otherwise keep loading
        if (ENABLE_MANUAL_LOGIN) {
          devLog('[Login] Manual login enabled, no accessToken - will show form after 2 seconds');
          timeoutId = setTimeout(() => {
            if (isMounted) {
              devLog('[Login] Timeout fired, showing manual form');
              setLoading(false);
              setShowManualForm(true);
            }
          }, 2000);
        } else {
          // Manual login disabled - keep loading (waiting for WorkAdventure token)
          devLog('[Login] Manual login disabled, waiting for WorkAdventure token');
          // Don't set loading to false, keep the loading state
        }
      }
    };

    checkExistingSession();
    
    // Cleanup timeout on unmount
    return () => {
      isMounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (fallbackTimeoutId) {
        clearTimeout(fallbackTimeoutId);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pathname]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Add timeout to fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ accessToken }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let data;
      try {
        data = await response.json();
      } catch (parseError) {
        devError('Failed to parse login response:', parseError);
        throw new Error('Invalid response from server');
      }

      if (!response.ok) {
        throw new Error(data.error || `Login failed: ${response.status}`);
      }

      // Store session token in localStorage (works in iframes)
      // Prefer sessionToken (base64 encoded session data) over sessionId (just an ID)
      if (data.sessionToken) {
        try {
          localStorage.setItem('admin_session_token', data.sessionToken);
          if (data.expiresAt) {
            localStorage.setItem('admin_session_expires', data.expiresAt.toString());
          }
          devLog('Session token stored successfully');
        } catch (storageError) {
          devWarn('Failed to store session token in localStorage:', storageError);
          // Continue anyway - cookie might still work
        }
      } else if (data.sessionId) {
        // Fallback to session ID if token not available
        try {
          localStorage.setItem('admin_session_id', data.sessionId);
          devLog('Session ID stored successfully');
        } catch (storageError) {
          devWarn('Failed to store session ID in localStorage:', storageError);
        }
      } else {
        devError('No sessionToken or sessionId in login response:', data);
        throw new Error('Server did not return session data');
      }

      // Redirect to original destination or dashboard
      // Include session token in URL for first load (middleware can't read localStorage)
      // Use sessionToken (encoded session data) which middleware can parse directly
      const redirectTo = searchParams.get('redirect') || '/admin';
      const redirectUrl = new URL(redirectTo, window.location.origin);
      if (data.sessionToken) {
        redirectUrl.searchParams.set('_token', data.sessionToken);
      } else if (data.sessionId) {
        redirectUrl.searchParams.set('_session', data.sessionId);
      }
      
      devLog('[Login] Success! Redirecting to:', redirectUrl.toString());
      
      // Redirect immediately
      window.location.href = redirectUrl.toString();
    } catch (err) {
      devError('Login error:', err);
      const errorMessage = err instanceof Error ? err.message : 'Login failed';
      
      // Handle specific error types
      if (err instanceof Error && err.name === 'AbortError') {
        setError('Request timed out. Please try again.');
      } else {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
    }
  }

  // Show loading state by default (waiting for WorkAdventure to provide token)
  if (loading && !showManualForm) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Loading universe...</h2>
          <p className="text-sm text-gray-600">
            Waiting for authentication from WorkAdventure
          </p>
        </div>
      </div>
    );
  }

  // Show manual login form only if enabled and requested
  if (!showManualForm && !ENABLE_MANUAL_LOGIN) {
    // Still show loading if manual form is disabled
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Loading universe...</h2>
          <p className="text-sm text-gray-600">
            Waiting for authentication from WorkAdventure
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Sign in to Admin
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Use your OIDC access token to login
          </p>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
          
          <div>
            <label htmlFor="accessToken" className="block text-sm font-medium text-gray-700">
              OIDC Access Token
            </label>
            <div className="mt-1">
              <input
                id="accessToken"
                name="accessToken"
                type="text"
                required
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Enter your OIDC access token"
              />
            </div>
            <p className="mt-2 text-sm text-gray-500">
              Get your access token from WorkAdventure after logging in, or use the OIDC mock test token.
            </p>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>

          <div className="text-sm text-gray-600">
            <p className="font-medium">For Testing:</p>
            <p className="mt-1">
              If using OIDC mock, you can get a token by:
            </p>
            <ol className="list-decimal list-inside mt-2 space-y-1">
              <li>Logging into WorkAdventure at <code className="bg-gray-100 px-1 rounded">http://play.workadventure.localhost</code></li>
              <li>Check browser DevTools → Network → Look for API calls with <code className="bg-gray-100 px-1 rounded">accessToken</code> parameter</li>
              <li>Or use the OIDC mock directly to get a token</li>
            </ol>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Loading...</h2>
        </div>
      </div>
    }>
      <LoginPageContent />
    </Suspense>
  );
}


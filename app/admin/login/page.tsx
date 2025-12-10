'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);

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
        console.error('Failed to parse login response:', parseError);
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
          console.log('Session token stored successfully');
        } catch (storageError) {
          console.warn('Failed to store session token in localStorage:', storageError);
          // Continue anyway - cookie might still work
        }
      } else if (data.sessionId) {
        // Fallback to session ID if token not available
        try {
          localStorage.setItem('admin_session_id', data.sessionId);
          console.log('Session ID stored successfully');
        } catch (storageError) {
          console.warn('Failed to store session ID in localStorage:', storageError);
        }
      } else {
        console.error('No sessionToken or sessionId in login response:', data);
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
      
      console.log('[Login] Success! Redirecting to:', redirectUrl.toString());
      
      // Redirect immediately
      window.location.href = redirectUrl.toString();
    } catch (err) {
      console.error('Login error:', err);
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
    const checkExistingSession = async () => {
      try {
        // Check if we have a valid session by calling /api/auth/me
        const { authenticatedFetch } = await import('@/lib/client-auth');
        const response = await authenticatedFetch('/api/auth/me');

        if (response.ok) {
          // Already authenticated, redirect to dashboard
          const redirectTo = searchParams.get('redirect') || '/admin';
          console.log('[Login] Already authenticated, redirecting to:', redirectTo);
          
          // Get token from localStorage to preserve in URL
          const storedToken = localStorage.getItem('admin_session_token');
          const storedSessionId = localStorage.getItem('admin_session_id');
          
          const redirectUrl = new URL(redirectTo, window.location.origin);
          if (storedToken) {
            redirectUrl.searchParams.set('_token', storedToken);
          } else if (storedSessionId) {
            redirectUrl.searchParams.set('_session', storedSessionId);
          }
          
          window.location.href = redirectUrl.toString();
          return;
        }
      } catch (error) {
        // Not authenticated or error checking, continue with normal login flow
        console.log('[Login] No existing session found');
      }

      // If not authenticated, check for accessToken in URL
      const tokenFromUrl = searchParams.get('accessToken');
      if (tokenFromUrl && !autoLoginAttempted) {
        console.log('Auto-login: Token found in URL, attempting login...');
        setAccessToken(tokenFromUrl);
        setAutoLoginAttempted(true);
        handleAutoLogin(tokenFromUrl).catch((err) => {
          console.error('Auto-login failed:', err);
          setError(err instanceof Error ? err.message : 'Auto-login failed');
          setLoading(false);
        });
      }
    };

    checkExistingSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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
        console.error('Failed to parse login response:', parseError);
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
          console.log('Session token stored successfully');
        } catch (storageError) {
          console.warn('Failed to store session token in localStorage:', storageError);
          // Continue anyway - cookie might still work
        }
      } else if (data.sessionId) {
        // Fallback to session ID if token not available
        try {
          localStorage.setItem('admin_session_id', data.sessionId);
          console.log('Session ID stored successfully');
        } catch (storageError) {
          console.warn('Failed to store session ID in localStorage:', storageError);
        }
      } else {
        console.error('No sessionToken or sessionId in login response:', data);
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
      
      console.log('[Login] Success! Redirecting to:', redirectUrl.toString());
      
      // Redirect immediately
      window.location.href = redirectUrl.toString();
    } catch (err) {
      console.error('Login error:', err);
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


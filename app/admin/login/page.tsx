'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Loader2, AlertCircle } from 'lucide-react';

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
    let isMounted = true; // Track if component is still mounted
    
    const checkExistingSession = async () => {
      // If manual login is enabled and no accessToken, skip session check and show form
      // This prevents infinite redirect loops
      const tokenFromUrl = searchParams.get('accessToken');
      if (ENABLE_MANUAL_LOGIN && !tokenFromUrl) {
        devLog('[Login] Manual login enabled, no accessToken - will show form after 2 seconds');
        // Set timeout to show form immediately (no need to wait for session check)
        timeoutId = setTimeout(() => {
          if (isMounted) {
            devLog('[Login] Timeout fired, showing manual form');
            setLoading(false);
            setShowManualForm(true);
          }
        }, 2000);
        return; // Skip session check to avoid redirect loops
      }

      // Only check existing session if manual login is disabled or we have an accessToken
      try {
        // Check if we have a valid session by calling /api/auth/me
        // Use plain fetch to avoid redirect loops (authenticatedFetch might redirect)
        const storedToken = localStorage.getItem('admin_session_token') || localStorage.getItem('admin_session_id');
        const url = new URL('/api/auth/me', window.location.origin);
        if (storedToken) {
          url.searchParams.set('_token', storedToken);
        }
        
        const response = await fetch(url.toString(), {
          credentials: 'include',
        });

        if (response.ok && isMounted) {
          const data = await response.json();
          if (data.user) {
            // Already authenticated, redirect to dashboard
            const redirectTo = searchParams.get('redirect') || '/admin';
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
            
            window.location.href = redirectUrl.toString();
            return;
          }
        }
      } catch (error) {
        // Not authenticated or error checking, continue with normal login flow
        devLog('[Login] No existing session found or error:', error);
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
      } else if (isMounted && !ENABLE_MANUAL_LOGIN) {
        // Manual login disabled - keep loading (waiting for WorkAdventure token)
        devLog('[Login] Manual login disabled, waiting for WorkAdventure token');
        // Don't set loading to false, keep the loading state
      }
    };

    checkExistingSession();
    
    // Cleanup timeout on unmount
    return () => {
      isMounted = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
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
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Loading Universe Orbit</h2>
        </div>
      </div>
    );
  }

  // Show manual login form only if enabled and requested
  if (!showManualForm && !ENABLE_MANUAL_LOGIN) {
    // Still show loading if manual form is disabled
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Loading Universe Orbit</h2>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-center text-3xl">Sign in to Admin</CardTitle>
          <CardDescription className="text-center">
            Use your OIDC access token to login
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={handleLogin}>
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="accessToken">OIDC Access Token</Label>
              <Input
                id="accessToken"
                name="accessToken"
                type="text"
                required
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder="Enter your OIDC access token"
              />
              <p className="text-sm text-muted-foreground">
                Get your access token from WorkAdventure after logging in, or use the OIDC mock test token.
              </p>
            </div>

            <Button
              type="submit"
              disabled={loading}
              className="w-full"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </Button>

            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground">For Testing:</p>
              <p className="mt-1">
                If using OIDC mock, you can get a token by:
              </p>
              <ol className="list-decimal list-inside mt-2 space-y-1">
                <li>Logging into WorkAdventure at <code className="bg-muted px-1 rounded">http://play.workadventure.localhost</code></li>
                <li>Check browser DevTools → Network → Look for API calls with <code className="bg-muted px-1 rounded">accessToken</code> parameter</li>
                <li>Or use the OIDC mock directly to get a token</li>
              </ol>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="h-12 w-12 animate-spin text-primary mx-auto mb-4" />
          <h2 className="text-xl font-semibold text-foreground mb-2">Loading Universe Orbit</h2>
        </div>
      </div>
    }>
      <LoginPageContent />
    </Suspense>
  );
}


/**
 * Client-side authentication helpers
 * For use in browser/client components
 * 
 * ⚠️ IMPORTANT: Always use `authenticatedFetch` for API calls to `/api/admin/*` or `/api/auth/*`
 * 
 * Plain `fetch` will NOT work in HTTP iframes because cookies don't work reliably.
 * `authenticatedFetch` automatically includes the token in the URL for middleware authentication.
 * 
 * @example
 * ```typescript
 * const { authenticatedFetch } = await import('@/lib/client-auth');
 * const response = await authenticatedFetch('/api/admin/users');
 * ```
 * 
 * See docs/API-AUTHENTICATION.md for more details.
 */

/**
 * Get authentication headers for API requests
 * Includes session ID from localStorage if available
 */
export function getAuthHeaders(): HeadersInit {
  const sessionId = localStorage.getItem('admin_session_id') || localStorage.getItem('admin_session_token'); // Support both
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  
  if (sessionId) {
    headers['Authorization'] = `Bearer ${sessionId}`;
  }
  
  return headers;
}

/**
 * Check if session token is expired (client-side check)
 * Note: Server-side validation is the ultimate source of truth
 * This is for UX only to prevent unnecessary requests
 */
export function isSessionExpired(): boolean {
  const expiresAt = localStorage.getItem('admin_session_expires');
  if (!expiresAt) {
    // If no expiresAt, assume valid (new system handles expiration server-side)
    return false;
  }
  return Date.now() > parseInt(expiresAt);
}

/**
 * @deprecated Use isSessionExpired instead
 */
export function isTokenExpired(): boolean {
  return isSessionExpired();
}

/**
 * Clear session data from localStorage
 */
export function clearClientSession(): void {
  localStorage.removeItem('admin_session_id');
  localStorage.removeItem('admin_session_token');
  localStorage.removeItem('admin_session_expires');
}

/**
 * @deprecated Use clearClientSession instead
 */
export function clearSession(): void {
  clearClientSession();
}

/**
 * Get the URL for an API request with token included
 * This ensures the token is in the URL for server-side middleware
 */
function getApiUrlWithToken(path: string): string {
  if (typeof window === 'undefined') return path;
  
  // Check URL first (most up-to-date)
  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('_token') || urlParams.get('_session');
  
  // Fallback to localStorage
  const storedToken = urlToken || localStorage.getItem('admin_session_token') || localStorage.getItem('admin_session_id');
  
  if (!storedToken) return path;
  
  const url = new URL(path, window.location.origin);
  const paramName = urlToken ? (urlParams.has('_token') ? '_token' : '_session') : 
                     (localStorage.getItem('admin_session_token') ? '_token' : '_session');
  url.searchParams.set(paramName, storedToken);
  return url.pathname + url.search;
}

/**
 * Helper for authenticated fetch calls
 * Automatically includes session token in URL and Authorization header
 */
export async function authenticatedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  // Check if token is expired (client-side check for UX)
  if (isSessionExpired()) {
    clearClientSession();
    // Redirect to login if we're in the browser
    if (typeof window !== 'undefined') {
      window.location.href = '/admin/login';
    }
    throw new Error('Session expired');
  }

  // Include token in URL for server-side middleware
  const urlWithToken = getApiUrlWithToken(url);

  // Get auth headers
  const authHeaders = getAuthHeaders();
  
  // If body is FormData, don't set Content-Type - let browser set it automatically with boundary
  const isFormData = options.body instanceof FormData;
  if (isFormData) {
    // Remove Content-Type from authHeaders when using FormData
    const { 'Content-Type': _, ...headersWithoutContentType } = authHeaders;
    return fetch(urlWithToken, {
      ...options,
      headers: {
        ...headersWithoutContentType,
        ...options.headers,
      },
      credentials: 'include', // Still send cookies as fallback
    });
  }

  return fetch(urlWithToken, {
    ...options,
    headers: {
      ...authHeaders,
      ...options.headers,
    },
    credentials: 'include', // Still send cookies as fallback
  });
}


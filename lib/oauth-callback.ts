/**
 * Shared utility for constructing the OAuth callback URL from ADMIN_API_URL.
 *
 * Every OAuth route needs to derive the callback URL the same way:
 *   ADMIN_API_URL (with trailing slash stripped) + /api/oauth/mcp-callback
 *
 * Centralizing this prevents drift between the three routes that use it.
 */

const CALLBACK_PATH = '/api/oauth/mcp-callback';

/**
 * Returns the OAuth callback URL by reading ADMIN_API_URL, stripping any
 * trailing slash, and appending `/api/oauth/mcp-callback`.
 *
 * Returns `null` when ADMIN_API_URL is not set.  The caller should treat
 * `null` as a hard error — the callback endpoint cannot function without it.
 */
export function getOAuthCallbackUrl(): string | null {
  const raw = process.env.ADMIN_API_URL;
  if (!raw) return null;
  const base = raw.replace(/\/+$/, '');
  return `${base}${CALLBACK_PATH}`;
}

/**
 * Returns the *base* URL (ADMIN_API_URL, trailing slash stripped).
 * Useful when the caller needs the base separately from the full callback path.
 *
 * Returns `null` when ADMIN_API_URL is not set.
 */
export function getOAuthCallbackBase(): string | null {
  const raw = process.env.ADMIN_API_URL;
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Validates that an OAuth callback URL is usable for dynamic client registration.
 * The URL must be external (not internal/localhost) so the OAuth provider's
 * authorization server can reach it.
 *
 * @returns `null` when the URL is valid, or an error message string when invalid.
 */
export function validateOAuthCallbackUrl(url: string): string | null {
  try {
    new URL(url);
  } catch {
    return `Invalid callback URL: "${url}" — must be a valid, absolute URL`;
  }

  // isExternalUrl lives in the route files as a local helper; for the
  // cross-cutting validation we perform a simpler check here.
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Reject obvious internal / private hostnames
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal' ||
      hostname === '169.254.169.254' ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname)
    ) {
      return `ADMIN_API_URL resolves to an internal/host-inaccessible address: "${url}". Use a browser-accessible URL like https://orbit.bawes.net.`;
    }
  } catch {
    return `Invalid callback URL: "${url}"`;
  }

  return null;
}

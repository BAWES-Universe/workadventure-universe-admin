/**
 * OIDC Redirect URI and Mobile Origin Validator for Orbit Authentication
 */

export const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

export function getMobileRedirectUri(): string {
  return process.env.MOBILE_REDIRECT_URI?.trim() || DEFAULT_MOBILE_REDIRECT_URI;
}

/**
 * Returns all recognized redirect URIs for OIDC authentication.
 */
export function getAllowedRedirectUris(): string[] {
  const uris: string[] = [getMobileRedirectUri()];

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL;
  if (apiUrl) {
    const cleanApiUrl = apiUrl.replace(/\/+$/, '');
    uris.push(cleanApiUrl);
    uris.push(`${cleanApiUrl}/admin/login`);
  }

  const playUrl = process.env.NEXT_PUBLIC_PLAY_URL || process.env.PLAY_URL;
  if (playUrl) {
    uris.push(playUrl.replace(/\/+$/, ''));
  }

  return uris;
}

/**
 * Checks if a given redirect URI is acceptable for Orbit OIDC authentication.
 * Accepts the mobile deep-link (e.g. bawes://callback) as well as authorized web URLs.
 */
export function isValidRedirectUri(uri: string): boolean {
  if (!uri || typeof uri !== 'string') return false;
  const trimmed = uri.trim();

  const mobileUri = getMobileRedirectUri();
  if (trimmed === mobileUri || trimmed.startsWith(`${mobileUri}?`) || trimmed.startsWith(`${mobileUri}#`)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    // Deep link scheme match
    if (parsed.protocol === 'bawes:' && parsed.hostname === 'callback') {
      return true;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }

    if (!parsed.origin || parsed.origin === 'null') {
      return false;
    }

    const allowed = getAllowedRedirectUris();
    return allowed.some((allowedUri) => {
      try {
        const allowedParsed = new URL(allowedUri);
        if (allowedParsed.protocol !== 'http:' && allowedParsed.protocol !== 'https:') {
          return false;
        }
        return allowedParsed.origin !== 'null' && parsed.origin === allowedParsed.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Validates whether an incoming HTTP Origin header is permissible for login.
 * Permits the expected server origin as well as Capacitor/mobile WebView origins.
 */
export function isAllowedLoginOrigin(origin: string, expectedOrigin: string): boolean {
  if (!origin) return false;

  // Direct match with expected web origin
  try {
    if (new URL(origin).origin === expectedOrigin) return true;
  } catch {
    // If not a standard URL, evaluate mobile custom schemes below
  }

  // Capacitor iOS webview origin
  if (origin === 'capacitor://localhost') return true;

  // Capacitor Android webview origins
  if (origin === 'https://localhost' || origin === 'http://localhost') return true;

  // Opaque origin produced by custom schemes (WHATWG serializes non-standard schemes to 'null')
  if (origin === 'null') return true;

  // Direct scheme match
  if (origin === 'bawes://' || origin.startsWith('bawes://')) return true;

  return false;
}

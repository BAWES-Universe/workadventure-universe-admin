export const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

/**
 * Returns the configured mobile OIDC deep-link redirect URI,
 * defaulting to `bawes://callback`.
 */
export function getMobileRedirectUri(): string {
  const configured = process.env.MOBILE_REDIRECT_URI?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'bawes:') {
        return configured;
      }
    } catch {
      // Fall back to default if malformed
    }
  }
  return DEFAULT_MOBILE_REDIRECT_URI;
}

/**
 * Checks whether an HTTP `Origin` header belongs to the native mobile custom scheme
 * (`bawes://` or `bawes://callback`).
 *
 * Note: For custom schemes like `bawes://callback`, `new URL(origin).origin` returns
 * the string `"null"` in the WHATWG URL standard, so standard `URL.origin` equality
 * checks would otherwise reject mobile requests.
 */
export function isMobileOrigin(origin: string | null | undefined): boolean {
  if (!origin || typeof origin !== 'string') {
    return false;
  }
  const trimmed = origin.trim();
  if (trimmed === 'bawes://') {
    return true;
  }
  try {
    const parsed = new URL(trimmed);
    const mobileUri = new URL(getMobileRedirectUri());
    return parsed.protocol === mobileUri.protocol && (
      parsed.host === '' ||
      parsed.host === mobileUri.host ||
      trimmed.startsWith(`${mobileUri.protocol}//${mobileUri.host}`)
    );
  } catch {
    return false;
  }
}

/**
 * Detects whether a request `User-Agent` originates from an Android WebView,
 * iOS WKWebView, or Capacitor native shell.
 */
export function isMobileWebViewUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent || typeof userAgent !== 'string') {
    return false;
  }
  if (/\bCapacitor\b/i.test(userAgent)) {
    return true;
  }
  // Android WebView includes "; wv)" or "Version/X.Y Chrome/... Mobile"
  if (/;\s*wv\)/i.test(userAgent) || (/Android/i.test(userAgent) && /Version\/[\d.]+\s+Chrome\/[\d.]+\s+Mobile/i.test(userAgent))) {
    return true;
  }
  // iOS WKWebView has iPhone/iPad/iPod + AppleWebKit without "Safari/"
  if (/(iPhone|iPad|iPod)/i.test(userAgent) && /AppleWebKit/i.test(userAgent) && !/Safari\//i.test(userAgent)) {
    return true;
  }
  return false;
}

/**
 * Collects the allowed web origins for OIDC redirect URIs.
 */
export function getAllowedWebOrigins(fallbackOrigin?: string): string[] {
  const candidates = [
    process.env.ADMIN_API_URL,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_PLAY_URL,
    process.env.PLAY_URL,
    fallbackOrigin,
  ];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    try {
      const parsed = new URL(candidate.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore invalid URLs
    }
  }
  return Array.from(origins);
}

/**
 * Validates whether a candidate OIDC `redirect_uri` is permitted.
 * Accepts:
 * 1. The mobile deep-link redirect URI (`bawes://callback` or `MOBILE_REDIRECT_URI`).
 * 2. Web redirect URIs (`http:` / `https:`) under configured Orbit / Universe origins.
 */
export function isValidRedirectUri(
  redirectUri: string | null | undefined,
  fallbackOrigin?: string,
): boolean {
  if (!redirectUri || typeof redirectUri !== 'string') {
    return false;
  }
  const trimmed = redirectUri.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    const mobileRedirectUri = getMobileRedirectUri();
    const mobileParsed = new URL(mobileRedirectUri);

    // Check mobile custom scheme (`bawes://callback`)
    if (parsed.protocol === mobileParsed.protocol) {
      const normalizedCandidate = `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');
      const normalizedMobile = `${mobileParsed.protocol}//${mobileParsed.host}${mobileParsed.pathname}`.replace(/\/+$/, '');
      return normalizedCandidate === normalizedMobile;
    }

    // Check web http(s) redirect URIs
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      const allowedOrigins = getAllowedWebOrigins(fallbackOrigin);
      return allowedOrigins.includes(parsed.origin);
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Resolves and validates the OIDC redirect URI for a login/callback request.
 * - If `requestedRedirectUri` is explicitly supplied, validates it against allowed web + mobile URIs.
 * - Otherwise, automatically selects `bawes://callback` for mobile WebView user agents,
 *   or the default web origin callback for desktop/mobile browsers.
 */
export function resolveRedirectUri(options: {
  requestedRedirectUri?: string | null;
  userAgent?: string | null;
  fallbackOrigin?: string;
}): { valid: boolean; redirectUri: string; isMobile: boolean } {
  const { requestedRedirectUri, userAgent, fallbackOrigin } = options;

  if (requestedRedirectUri != null && requestedRedirectUri.trim() !== '') {
    const trimmed = requestedRedirectUri.trim();
    const valid = isValidRedirectUri(trimmed, fallbackOrigin);
    let isMobile = false;
    try {
      isMobile = new URL(trimmed).protocol === 'bawes:';
    } catch {
      isMobile = false;
    }
    return { valid, redirectUri: trimmed, isMobile };
  }

  if (isMobileWebViewUserAgent(userAgent)) {
    return {
      valid: true,
      redirectUri: getMobileRedirectUri(),
      isMobile: true,
    };
  }

  const allowedOrigins = getAllowedWebOrigins(fallbackOrigin);
  const webOrigin = allowedOrigins[0] || 'http://localhost:3333';
  return {
    valid: true,
    redirectUri: `${webOrigin}/admin`,
    isMobile: false,
  };
}

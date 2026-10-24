export const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

const MOBILE_CONTAINER_ORIGINS = new Set([
  'bawes://',
  'capacitor://localhost',
  'ionic://localhost',
]);

const FORBIDDEN_MOBILE_SCHEMES = new Set([
  'http:',
  'https:',
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'mailto:',
  'tel:',
  'ws:',
  'wss:',
]);

function hasUnsafeUriCharacters(value: string): boolean {
  return /[\s\\<>]/.test(value);
}

function hasPathTraversalSegment(rawUri: string, parsedPathname: string): boolean {
  const beforeQueryOrHash = rawUri.split(/[?#]/)[0] || '';
  const pathAfterScheme = beforeQueryOrHash.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]*/, '');
  const segments = [
    ...pathAfterScheme.split('/'),
    ...parsedPathname.split('/'),
  ];
  return segments.includes('..');
}

function parseValidatedMobileUri(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || hasUnsafeUriCharacters(trimmed)) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    const protocol = parsed.protocol.toLowerCase();
    if (!/^[a-z][a-z0-9+.-]*:$/.test(protocol) || FORBIDDEN_MOBILE_SCHEMES.has(protocol)) {
      return null;
    }
    if (parsed.username || parsed.password || parsed.port) return null;
    if (!parsed.hostname && (!parsed.pathname || parsed.pathname === '/')) return null;
    if (hasPathTraversalSegment(trimmed, parsed.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getMobileRedirectUri(): string {
  const configured = process.env.MOBILE_REDIRECT_URI?.trim();
  if (configured && parseValidatedMobileUri(configured)) {
    return configured;
  }
  return DEFAULT_MOBILE_REDIRECT_URI;
}

export function isMobileRedirectUri(uri: string | null | undefined): boolean {
  if (typeof uri !== 'string') return false;
  const parsed = parseValidatedMobileUri(uri);
  if (!parsed) return false;

  const expected = parseValidatedMobileUri(getMobileRedirectUri());
  if (!expected) return false;

  return (
    parsed.protocol.toLowerCase() === expected.protocol.toLowerCase() &&
    parsed.hostname.toLowerCase() === expected.hostname.toLowerCase() &&
    parsed.pathname === expected.pathname
  );
}

export function getAllowedWebOrigins(fallbackOrigin?: string): string[] {
  const candidates = [
    process.env.NEXT_PUBLIC_API_URL,
    process.env.ADMIN_API_URL,
    process.env.NEXT_PUBLIC_PLAY_URL,
    process.env.PLAY_URL,
    fallbackOrigin,
  ];
  const origins = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        !parsed.username &&
        !parsed.password
      ) {
        origins.add(parsed.origin);
      }
    } catch {
      // Ignore malformed env entries
    }
  }
  return Array.from(origins);
}

export function isValidRedirectUri(
  uri: string | null | undefined,
  fallbackOrigin?: string
): boolean {
  if (typeof uri !== 'string') return false;
  const trimmed = uri.trim();
  if (!trimmed || hasUnsafeUriCharacters(trimmed)) return false;

  if (isMobileRedirectUri(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    if (hasPathTraversalSegment(trimmed, parsed.pathname)) return false;

    const allowedOrigins = getAllowedWebOrigins(fallbackOrigin);
    return allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function isMobileWebViewUserAgent(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return false;
  if (/\b(?:Capacitor|bawes-mobile)\b/i.test(userAgent)) return true;
  if (/Android/i.test(userAgent) && (/\bwv\b/i.test(userAgent) || /;\s*wv\)/i.test(userAgent))) {
    return true;
  }
  if (
    /\b(?:iPhone|iPad|iPod)\b/i.test(userAgent) &&
    /AppleWebKit/i.test(userAgent) &&
    /Mobile\//i.test(userAgent) &&
    !/Safari\//i.test(userAgent)
  ) {
    return true;
  }
  return false;
}

export function resolveOidcRedirectUri(options?: {
  requestedRedirectUri?: string | null;
  userAgent?: string | null;
  fallbackOrigin?: string;
}): string | null {
  const requested = options?.requestedRedirectUri?.trim();
  if (requested) {
    return isValidRedirectUri(requested, options?.fallbackOrigin) ? requested : null;
  }

  if (isMobileWebViewUserAgent(options?.userAgent)) {
    return getMobileRedirectUri();
  }

  const baseCandidate =
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    process.env.ADMIN_API_URL?.trim() ||
    options?.fallbackOrigin?.trim();
  if (!baseCandidate) return null;

  try {
    const parsed = new URL(baseCandidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}/admin/login`;
  } catch {
    return null;
  }
}

function isValidConfiguredMobileOrigin(entry: string): boolean {
  if (!entry || entry.toLowerCase() === 'null' || entry === '*' || hasUnsafeUriCharacters(entry)) {
    return false;
  }
  if (MOBILE_CONTAINER_ORIGINS.has(entry) || parseValidatedMobileUri(entry)) {
    return true;
  }
  try {
    const parsed = new URL(entry);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      return false;
    }
    return parsed.origin === entry;
  } catch {
    return false;
  }
}

function getConfiguredMobileAllowedOrigins(): Set<string> {
  const raw = process.env.MOBILE_ALLOWED_ORIGINS?.trim();
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(isValidConfiguredMobileOrigin)
  );
}

export function isMobileOrigin(
  origin: string | null | undefined,
  userAgent?: string | null
): boolean {
  if (typeof origin !== 'string') return false;
  const trimmed = origin.trim();
  if (!trimmed) return false;
  if (MOBILE_CONTAINER_ORIGINS.has(trimmed)) return true;

  const expectedMobile = parseValidatedMobileUri(getMobileRedirectUri());
  if (expectedMobile && trimmed.toLowerCase() === `${expectedMobile.protocol.toLowerCase()}//`) {
    return true;
  }
  if (isMobileRedirectUri(trimmed)) return true;

  // Capacitor on Android uses https://localhost as its WebView container origin.
  // Permit https://localhost only when accompanied by a mobile WebView/Capacitor
  // User-Agent or when explicitly listed in MOBILE_ALLOWED_ORIGINS.
  const configuredOrigins = getConfiguredMobileAllowedOrigins();
  if (configuredOrigins.has(trimmed)) {
    return true;
  }
  if (trimmed === 'https://localhost' && isMobileWebViewUserAgent(userAgent)) {
    return true;
  }

  return false;
}

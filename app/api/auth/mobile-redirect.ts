/**
 * Mobile OIDC deep-link redirect URI validation and Capacitor WebView origin policy.
 *
 * When users sign in from the native BAWES Universe Android/iOS application
 * (`net.bawes.universe`), the OIDC authorization callback returns via the
 * `bawes://callback` custom URL scheme so the mobile OS routes the response
 * back into the native Capacitor container instead of opening an external tab.
 */

export const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

/**
 * Origins emitted by native Capacitor WebView containers and custom-scheme
 * callbacks across iOS WKWebView (`capacitor://localhost`, `ionic://localhost`)
 * and Android WebView (`http://localhost`, `https://localhost`, `bawes://`).
 */
export const ALLOWED_MOBILE_ORIGINS: readonly string[] = [
  'bawes://callback',
  'bawes://',
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost',
];

const ALLOWED_WEB_CALLBACK_PATHS = new Set<string>([
  '/',
  '/admin',
  '/admin/login',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/oauth/mcp-callback',
]);

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const WEBVIEW_UA_PATTERN = /Capacitor|BAWESUniverse|;\s*wv\)|Version\/\d+\.\d+\s+Chrome\/|(iPhone|iPad|iPod).*AppleWebKit(?!.*Safari\/)/i;

export interface RedirectCallbackInput {
  redirectUri: string;
  params: Record<string, string | undefined>;
}

/**
 * Resolves the configured mobile deep-link redirect URI from environment state,
 * falling back to `bawes://callback` when `MOBILE_REDIRECT_URI` is unset.
 */
export function getMobileRedirectUri(): string {
  const candidate = (process.env.MOBILE_REDIRECT_URI ?? '').trim();
  return candidate || DEFAULT_MOBILE_REDIRECT_URI;
}

function parseSafeUrl(rawUrl: string | undefined): URL | null {
  const trimmed = rawUrl?.trim() ?? '';
  if (!trimmed || CONTROL_CHAR_PATTERN.test(trimmed)) {
    return null;
  }
  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function isHttpProtocol(parsed: URL): boolean {
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Collects the trusted HTTP(S) web origins configured for Orbit and Universe
 * so web OIDC callbacks remain accepted alongside `bawes://callback`.
 */
export function getAllowedWebOrigins(fallbackOrigin?: URL | null): string[] {
  const rawList = [
    process.env.NEXT_PUBLIC_API_URL,
    process.env.ADMIN_API_URL,
    process.env.NEXT_PUBLIC_PLAY_URL,
    process.env.PLAY_URL,
    process.env.NODE_ENV === 'production' ? undefined : fallbackOrigin?.origin,
  ];
  const origins = new Set<string>();
  for (const item of rawList) {
    const parsed = parseSafeUrl(item);
    if (parsed && isHttpProtocol(parsed)) {
      origins.add(parsed.origin);
    }
  }
  return Array.from(origins);
}

/**
 * Builds the complete allowlist of OIDC redirect URIs accepted by Orbit auth,
 * combining the native `bawes://callback` deep-link with configured web URIs.
 */
export function getAllowedRedirectUris(fallbackOrigin?: URL | null): string[] {
  const uris = new Set<string>([DEFAULT_MOBILE_REDIRECT_URI, getMobileRedirectUri()]);
  for (const origin of getAllowedWebOrigins(fallbackOrigin)) {
    uris.add(origin);
    uris.add(`${origin}/admin`);
    uris.add(`${origin}/admin/login`);
    uris.add(`${origin}/api/auth/login`);
    uris.add(`${origin}/api/oauth/mcp-callback`);
  }
  return Array.from(uris);
}

function canonicalDeepLinkBase(parsed: URL): string {
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${cleanPath}`;
}

function matchesMobileScheme(parsed: URL): boolean {
  if (isHttpProtocol(parsed)) {
    return false;
  }
  const candidateBase = canonicalDeepLinkBase(parsed);
  const configuredParsed = parseSafeUrl(getMobileRedirectUri());
  const defaultBase = 'bawes://callback';
  const configuredBase = configuredParsed ? canonicalDeepLinkBase(configuredParsed) : defaultBase;
  return candidateBase === defaultBase || candidateBase === configuredBase;
}

/**
 * Determines whether a redirect URI targets the registered mobile deep-link
 * custom URL scheme (`bawes://callback` or `MOBILE_REDIRECT_URI`).
 */
export function isMobileDeepLinkUri(candidateUri: string): boolean {
  const parsed = parseSafeUrl(candidateUri);
  return parsed ? matchesMobileScheme(parsed) : false;
}

/**
 * Validates that a candidate OIDC `redirect_uri` matches either the registered
 * mobile deep-link (`bawes://callback`) or an allowlisted Orbit/Universe web URI.
 */
export function isValidRedirectUri(candidateUri: string, fallbackOrigin?: URL | null): boolean {
  const parsed = parseSafeUrl(candidateUri);
  if (!parsed) {
    return false;
  }
  if (matchesMobileScheme(parsed)) {
    return true;
  }
  if (!isHttpProtocol(parsed)) {
    return false;
  }
  const cleanPath = parsed.pathname.replace(/\/+$/, '') || '/';
  return getAllowedWebOrigins(fallbackOrigin).includes(parsed.origin) && ALLOWED_WEB_CALLBACK_PATHS.has(cleanPath);
}

/**
 * Checks whether an HTTP `Origin` header originates from the native `bawes://`
 * custom URL scheme or a Capacitor mobile WebView host.
 */
export function isAllowedMobileOrigin(originHeader: string | null | undefined): boolean {
  const raw = originHeader?.trim().toLowerCase() ?? '';
  if (!raw || CONTROL_CHAR_PATTERN.test(raw)) {
    return false;
  }
  const normalized = raw.replace(/\/+$/, '');
  return ALLOWED_MOBILE_ORIGINS.includes(normalized) || isMobileDeepLinkUri(raw);
}

/**
 * Detects whether a request `User-Agent` belongs to a Capacitor or native
 * Android/iOS WebView container.
 */
export function isCapacitorWebViewUserAgent(userAgent: string | null | undefined): boolean {
  return WEBVIEW_UA_PATTERN.test(userAgent ?? '');
}

/**
 * Appends OIDC callback or session parameters onto a validated redirect URI
 * without losing existing query parameters or custom-scheme structure.
 */
export function buildMobileCallbackRedirectUrl(input: RedirectCallbackInput): string {
  const parsed = parseSafeUrl(input.redirectUri);
  if (!parsed || !isValidRedirectUri(input.redirectUri)) {
    throw new Error(`Disallowed OIDC redirect_uri: ${input.redirectUri}`);
  }
  for (const [key, value] of Object.entries(input.params)) {
    if (value) {
      parsed.searchParams.set(key, value);
    }
  }
  return parsed.toString();
}

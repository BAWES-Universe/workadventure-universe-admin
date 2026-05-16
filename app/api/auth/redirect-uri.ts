const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

type RedirectUriValidation =
  | { valid: true; redirectUri: string | null }
  | { valid: false; error: string; allowedRedirectUris: string[] };

export function getMobileRedirectUri(): string {
  return process.env.MOBILE_REDIRECT_URI?.trim() || DEFAULT_MOBILE_REDIRECT_URI;
}

function getAllowedWebRedirectOrigins(): string[] {
  return [
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.BASE_URL,
  ].flatMap((value) => {
    if (!value) {
      return [];
    }

    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? [url.origin] : [];
    } catch {
      return [];
    }
  });
}

export function getAllowedRedirectUris(): string[] {
  return [
    getMobileRedirectUri(),
    ...getAllowedWebRedirectOrigins().map((origin) => `${origin}/*`),
  ];
}

function isAllowedWebRedirectUri(redirectUri: string): boolean {
  try {
    const url = new URL(redirectUri);

    return (
      ['http:', 'https:'].includes(url.protocol) &&
      getAllowedWebRedirectOrigins().includes(url.origin)
    );
  } catch {
    return false;
  }
}

export function validateOptionalRedirectUri(value: unknown): RedirectUriValidation {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: true, redirectUri: null };
  }

  const redirectUri = value.trim();
  const allowedRedirectUris = getAllowedRedirectUris();

  if (redirectUri === getMobileRedirectUri() || isAllowedWebRedirectUri(redirectUri)) {
    return { valid: true, redirectUri };
  }

  return {
    valid: false,
    error: 'Unsupported redirect URI',
    allowedRedirectUris,
  };
}

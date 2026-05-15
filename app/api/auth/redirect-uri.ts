const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

type RedirectUriValidation =
  | { valid: true; redirectUri: string | null }
  | { valid: false; error: string; allowedRedirectUris: string[] };

export function getMobileRedirectUri(): string {
  return process.env.MOBILE_REDIRECT_URI?.trim() || DEFAULT_MOBILE_REDIRECT_URI;
}

export function getAllowedMobileRedirectUris(): string[] {
  return [getMobileRedirectUri()];
}

export function validateOptionalRedirectUri(value: unknown): RedirectUriValidation {
  if (typeof value !== 'string' || value.trim() === '') {
    return { valid: true, redirectUri: null };
  }

  const redirectUri = value.trim();
  const allowedRedirectUris = getAllowedMobileRedirectUris();

  if (allowedRedirectUris.includes(redirectUri)) {
    return { valid: true, redirectUri };
  }

  return {
    valid: false,
    error: 'Unsupported redirect URI',
    allowedRedirectUris,
  };
}

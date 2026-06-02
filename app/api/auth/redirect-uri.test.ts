import { NextRequest } from 'next/server';
import {
  DEFAULT_MOBILE_REDIRECT_URI,
  isAllowedAuthRedirectUri,
  isMobileAuthRedirectUri,
} from './redirect-uri';

describe('auth redirect URI allowlist', () => {
  const originalMobileRedirectUri = process.env.MOBILE_REDIRECT_URI;
  const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    process.env.MOBILE_REDIRECT_URI = DEFAULT_MOBILE_REDIRECT_URI;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    process.env.MOBILE_REDIRECT_URI = originalMobileRedirectUri;
    process.env.NEXT_PUBLIC_API_URL = originalPublicApiUrl;
  });

  it('accepts the configured mobile deep-link callback', () => {
    expect(isMobileAuthRedirectUri('bawes://callback')).toBe(true);
    expect(isMobileAuthRedirectUri('bawes://callback?code=abc&state=xyz')).toBe(true);
  });

  it('accepts the same-origin web login callback', () => {
    const request = new NextRequest('https://admin.bawes.net/api/auth/session');

    expect(isAllowedAuthRedirectUri('https://admin.bawes.net/admin/login', request)).toBe(true);
    expect(
      isAllowedAuthRedirectUri('https://admin.bawes.net/admin/login?accessToken=token', request)
    ).toBe(true);
  });

  it('rejects unregistered custom schemes and foreign web origins', () => {
    const request = new NextRequest('https://admin.bawes.net/api/auth/session');

    expect(isAllowedAuthRedirectUri('bawes://evil', request)).toBe(false);
    expect(isAllowedAuthRedirectUri('https://evil.example/admin/login', request)).toBe(false);
  });
});

import type { NextRequest } from 'next/server';

export const DEFAULT_MOBILE_REDIRECT_URI = 'bawes://callback';

function parseRedirectUri(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function redirectUriKey(url: URL): string {
  const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host}${pathname}`;
}

function sameRedirectTarget(left: string, right: string): boolean {
  const leftUrl = parseRedirectUri(left);
  const rightUrl = parseRedirectUri(right);

  if (!leftUrl || !rightUrl) {
    return false;
  }

  return redirectUriKey(leftUrl) === redirectUriKey(rightUrl);
}

function getRequestOrigin(request?: NextRequest): string | null {
  if (!request) {
    return null;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function getMobileRedirectUri(): string {
  return process.env.MOBILE_REDIRECT_URI?.trim() || DEFAULT_MOBILE_REDIRECT_URI;
}

export function getWebAuthRedirectUri(request?: NextRequest): string | null {
  const configuredBase =
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    getRequestOrigin(request);

  if (!configuredBase) {
    return null;
  }

  try {
    const baseUrl = new URL(configuredBase);
    return `${baseUrl.origin}/admin/login`;
  } catch {
    return null;
  }
}

export function isMobileAuthRedirectUri(redirectUri: string | null | undefined): boolean {
  if (!redirectUri) {
    return false;
  }

  return sameRedirectTarget(redirectUri, getMobileRedirectUri());
}

export function isWebAuthRedirectUri(
  redirectUri: string | null | undefined,
  request?: NextRequest
): boolean {
  if (!redirectUri) {
    return false;
  }

  const webRedirectUri = getWebAuthRedirectUri(request);
  return webRedirectUri ? sameRedirectTarget(redirectUri, webRedirectUri) : false;
}

export function isAllowedAuthRedirectUri(
  redirectUri: string | null | undefined,
  request?: NextRequest
): boolean {
  return isMobileAuthRedirectUri(redirectUri) || isWebAuthRedirectUri(redirectUri, request);
}

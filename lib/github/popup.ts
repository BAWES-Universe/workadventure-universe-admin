import { NextResponse } from 'next/server';

/**
 * Sends the sign-in window to the small page that tells the page that opened it how it went, then closes (the same page every
 * sign-in ends on: /oauth-popup-callback.html on the game or on Orbit). Only ever an address of ours (checked when it was stored).
 */
export function popupRedirect(openerUrl: string | null, params: Record<string, string>): NextResponse {
  const fallback = process.env.CORS_ALLOWED_ORIGINS?.split(',')[0] || process.env.ADMIN_API_URL || 'https://orbit.bawes.net';
  let origin: string;
  try {
    origin = new URL(openerUrl || fallback).origin;
  } catch {
    origin = new URL(fallback).origin;
  }
  return NextResponse.redirect(new URL(`/oauth-popup-callback.html?${new URLSearchParams(params).toString()}`, origin));
}

import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest } from 'next/server';

/** Same text, compared in constant time: both are hashed first, so their lengths never show in how long it takes. */
function sameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * Validate service token from Authorization header
 * Simple env var comparison (not JWT)
 * 
 * @param request - Next.js request object
 * @returns true if token is valid, false otherwise
 */
export function validateServiceToken(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.BOT_SERVICE_TOKEN;

  if (!expectedToken) {
    return false; // Token not configured
  }

  return sameSecret(token, expectedToken);
}

/**
 * Require service token - throws error if not valid
 * 
 * @param request - Next.js request object
 * @throws Error if token is invalid
 */
export function requireServiceToken(request: NextRequest): void {
  if (!validateServiceToken(request)) {
    throw new Error('Unauthorized: Invalid service token');
  }
}


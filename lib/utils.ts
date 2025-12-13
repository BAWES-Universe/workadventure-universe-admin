import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { NextRequest } from "next/server"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Parse a playUri to extract universe, world, room, and domain
 * Format: http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug
 */
export function parsePlayUri(playUri: string): { universe: string; world: string; room: string; domain: string } {
  const url = new URL(playUri);
  const pathParts = url.pathname.split('/').filter(Boolean);
  
  // Format: /@/universeSlug/worldSlug/roomSlug
  if (pathParts.length >= 4 && pathParts[0] === '@') {
    return {
      universe: pathParts[1],
      world: pathParts[2],
      room: pathParts[3],
      domain: url.hostname,
    };
  }
  
  throw new Error('Invalid playUri format: expected /@/universe/world/room');
}

/**
 * Build a playUri from base URL, universe, world, and room
 */
export function buildPlayUri(baseUrl: string, universe: string, world: string, room: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/@/${universe}/${world}/${room}`;
  return url.toString();
}

/**
 * Get client IP address from request
 */
export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

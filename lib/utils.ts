/**
 * Parses a WorkAdventure Play URI into its components
 * Format: http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug
 */
export function parsePlayUri(playUri: string): {
  universe: string;
  world: string;
  room: string;
} {
  try {
    const url = new URL(playUri);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    // Format: /@/universeSlug/worldSlug/roomSlug
    if (pathParts.length >= 4 && pathParts[0] === '@') {
      return {
        universe: pathParts[1],
        world: pathParts[2],
        room: pathParts[3],
      };
    }
    
    throw new Error('Invalid playUri format: expected /@/universe/world/room');
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid URL format: ${playUri}`);
    }
    throw error;
  }
}

/**
 * Builds a Play URI from components
 */
export function buildPlayUri(
  baseUrl: string,
  universe: string,
  world: string,
  room: string
): string {
  return `${baseUrl}/@/${universe}/${world}/${room}`;
}


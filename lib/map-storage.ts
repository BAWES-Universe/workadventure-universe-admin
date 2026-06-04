/**
 * Map Storage Integration
 * 
 * Functions for interacting with map-storage service to manage WAM files.
 * WAM files are created via PUT method and reference external TMJ URLs.
 */

/**
 * WAM File Format
 */
export interface WAMFileFormat {
  version: string;
  mapUrl: string; // External TMJ URL (absolute)
  entities: Record<string, unknown>;
  areas: unknown[];
  entityCollections: Array<{
    url: string;
    type: string;
  }>;
  metadata?: Record<string, unknown>;
}

/**
 * Maps Cache File Format (response from GET /maps)
 */
interface MapsCacheFileFormat {
  version: string;
  maps: Record<string, {
    mapUrl?: string;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Constructs the WAM file URL in map-storage
 * Format: {publicMapStorageUrl}/{domain}/{universe}/{world}/{room}/map.wam
 */
export function getWamUrl(
  domain: string,
  universe: string,
  world: string,
  room: string,
  publicMapStorageUrl: string
): string {
  const wamPath = `${domain}/${universe}/${world}/${room}/map.wam`;
  // Remove trailing slash from publicMapStorageUrl if present
  const baseUrl = publicMapStorageUrl.replace(/\/$/, '');
  return `${baseUrl}/${wamPath}`;
}

/**
 * Constructs the WAM file path (without base URL)
 * Format: {domain}/{universe}/{world}/{room}/map.wam
 */
export function getWamPath(
  domain: string,
  universe: string,
  world: string,
  room: string
): string {
  return `${domain}/${universe}/${world}/${room}/map.wam`;
}

/**
 * Checks if a WAM file exists in map-storage
 * Uses GET /maps endpoint to query the maps cache
 *
 * NOTE: The cache can be stale or regenerating after a deploy
 * (WAMVersionHash changes when types.ts changes). A cache miss
 * should not be treated as definitive — use safeWamExists() instead
 * which adds a direct HEAD check as secondary guard.
 */
export async function checkWamExists(
  publicMapStorageUrl: string,
  wamPath: string,
  apiToken: string
): Promise<boolean> {
  try {
    const baseUrl = publicMapStorageUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/maps`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to check WAM existence: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json() as MapsCacheFileFormat;
    return data.maps?.[wamPath] !== undefined;
  } catch (error) {
    console.error('Error checking WAM existence:', error);
    return false;
  }
}

/**
 * Directly checks if a WAM file exists by HEAD request to the actual WAM URL.
 * Unlike checkWamExists (which queries the cache), this reaches the actual
 * file in map-storage, bypassing any cache staleness or version hash issues.
 */
export async function checkWamExistsDirect(
  publicMapStorageUrl: string,
  wamPath: string,
  apiToken: string
): Promise<boolean> {
  try {
    const baseUrl = publicMapStorageUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/${wamPath}`, {
      method: 'HEAD',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
      },
    });
    return response.ok;
  } catch (error) {
    console.error('Error directly checking WAM file existence:', error);
    return false;
  }
}

/**
 * Combined WAM existence check using a dual-check guard.
 *
 * First checks the cache, then if the cache misses, verifies via a direct
 * HEAD request to the actual WAM URL. Only returns false (doesn't exist)
 * if BOTH checks agree.
 *
 * This prevents a false cache miss (e.g. after deploy when the cache was
 * regenerated but the WAM file still exists on S3) from triggering a
 * destructive overwrite via createWamFile().
 */
export async function safeWamExists(
  publicMapStorageUrl: string,
  wamPath: string,
  apiToken: string
): Promise<boolean> {
  // First check: fast path via cache
  const cacheExists = await checkWamExists(publicMapStorageUrl, wamPath, apiToken);
  if (cacheExists) {
    return true;
  }

  // Cache miss — verify via direct HEAD to rule out stale cache
  return await checkWamExistsDirect(publicMapStorageUrl, wamPath, apiToken);
}

/**
 * Creates a WAM file in map-storage via PUT method
 * The WAM file references an external TMJ URL
 */
export async function createWamFile(
  publicMapStorageUrl: string,
  wamPath: string,
  externalMapUrl: string,
  apiToken: string,
  playUrl: string
): Promise<void> {
  const wamFile: WAMFileFormat = {
    version: "2.0.0",
    mapUrl: externalMapUrl, // Points to external TMJ (e.g., GitHub Pages)
    entities: {},
    areas: [],
    entityCollections: [
      {
        url: `${playUrl}/collections/FurnitureCollection.json`,
        type: "file"
      },
      {
        url: `${playUrl}/collections/OfficeCollection.json`,
        type: "file"
      }
    ],
    metadata: {}
  };

  try {
    const baseUrl = publicMapStorageUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/${wamPath}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(wamFile),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create WAM file: ${response.status} ${response.statusText} - ${errorText}`);
    }

    console.log(`Created WAM file at ${wamPath}`);
  } catch (error) {
    console.error('Error creating WAM file:', error);
    throw new Error(`Failed to create WAM file: ${error instanceof Error ? error.message : String(error)}`);
  }
}


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
    version: "1.0.0",
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


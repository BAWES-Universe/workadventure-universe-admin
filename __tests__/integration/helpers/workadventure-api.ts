/**
 * WorkAdventure API Helper
 * Simulates WorkAdventure making API calls to Admin API
 */

import { getTestConfig } from '../config';

export interface WorkAdventureAPICallOptions {
  playUri?: string;
  userIdentifier?: string;
  accessToken?: string;
  ipAddress?: string;
  searchText?: string;
  [key: string]: string | undefined;
}

/**
 * Simulate WorkAdventure calling Admin API
 * This mimics the actual request pattern WorkAdventure uses
 */
export async function callWorkAdventureAPI(
  endpoint: string,
  options: WorkAdventureAPICallOptions = {}
): Promise<Response> {
  const config = getTestConfig();
  const url = new URL(`${config.adminApiUrl}${endpoint}`);

  // Add query parameters (as WorkAdventure does)
  Object.entries(options).forEach(([key, value]) => {
    if (value !== undefined) {
      url.searchParams.append(key, value);
    }
  });

  // WorkAdventure always includes Bearer token in Authorization header
  const headers: HeadersInit = {
    Authorization: `Bearer ${config.adminApiToken}`,
    'Accept-Language': 'en',
  };

  return fetch(url.toString(), {
    method: 'GET',
    headers,
  });
}

/**
 * Simulate WorkAdventure POST request
 */
export async function callWorkAdventureAPIPOST(
  endpoint: string,
  body: Record<string, any>,
  options: { accessToken?: string } = {}
): Promise<Response> {
  const config = getTestConfig();
  const url = new URL(`${config.adminApiUrl}${endpoint}`);

  // Add accessToken to query if provided (some endpoints use this)
  if (options.accessToken) {
    url.searchParams.append('accessToken', options.accessToken);
  }

  const headers: HeadersInit = {
    Authorization: `Bearer ${config.adminApiToken}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en',
  };

  return fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/**
 * Test capabilities endpoint (called by WorkAdventure on startup)
 */
export async function testCapabilities(): Promise<Response> {
  return callWorkAdventureAPI('/api/capabilities');
}

/**
 * Test map endpoint
 */
export async function testMap(playUri: string, accessToken?: string): Promise<Response> {
  return callWorkAdventureAPI('/api/map', {
    playUri,
    accessToken,
  });
}

/**
 * Test room access endpoint
 */
export async function testRoomAccess(
  userIdentifier: string,
  playUri: string,
  accessToken?: string,
  ipAddress: string = '127.0.0.1'
): Promise<Response> {
  return callWorkAdventureAPI('/api/room/access', {
    userIdentifier,
    playUri,
    accessToken,
    ipAddress,
  });
}

/**
 * Test members endpoint
 */
export async function testMembers(playUri: string, searchText?: string): Promise<Response> {
  return callWorkAdventureAPI('/api/members', {
    playUri,
    searchText,
  });
}


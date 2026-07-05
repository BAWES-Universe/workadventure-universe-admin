/**
 * OIDC Mock Helper
 * Utilities to interact with WorkAdventure OIDC mock server
 */

import { getTestConfig } from '../config';
import * as client from 'openid-client';

let oidcClient: client.Configuration | null = null;

/**
 * Get OIDC client for WorkAdventure mock
 */
async function getOidcClient(): Promise<client.Configuration> {
  if (oidcClient) {
    return oidcClient;
  }

  const config = getTestConfig();

  oidcClient = await client.discovery(
    new URL(config.oidcIssuer),
    config.oidcClientId,
    { client_secret: config.oidcClientSecret },
  );

  return oidcClient;
}

/**
 * Get OIDC access token from WorkAdventure mock
 * 
 * Note: This uses the OIDC authorization code flow.
 * For testing, we'll need to simulate the full flow or use a test token.
 * 
 * @param username - OIDC mock username (e.g., 'User1', 'User2')
 * @param password - OIDC mock password (usually 'pwd')
 * @returns Access token
 */
export async function getOidcToken(username: string, password: string): Promise<string> {
  const config = getTestConfig();
  const oidc = await getOidcClient();

  // For integration tests, we need to complete the OIDC flow
  // This is a simplified version - in practice, you'd need to:
  // 1. Get authorization URL
  // 2. Simulate user login (username/password)
  // 3. Get authorization code
  // 4. Exchange for tokens

  // For now, we'll use a direct approach if the OIDC mock supports it
  // Otherwise, we'll need to get a token from an actual WorkAdventure session

  // Check if we can get token via resource owner password credentials grant
  // (if OIDC mock supports it)
  try {
    const tokenSet = await client.genericGrantRequest(
      oidc,
      'password',
      { username, password, scope: 'openid profile email' },
    );

    return tokenSet.access_token || '';
  } catch (error) {
    // If password grant not supported, we need to use authorization code flow
    // For integration tests, we'll throw an error with instructions
    throw new Error(
      `Could not get OIDC token. The OIDC mock may require authorization code flow.\n` +
      `To get a token for testing:\n` +
      `1. Log into WorkAdventure at ${config.workadventureUrl}\n` +
      `2. Use credentials: ${username}/${password}\n` +
      `3. Get accessToken from browser DevTools → Network → API calls\n` +
      `4. Or implement full OIDC authorization code flow in tests\n` +
      `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Validate an OIDC access token
 */
export async function validateOidcToken(token: string): Promise<boolean> {
  try {
    const oidc = await getOidcClient();
    await client.fetchUserInfo(oidc, token, client.skipSubjectCheck);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get user info from OIDC token
 */
export async function getUserInfoFromToken(token: string) {
  const oidc = await getOidcClient();
  return await client.fetchUserInfo(oidc, token, client.skipSubjectCheck);
}


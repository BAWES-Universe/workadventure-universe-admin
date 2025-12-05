/**
 * Integration test configuration
 * Validates environment and provides test configuration
 */

export interface TestConfig {
  adminApiUrl: string;
  adminApiToken: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  databaseUrl: string;
  workadventureUrl: string;
}

/**
 * Get and validate test configuration
 */
export function getTestConfig(): TestConfig {
  const adminApiUrl = process.env.ADMIN_API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3333';
  const adminApiToken = process.env.ADMIN_API_TOKEN;
  const oidcIssuer = process.env.OIDC_ISSUER || 'http://oidc.workadventure.localhost';
  const oidcClientId = process.env.OIDC_CLIENT_ID || 'authorization-code-client-id';
  const oidcClientSecret = process.env.OIDC_CLIENT_SECRET || 'authorization-code-client-secret';
  const databaseUrl = process.env.DATABASE_URL || '';
  const workadventureUrl = process.env.WORKADVENTURE_URL || 'http://play.workadventure.localhost';

  if (!adminApiToken) {
    throw new Error('ADMIN_API_TOKEN environment variable is required for integration tests');
  }

  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for integration tests');
  }

  return {
    adminApiUrl,
    adminApiToken,
    oidcIssuer,
    oidcClientId,
    oidcClientSecret,
    databaseUrl,
    workadventureUrl,
  };
}

/**
 * Check if required services are available
 */
export async function checkServices(): Promise<{ available: boolean; errors: string[] }> {
  const config = getTestConfig();
  const errors: string[] = [];

  // Check Admin API
  try {
    const response = await fetch(`${config.adminApiUrl}/api/capabilities`, {
      headers: {
        Authorization: `Bearer ${config.adminApiToken}`,
      },
    });
    if (!response.ok && response.status !== 401) {
      errors.push(`Admin API not responding: ${response.status}`);
    }
  } catch (error) {
    errors.push(`Admin API not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  // Check OIDC Issuer
  try {
    const response = await fetch(`${config.oidcIssuer}/.well-known/openid-configuration`);
    if (!response.ok) {
      errors.push(`OIDC Issuer not responding: ${response.status}`);
    }
  } catch (error) {
    errors.push(`OIDC Issuer not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return {
    available: errors.length === 0,
    errors,
  };
}


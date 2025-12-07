// Use dynamic import for openid-client (ESM-only package)
// This avoids build issues with Next.js/Turbopack
// openid-client v6+ uses a new API with discovery() and fetchUserInfo()
type Configuration = any;
type UserInfoResponse = any;

let oidcConfig: Configuration | null = null;
let openidClientModule: any = null;

/**
 * Dynamically imports openid-client module
 */
async function getOpenIdClientModule() {
  if (!openidClientModule) {
    openidClientModule = await import('openid-client');
  }
  return openidClientModule;
}

/**
 * Gets or creates the OIDC configuration
 */
export async function getOidcConfig(): Promise<Configuration> {
  if (oidcConfig) {
    return oidcConfig;
  }
  
  const issuerUrl = process.env.OIDC_ISSUER;
  if (!issuerUrl) {
    throw new Error('OIDC_ISSUER not configured');
  }
  
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be configured');
  }
  
  // Dynamically import openid-client
  const module = await getOpenIdClientModule();
  
  // openid-client v6+ uses discovery() function instead of Issuer.discover()
  const { discovery, ClientSecretPost } = module;
  
  if (!discovery) {
    throw new Error('Failed to import discovery from openid-client. Available exports: ' + Object.keys(module).slice(0, 10).join(', '));
  }
  
  // Discover and create configuration
  oidcConfig = await discovery(
    new URL(issuerUrl),
    clientId,
    undefined, // client metadata (optional)
    ClientSecretPost(clientSecret), // client authentication
  );
  
  return oidcConfig;
}

/**
 * Validates an OIDC access token and returns user info
 */
export async function validateAccessToken(token: string): Promise<UserInfoResponse | null> {
  try {
    const config = await getOidcConfig();
    const module = await getOpenIdClientModule();
    const { fetchUserInfo, skipSubjectCheck } = module;
    
    if (!fetchUserInfo) {
      throw new Error('Failed to import fetchUserInfo from openid-client');
    }
    
    // Decode token to get subject for validation
    let subject: string | typeof skipSubjectCheck = skipSubjectCheck;
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = parts[1];
        const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
        const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString());
        if (decoded.sub) {
          subject = decoded.sub;
        }
      }
    } catch (e) {
      // If we can't decode, use skipSubjectCheck
      console.warn('Could not decode token to get subject, skipping subject check');
    }
    
    // Fetch user info using the new v6 API
    const userInfo = await fetchUserInfo(config, token, subject);
    return userInfo;
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}

/**
 * Authenticated user information
 */
export interface AuthenticatedUser {
  identifier: string; // UUID or email
  email?: string;
  name?: string;
  tags?: string[];
  isAuthenticated: boolean;
}

/**
 * Authenticates a request and returns user information
 */
export async function authenticateRequest(
  request: Request
): Promise<AuthenticatedUser | null> {
  // 1. Validate Bearer token
  const authHeader = request.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  if (!expectedToken || token !== expectedToken) {
    return null;
  }
  
  // 2. Extract access token from query params
  const url = new URL(request.url);
  const accessToken = url.searchParams.get('accessToken');
  
  if (!accessToken) {
    // Anonymous user
    const userIdentifier = url.searchParams.get('userIdentifier');
    return {
      identifier: userIdentifier || 'anonymous',
      isAuthenticated: false,
    };
  }
  
  // 3. Validate OIDC token
  const userInfo = await validateAccessToken(accessToken);
  if (!userInfo) {
    return null; // Invalid token
  }
  
  // 4. Extract tags from token (if available)
  const tags = userInfo.tags 
    ? (Array.isArray(userInfo.tags) ? userInfo.tags : JSON.parse(String(userInfo.tags)))
    : [];
  
  return {
    identifier: userInfo.sub || userInfo.email || 'unknown',
    email: userInfo.email,
    name: userInfo.name || userInfo.preferred_username,
    tags,
    isAuthenticated: true,
  };
}


import { Issuer, Client, UserInfoResponse } from 'openid-client';

let oidcClient: Client | null = null;
let issuer: Issuer<unknown> | null = null;

/**
 * Gets or creates the OIDC client instance
 */
export async function getOidcClient(): Promise<Client> {
  if (oidcClient) {
    return oidcClient;
  }
  
  const issuerUrl = process.env.OIDC_ISSUER;
  if (!issuerUrl) {
    throw new Error('OIDC_ISSUER not configured');
  }
  
  // Discover issuer if not already discovered
  if (!issuer) {
    issuer = await Issuer.discover(issuerUrl);
  }
  
  const clientId = process.env.OIDC_CLIENT_ID;
  const clientSecret = process.env.OIDC_CLIENT_SECRET;
  
  if (!clientId || !clientSecret) {
    throw new Error('OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be configured');
  }
  
  oidcClient = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
  });
  
  return oidcClient;
}

/**
 * Validates an OIDC access token and returns user info
 */
export async function validateAccessToken(token: string): Promise<UserInfoResponse | null> {
  try {
    const client = await getOidcClient();
    const userInfo = await client.userinfo(token);
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


# OIDC Integration Guide

Complete guide for integrating OIDC authentication with your WorkAdventure Admin API.

## Table of Contents

- [Overview](#overview)
- [Development Setup (OIDC Mock)](#development-setup-oidc-mock)
- [Production Setup (Authentik)](#production-setup-authentik)
- [Token Validation](#token-validation)
- [User Information Extraction](#user-information-extraction)
- [Best Practices](#best-practices)

## Overview

WorkAdventure uses OIDC (OpenID Connect) for user authentication. Your Admin API receives OIDC access tokens that can be validated to:

- Authenticate users
- Extract user information (email, name, tags)
- Make authorization decisions
- Enrich user data

## Development Setup (OIDC Mock)

### Using OIDC Mock Server

For local development, WorkAdventure includes an OIDC mock server. This is the **recommended approach** for development.

### Configuration

```env
# .env.local
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret
```

### OIDC Mock Users

The OIDC mock server comes with pre-configured test users:

1. **User1** (admin)
   - Username: `User1`
   - Password: `pwd`
   - Email: `john.doe@example.com`
   - Tags: `["admin"]`

2. **User2** (member)
   - Username: `User2`
   - Password: `pwd`
   - Email: `alice.doe@example.com`
   - Tags: `["member"]`

3. **UserMatrix** (admin)
   - Username: `UserMatrix`
   - Password: `pwd`
   - Email: `john.doe@example.com`
   - Tags: `["admin"]`

### Benefits of OIDC Mock

- ✅ No additional infrastructure needed
- ✅ Fast startup (runs with WorkAdventure)
- ✅ Pre-configured test users
- ✅ Matches production OIDC flow
- ✅ Easy to reset/restart

## Production Setup (Authentik)

### Authentik Configuration

1. **Create OIDC Provider in Authentik**
   - Go to Applications → Providers
   - Create new OIDC Provider
   - Note the `Issuer URL`, `Client ID`, and `Client Secret`

2. **Configure Application**
   - Create new Application
   - Link to OIDC Provider
   - Set redirect URIs

3. **Set Environment Variables**

```env
# .env.production
OIDC_ISSUER=https://authentik.yourdomain.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

### Authentik User Claims

Configure Authentik to include custom claims:

- `email` - User email
- `name` - User display name
- `preferred_username` - Username
- `tags` - Custom tags (as JSON array string)

## Token Validation

### Setup OIDC Client

```typescript
// lib/oidc.ts
import { Issuer, Client } from 'openid-client';

let oidcClient: Client | null = null;
let issuer: Issuer<any> | null = null;

export async function getOidcClient(): Promise<Client> {
  if (oidcClient) {
    return oidcClient;
  }
  
  if (!issuer) {
    issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
  }
  
  oidcClient = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID!,
    client_secret: process.env.OIDC_CLIENT_SECRET!,
  });
  
  return oidcClient;
}
```

### Validate Access Token

```typescript
// lib/oidc.ts (continued)
export async function validateAccessToken(token: string) {
  try {
    const client = await getOidcClient();
    
    // Validate token and get user info
    const userInfo = await client.userinfo(token);
    
    return userInfo;
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}
```

### Token Introspection (Alternative)

For more detailed token validation:

```typescript
export async function introspectToken(token: string) {
  try {
    const client = await getOidcClient();
    
    // Introspect token (requires introspection endpoint)
    const introspection = await client.introspect(token);
    
    if (!introspection.active) {
      return null; // Token is not active
    }
    
    return introspection;
  } catch (error) {
    console.error('Token introspection failed:', error);
    return null;
  }
}
```

## User Information Extraction

### Extract User Data from Token

```typescript
// lib/user.ts
import { validateAccessToken } from './oidc';

export interface UserInfo {
  identifier: string;
  email?: string;
  name?: string;
  tags?: string[];
  isAuthenticated: boolean;
}

export async function extractUserInfo(
  accessToken: string | null
): Promise<UserInfo | null> {
  if (!accessToken) {
    return {
      identifier: 'anonymous',
      isAuthenticated: false,
    };
  }
  
  const userInfo = await validateAccessToken(accessToken);
  if (!userInfo) {
    return null; // Invalid token
  }
  
  // Extract tags (may be JSON string or array)
  let tags: string[] = [];
  if (userInfo.tags) {
    if (typeof userInfo.tags === 'string') {
      try {
        tags = JSON.parse(userInfo.tags);
      } catch {
        tags = [userInfo.tags];
      }
    } else if (Array.isArray(userInfo.tags)) {
      tags = userInfo.tags;
    }
  }
  
  return {
    identifier: userInfo.sub || userInfo.email || 'unknown',
    email: userInfo.email,
    name: userInfo.name || userInfo.preferred_username,
    tags,
    isAuthenticated: true,
  };
}
```

### Use in Endpoints

```typescript
// app/api/room/access/route.ts
import { extractUserInfo } from '@/lib/user';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const accessToken = searchParams.get('accessToken');
    const userIdentifier = searchParams.get('userIdentifier');
    
    // Extract user info from OIDC token
    const userInfo = await extractUserInfo(accessToken);
    
    if (!userInfo) {
      // Handle invalid token or anonymous user
      // Use userIdentifier as fallback
    }
    
    // Use userInfo for authorization decisions
    const hasAccess = await checkAccess(userInfo, roomUrl);
    
    // Continue with endpoint logic
  } catch (error) {
    // Error handling
  }
}
```

## Best Practices

### 1. Cache OIDC Client

The OIDC client should be cached to avoid repeated discovery:

```typescript
let oidcClient: Client | null = null;

export async function getOidcClient(): Promise<Client> {
  if (oidcClient) {
    return oidcClient;
  }
  
  // Initialize and cache
  // ...
}
```

### 2. Handle Token Errors Gracefully

```typescript
export async function validateAccessToken(token: string) {
  try {
    const client = await getOidcClient();
    const userInfo = await client.userinfo(token);
    return userInfo;
  } catch (error) {
    // Log error but don't throw
    console.error('Token validation failed:', error);
    
    // Return null to indicate invalid token
    // This allows the endpoint to handle anonymous users
    return null;
  }
}
```

### 3. Support Anonymous Users

Not all requests will have an access token. Support anonymous access:

```typescript
export async function GET(request: NextRequest) {
  const accessToken = searchParams.get('accessToken');
  const userIdentifier = searchParams.get('userIdentifier');
  
  let userInfo = null;
  if (accessToken) {
    userInfo = await extractUserInfo(accessToken);
  }
  
  // Use userIdentifier as fallback for anonymous users
  const identifier = userInfo?.identifier || userIdentifier || 'anonymous';
  
  // Continue with logic
}
```

### 4. Validate Tags Format

Tags may come in different formats:

```typescript
function parseTags(tags: any): string[] {
  if (!tags) {
    return [];
  }
  
  if (Array.isArray(tags)) {
    return tags;
  }
  
  if (typeof tags === 'string') {
    try {
      return JSON.parse(tags);
    } catch {
      return [tags];
    }
  }
  
  return [];
}
```

### 5. Environment-Specific Configuration

Use different OIDC providers for dev and prod:

```typescript
// lib/config.ts
export const oidcConfig = {
  issuer: process.env.OIDC_ISSUER!,
  clientId: process.env.OIDC_CLIENT_ID!,
  clientSecret: process.env.OIDC_CLIENT_SECRET!,
  isDevelopment: process.env.NODE_ENV === 'development',
};

// Validate config
if (!oidcConfig.issuer) {
  throw new Error('OIDC_ISSUER is required');
}
```

### 6. Token Refresh (Optional)

If you need to refresh tokens:

```typescript
export async function refreshToken(refreshToken: string) {
  try {
    const client = await getOidcClient();
    const tokenSet = await client.refresh(refreshToken);
    return tokenSet;
  } catch (error) {
    console.error('Token refresh failed:', error);
    return null;
  }
}
```

## Testing

### Test with OIDC Mock

1. Start WorkAdventure with OIDC mock:
   ```bash
   docker-compose up
   ```

2. Login as test user in WorkAdventure

3. Check your API logs for incoming requests with access tokens

4. Validate tokens in your API

### Test Token Validation

```typescript
// __tests__/oidc.test.ts
import { validateAccessToken } from '@/lib/oidc';

describe('OIDC Token Validation', () => {
  it('should validate valid token', async () => {
    // Get token from OIDC mock
    const token = 'valid-token-from-oidc-mock';
    const userInfo = await validateAccessToken(token);
    
    expect(userInfo).toBeTruthy();
    expect(userInfo?.email).toBeDefined();
  });
  
  it('should reject invalid token', async () => {
    const userInfo = await validateAccessToken('invalid-token');
    expect(userInfo).toBeNull();
  });
});
```

## Troubleshooting

### Common Issues

1. **Token validation fails**
   - Check `OIDC_ISSUER` is correct and accessible
   - Verify `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`
   - Ensure OIDC provider is running

2. **User info missing fields**
   - Check OIDC provider configuration
   - Verify scopes requested by WorkAdventure
   - Check user claims configuration

3. **Tags not parsed correctly**
   - Tags may be JSON string or array
   - Handle both formats in your code

## Next Steps

- Implement token validation in your endpoints
- Extract user information from tokens
- Use user data for authorization decisions
- Test with both OIDC mock and Authentik


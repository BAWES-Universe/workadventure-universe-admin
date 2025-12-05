# Authentication & Security

Complete guide to authentication and security for the WorkAdventure Admin API.

## Table of Contents

- [Bearer Token Authentication](#bearer-token-authentication)
- [OIDC Integration](#oidc-integration)
- [Token Validation](#token-validation)
- [Security Best Practices](#security-best-practices)
- [Environment Variables](#environment-variables)

## Bearer Token Authentication

### Overview

All requests from WorkAdventure include a Bearer token in the `Authorization` header. This token is set via the `ADMIN_API_TOKEN` environment variable in WorkAdventure.

### Implementation

In Next.js, create a middleware to validate the Bearer token:

```typescript
// middleware.ts or lib/auth.ts
export function validateAdminToken(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  
  if (!authHeader) {
    return false;
  }
  
  const token = authHeader.replace('Bearer ', '').trim();
  const expectedToken = process.env.ADMIN_API_TOKEN;
  
  if (!expectedToken) {
    throw new Error('ADMIN_API_TOKEN not configured');
  }
  
  return token === expectedToken;
}
```

### Usage in API Routes

```typescript
// app/api/map/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { validateAdminToken } from '@/lib/auth';

export async function GET(request: NextRequest) {
  // Validate Bearer token
  if (!validateAdminToken(request)) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }
  
  // Your endpoint logic here
  return NextResponse.json({ /* ... */ });
}
```

### Error Response

If authentication fails, return:

```json
{
  "status": "error",
  "type": "unauthorized",
  "title": "Unauthorized",
  "subtitle": "Invalid or missing authentication token",
  "code": "UNAUTHORIZED",
  "details": "Please provide a valid Bearer token in the Authorization header"
}
```

HTTP Status: `401 Unauthorized` or `403 Forbidden`

---

## OIDC Integration

### Overview

WorkAdventure uses OIDC (OpenID Connect) for user authentication. Your Admin API may receive OIDC access tokens that need to be validated.

### Development Setup (OIDC Mock)

For local development, use the OIDC mock server:

```env
# .env.local
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret
```

### Production Setup (Authentik)

For production, configure Authentik:

```env
# .env.production
OIDC_ISSUER=https://authentik.yourdomain.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

### Token Validation

Install OIDC validation library:

```bash
npm install openid-client
```

Create OIDC client:

```typescript
// lib/oidc.ts
import { Issuer, Client } from 'openid-client';

let oidcClient: Client | null = null;

export async function getOidcClient(): Promise<Client> {
  if (oidcClient) {
    return oidcClient;
  }
  
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER!);
  
  oidcClient = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID!,
    client_secret: process.env.OIDC_CLIENT_SECRET!,
  });
  
  return oidcClient;
}

export async function validateAccessToken(token: string) {
  const client = await getOidcClient();
  
  try {
    const userInfo = await client.userinfo(token);
    return userInfo;
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}
```

### Using OIDC Tokens in Endpoints

```typescript
// app/api/room/access/route.ts
import { validateAccessToken } from '@/lib/oidc';

export async function GET(request: NextRequest) {
  // Validate Bearer token
  if (!validateAdminToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
  const { searchParams } = new URL(request.url);
  const accessToken = searchParams.get('accessToken');
  
  // Validate OIDC token if provided
  let userInfo = null;
  if (accessToken) {
    userInfo = await validateAccessToken(accessToken);
    if (!userInfo) {
      // Token is invalid, but user might still access as anonymous
      // Handle based on your requirements
    }
  }
  
  // Use userInfo to get user details
  // userInfo.sub, userInfo.email, userInfo.name, etc.
  
  // Your endpoint logic here
}
```

### OIDC User Claims

Common claims you'll receive:

- `sub` - Subject identifier (user ID)
- `email` - User email
- `name` - User display name
- `preferred_username` - Username
- `tags` - Custom tags (if configured in OIDC provider)

---

## Token Validation

### Access Token Validation Flow

1. **Receive request** with optional `accessToken` query parameter
2. **Validate Bearer token** in Authorization header
3. **If accessToken provided**:
   - Validate with OIDC provider
   - Extract user information
   - Use for authorization decisions
4. **If no accessToken**:
   - User is anonymous
   - Apply anonymous access rules

### Example Implementation

```typescript
// lib/auth.ts
import { validateAccessToken } from './oidc';

export interface AuthenticatedUser {
  identifier: string; // UUID or email
  email?: string;
  name?: string;
  tags?: string[];
  isAuthenticated: boolean;
}

export async function authenticateRequest(
  request: Request
): Promise<AuthenticatedUser | null> {
  // 1. Validate Bearer token
  if (!validateAdminToken(request)) {
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
    ? (Array.isArray(userInfo.tags) ? userInfo.tags : JSON.parse(userInfo.tags))
    : [];
  
  return {
    identifier: userInfo.sub || userInfo.email || 'unknown',
    email: userInfo.email,
    name: userInfo.name || userInfo.preferred_username,
    tags,
    isAuthenticated: true,
  };
}
```

---

## Security Best Practices

### 1. Always Validate Bearer Token

Never skip Bearer token validation, even for public endpoints:

```typescript
// ❌ BAD
export async function GET(request: NextRequest) {
  // Missing validation
  return NextResponse.json({ data: 'public' });
}

// ✅ GOOD
export async function GET(request: NextRequest) {
  if (!validateAdminToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ data: 'public' });
}
```

### 2. Validate User Input

Always validate and sanitize user input:

```typescript
import { z } from 'zod';

const PlayUriSchema = z.string().url().regex(/^https?:\/\/.+\/@\/.+\/.+\/.+$/);

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playUri = searchParams.get('playUri');
  
  // Validate playUri
  const result = PlayUriSchema.safeParse(playUri);
  if (!result.success) {
    return NextResponse.json(
      { error: 'Invalid playUri format' },
      { status: 400 }
    );
  }
  
  // Continue with validated input
}
```

### 3. Rate Limiting

Implement rate limiting to prevent abuse:

```typescript
// lib/rate-limit.ts
import { LRUCache } from 'lru-cache';

const rateLimit = new LRUCache<string, number>({
  max: 500,
  ttl: 60000, // 1 minute
});

export function checkRateLimit(identifier: string, limit: number = 100): boolean {
  const count = rateLimit.get(identifier) || 0;
  
  if (count >= limit) {
    return false;
  }
  
  rateLimit.set(identifier, count + 1);
  return true;
}

// Usage
export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  
  if (!checkRateLimit(ip, 100)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429 }
    );
  }
  
  // Continue
}
```

### 4. IP Address Validation

Use IP addresses for ban checking:

```typescript
export async function GET(request: NextRequest) {
  const ipAddress = 
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'unknown';
  
  // Check if IP is banned
  const isBanned = await checkBanStatus(ipAddress);
  if (isBanned) {
    return NextResponse.json(
      { is_banned: true, message: 'You are banned' },
      { status: 200 }
    );
  }
  
  // Continue
}
```

### 5. Secure Headers

Add security headers to responses:

```typescript
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const response = NextResponse.next();
  
  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  
  return response;
}
```

### 6. Logging

Log authentication events for security monitoring:

```typescript
export async function GET(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  
  // Log access
  console.log({
    timestamp: new Date().toISOString(),
    ip,
    userAgent,
    endpoint: request.url,
    authenticated: validateAdminToken(request),
  });
  
  // Continue
}
```

---

## Environment Variables

### Required Variables

```env
# Admin API Token (must match WorkAdventure's ADMIN_API_TOKEN)
ADMIN_API_TOKEN=your-secret-token-here

# OIDC Configuration
OIDC_ISSUER=http://oidc.workadventure.localhost  # Dev
# OIDC_ISSUER=https://authentik.yourdomain.com   # Prod
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret
```

### Optional Variables

```env
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/workadventure

# Redis (for caching/rate limiting)
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=info
SENTRY_DSN=https://your-sentry-dsn

# Rate Limiting
RATE_LIMIT_REQUESTS=100
RATE_LIMIT_WINDOW=60000
```

### Environment-Specific Configuration

```typescript
// lib/config.ts
export const config = {
  adminApiToken: process.env.ADMIN_API_TOKEN!,
  oidc: {
    issuer: process.env.OIDC_ISSUER!,
    clientId: process.env.OIDC_CLIENT_ID!,
    clientSecret: process.env.OIDC_CLIENT_SECRET!,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
  },
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',
};

// Validate required config
if (!config.adminApiToken) {
  throw new Error('ADMIN_API_TOKEN is required');
}
if (!config.oidc.issuer) {
  throw new Error('OIDC_ISSUER is required');
}
```

---

## Testing Authentication

### Test Bearer Token Validation

```typescript
// __tests__/auth.test.ts
import { validateAdminToken } from '@/lib/auth';

describe('Bearer Token Validation', () => {
  it('should accept valid token', () => {
    const request = new Request('http://localhost/api/test', {
      headers: {
        'Authorization': `Bearer ${process.env.ADMIN_API_TOKEN}`,
      },
    });
    
    expect(validateAdminToken(request)).toBe(true);
  });
  
  it('should reject invalid token', () => {
    const request = new Request('http://localhost/api/test', {
      headers: {
        'Authorization': 'Bearer invalid-token',
      },
    });
    
    expect(validateAdminToken(request)).toBe(false);
  });
  
  it('should reject missing token', () => {
    const request = new Request('http://localhost/api/test');
    expect(validateAdminToken(request)).toBe(false);
  });
});
```

---

## Troubleshooting

### Common Issues

1. **401 Unauthorized errors**
   - Check that `ADMIN_API_TOKEN` matches in both WorkAdventure and your API
   - Verify the Authorization header format: `Bearer {token}`

2. **OIDC token validation fails**
   - Verify `OIDC_ISSUER` is correct and accessible
   - Check `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are correct
   - Ensure OIDC provider is running (for dev: OIDC mock server)

3. **CORS issues**
   - WorkAdventure makes server-to-server calls, so CORS shouldn't be an issue
   - If testing from browser, configure CORS headers appropriately

---

## Next Steps

- Read [SETUP.md](./SETUP.md) for Next.js project setup
- Review [ENDPOINTS.md](./ENDPOINTS.md) for endpoint implementations
- Check [EXAMPLES.md](./EXAMPLES.md) for code examples


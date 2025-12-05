# Next.js Setup Guide

Complete guide to setting up a Next.js Admin API for WorkAdventure.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Setup](#project-setup)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Development Setup](#development-setup)
- [Production Deployment](#production-deployment)
- [Testing](#testing)

## Prerequisites

- Node.js 18+ and npm/yarn/pnpm
- Basic knowledge of Next.js, TypeScript, and REST APIs
- Access to WorkAdventure instance (local or production)
- OIDC provider (OIDC mock for dev, Authentik for prod)

## Project Setup

### 1. Create Next.js Project

```bash
npx create-next-app@latest workadventure-admin-api --typescript --tailwind --app --no-src-dir
cd workadventure-admin-api
```

### 2. Install Dependencies

```bash
# Core dependencies
npm install zod openid-client

# Database (Required)
npm install @prisma/client prisma

# Optional but recommended
npm install redis ioredis          # For caching/rate limiting
npm install lru-cache              # For in-memory caching
npm install @sentry/nextjs        # For error tracking

# Development dependencies
npm install -D @types/node
```

### 3. Initialize Prisma

```bash
# Initialize Prisma
npx prisma init

# This creates:
# - prisma/schema.prisma (database schema)
# - .env (with DATABASE_URL)
```

Update `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"  // or "mysql", "sqlite", etc.
  url      = env("DATABASE_URL")
}
```

See [DATABASE.md](./DATABASE.md) for the complete Prisma schema.

### 4. Initialize Project Structure

```bash
mkdir -p app/api/{map,room,members,woka,companion,ban,report,chat,oauth}
mkdir -p lib/{auth,oidc,db,types}
mkdir -p types
mkdir -p schemas
```

## Project Structure

```
workadventure-admin-api/
├── app/
│   ├── api/
│   │   ├── capabilities/
│   │   │   └── route.ts
│   │   ├── map/
│   │   │   └── route.ts
│   │   ├── room/
│   │   │   ├── access/
│   │   │   │   └── route.ts
│   │   │   ├── sameWorld/
│   │   │   │   └── route.ts
│   │   │   └── tags/
│   │   │       └── route.ts
│   │   ├── members/
│   │   │   ├── route.ts
│   │   │   └── [memberUUID]/
│   │   │       └── route.ts
│   │   ├── woka/
│   │   │   └── list/
│   │   │       └── route.ts
│   │   ├── companion/
│   │   │   └── list/
│   │   │       └── route.ts
│   │   ├── ban/
│   │   │   └── route.ts
│   │   ├── report/
│   │   │   └── route.ts
│   │   └── chat/
│   │       └── members/
│   │           └── route.ts
│   └── layout.tsx
├── lib/
│   ├── auth.ts          # Bearer token validation
│   ├── oidc.ts          # OIDC client and token validation
│   ├── db.ts            # Prisma client instance
│   ├── types.ts         # TypeScript types
│   └── utils.ts         # Utility functions
├── prisma/
│   ├── schema.prisma    # Prisma database schema
│   └── migrations/      # Database migrations
├── types/
│   └── workadventure.ts  # WorkAdventure type definitions
├── schemas/
│   └── workadventure.ts  # Zod validation schemas
├── .env.local           # Local environment variables
├── .env.example         # Example environment variables
├── next.config.js       # Next.js configuration
├── tsconfig.json        # TypeScript configuration
└── package.json
```

## Configuration

### 1. Environment Variables

Create `.env.local`:

```env
# Admin API Token (must match WorkAdventure's ADMIN_API_TOKEN)
ADMIN_API_TOKEN=your-secret-token-here

# OIDC Configuration (Development - OIDC Mock)
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret

# OIDC Configuration (Production - Authentik)
# OIDC_ISSUER=https://authentik.yourdomain.com
# OIDC_CLIENT_ID=your-client-id
# OIDC_CLIENT_SECRET=your-client-secret

# Database (Required - Prisma)
DATABASE_URL=postgresql://user:password@localhost:5432/workadventure

# Redis (optional, for caching/rate limiting)
REDIS_URL=redis://localhost:6379

# Application
NODE_ENV=development
LOG_LEVEL=info
```

**Note:** The `DATABASE_URL` is required for Prisma. See [DATABASE.md](./DATABASE.md) for the complete schema.

Create `.env.example`:

```env
ADMIN_API_TOKEN=
OIDC_ISSUER=
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
DATABASE_URL=
REDIS_URL=
NODE_ENV=development
LOG_LEVEL=info
```

### 2. Next.js Configuration

Update `next.config.js`:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable API routes
  experimental: {
    // Add any experimental features you need
  },
  
  // Environment variables (public)
  env: {
    // Add any public env vars here
  },
  
  // Headers for security
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
```

### 3. TypeScript Configuration

Update `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

## Development Setup

### 1. Create Core Library Files

**lib/auth.ts** - Bearer token validation:

```typescript
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

export function requireAuth(request: Request): void {
  if (!validateAdminToken(request)) {
    throw new Error('Unauthorized');
  }
}
```

**lib/oidc.ts** - OIDC client:

```typescript
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
  try {
    const client = await getOidcClient();
    const userInfo = await client.userinfo(token);
    return userInfo;
  } catch (error) {
    console.error('Token validation failed:', error);
    return null;
  }
}
```

**lib/utils.ts** - Utility functions:

```typescript
import { NextRequest } from 'next/server';

export function parsePlayUri(playUri: string) {
  const url = new URL(playUri);
  const pathParts = url.pathname.split('/').filter(Boolean);
  
  // Format: /@/teamSlug/worldSlug/roomSlug
  if (pathParts.length >= 4 && pathParts[0] === '@') {
    return {
      team: pathParts[1],
      world: pathParts[2],
      room: pathParts[3],
    };
  }
  
  throw new Error('Invalid playUri format');
}

export function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}
```

### 2. Create Example Endpoint

**app/api/capabilities/route.ts**:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const capabilities = {
      "api/woka/list": "v1",
      "api/save-name": "v1",
      "api/save-textures": "v1",
    };
    
    return NextResponse.json(capabilities);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### 3. Start Development Server

```bash
npm run dev
```

Your API will be available at `http://localhost:3000/api/*`

## Production Deployment

### 1. Build for Production

```bash
npm run build
```

### 2. Environment Variables

Set all required environment variables in your hosting platform:

- Vercel: Project Settings → Environment Variables
- Railway: Variables tab
- Docker: `.env` file or environment variables

### 3. Deploy

**Vercel:**
```bash
npm install -g vercel
vercel --prod
```

**Docker:**
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

**Railway/Render:**
- Connect your Git repository
- Set environment variables
- Deploy automatically on push

### 4. Configure WorkAdventure

Update WorkAdventure environment variables:

```env
ADMIN_API_URL=https://your-api-domain.com
ADMIN_API_TOKEN=your-secret-token-here
```

## Testing

### 1. Manual Testing

Test endpoints using curl:

```bash
# Test capabilities endpoint
curl -H "Authorization: Bearer your-token" \
  http://localhost:3000/api/capabilities

# Test map endpoint
curl -H "Authorization: Bearer your-token" \
  "http://localhost:3000/api/map?playUri=http://play.workadventure.localhost/@/team/world/room"
```

### 2. Unit Tests

Create test files:

```typescript
// __tests__/auth.test.ts
import { validateAdminToken } from '@/lib/auth';

describe('Auth', () => {
  it('should validate correct token', () => {
    process.env.ADMIN_API_TOKEN = 'test-token';
    const request = new Request('http://localhost', {
      headers: { 'Authorization': 'Bearer test-token' },
    });
    expect(validateAdminToken(request)).toBe(true);
  });
});
```

### 3. Integration Tests

Test with WorkAdventure:

1. Start WorkAdventure locally
2. Configure `ADMIN_API_URL` to point to your API
3. Try accessing a room in WorkAdventure
4. Check API logs for incoming requests

## Next Steps

1. Implement core endpoints: `/api/map`, `/api/room/access`, `/api/woka/list`
2. Add database integration (if needed)
3. Implement optional endpoints based on your requirements
4. Set up monitoring and logging
5. Deploy to production

## Troubleshooting

### Common Issues

1. **401 Unauthorized**
   - Check `ADMIN_API_TOKEN` matches in both WorkAdventure and API
   - Verify Authorization header format

2. **OIDC Token Validation Fails**
   - Ensure OIDC provider is running
   - Check `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`
   - Verify network connectivity to OIDC provider

3. **CORS Errors**
   - WorkAdventure makes server-to-server calls, CORS shouldn't be needed
   - If testing from browser, add CORS headers

4. **Type Errors**
   - Ensure TypeScript types are properly imported
   - Check `tsconfig.json` paths configuration

## Additional Resources

- [Next.js API Routes Documentation](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Prisma with Next.js](https://www.prisma.io/docs/guides/deployment/deployment-guides/deploying-to-vercel)
- [WorkAdventure Documentation](https://workadventu.re/)
- [OIDC Client Library](https://github.com/panva/node-openid-client)


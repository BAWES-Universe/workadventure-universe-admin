# Code Examples

Practical examples for implementing WorkAdventure Admin API endpoints in Next.js.

## Table of Contents

- [Basic Endpoint Structure](#basic-endpoint-structure)
- [Core Endpoints](#core-endpoints)
- [User Management](#user-management)
- [Map & Room Management](#map--room-management)
- [Woka & Companion Management](#woka--companion-management)
- [Moderation](#moderation)
- [Error Handling](#error-handling)
- [Database Integration](#database-integration)

## Basic Endpoint Structure

### Template for All Endpoints

```typescript
// app/api/example/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri, getClientIp } from '@/lib/utils';

export async function GET(request: NextRequest) {
  try {
    // 1. Authenticate
    requireAuth(request);
    
    // 2. Parse query parameters
    const { searchParams } = new URL(request.url);
    const param = searchParams.get('param');
    
    // 3. Validate input
    if (!param) {
      return NextResponse.json(
        { error: 'Missing required parameter' },
        { status: 400 }
      );
    }
    
    // 4. Business logic
    const result = await yourBusinessLogic(param);
    
    // 5. Return response
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

---

## Core Endpoints

### GET /api/capabilities

```typescript
// app/api/capabilities/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const capabilities = {
      "api/woka/list": "v1",
      "api/save-name": "v1",
      "api/save-textures": "v1",
      "api/ice-servers": "v1",
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

### GET /api/map

```typescript
// app/api/map/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { validateAccessToken } from '@/lib/oidc';
import type { MapDetailsData, RoomRedirect, ErrorApiData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    const userId = searchParams.get('userId');
    const accessToken = searchParams.get('accessToken');
    const locale = request.headers.get('accept-language') || 'en';
    
    if (!playUri) {
      return NextResponse.json(
        {
          status: "error",
          type: "error",
          title: "Missing parameter",
          subtitle: "playUri is required",
          code: "MISSING_PARAMETER",
          details: "The playUri parameter is required"
        } as ErrorApiData,
        { status: 400 }
      );
    }
    
    // Parse play URI
    const { team, world, room } = parsePlayUri(playUri);
    
    // Validate OIDC token if provided
    let userInfo = null;
    if (accessToken) {
      userInfo = await validateAccessToken(accessToken);
    }
    
    // Check if user has access to this map
    const hasAccess = await checkMapAccess(team, world, room, userId, userInfo);
    
    if (!hasAccess) {
      return NextResponse.json(
        {
          status: "error",
          type: "unauthorized",
          title: "Access denied",
          subtitle: "You do not have access to this map",
          code: "MAP_ACCESS_DENIED",
          details: "You need to be a member to access this map"
        } as ErrorApiData,
        { status: 403 }
      );
    }
    
    // Get map details from database or configuration
    const mapDetails: MapDetailsData = {
      mapUrl: `https://example.com/maps/${world}.json`,
      wamSettings: {
        wamUrl: `https://example.com/wam/${world}.wam`
      },
      policy: "public",
      tags: ["editor", "member"],
      authenticationMandatory: false,
      roomName: room,
      contactPage: "https://example.com/contact"
    };
    
    return NextResponse.json(mapDetails);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/map:', error);
    return NextResponse.json(
      {
        status: "error",
        type: "error",
        title: "Connection error",
        subtitle: "Something went wrong",
        code: "MAP_ERROR",
        details: error instanceof Error ? error.message : "Unknown error"
      } as ErrorApiData,
      { status: 500 }
    );
  }
}

// Helper function (implement based on your database)
async function checkMapAccess(
  universe: string,
  world: string,
  room: string,
  userId: string | null,
  userInfo: any
): Promise<boolean> {
  // Implement your access control logic
  // Check database, permissions, etc.
  return true;
}
```

### GET /api/room/access

```typescript
// app/api/room/access/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri, getClientIp } from '@/lib/utils';
import { validateAccessToken } from '@/lib/oidc';
import type { FetchMemberDataByUuidSuccessResponse, ErrorApiData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const userIdentifier = searchParams.get('userIdentifier');
    const playUri = searchParams.get('playUri');
    const ipAddress = searchParams.get('ipAddress') || getClientIp(request);
    const characterTextureIds = searchParams.getAll('characterTextureIds');
    const companionTextureId = searchParams.get('companionTextureId');
    const accessToken = searchParams.get('accessToken');
    const chatID = searchParams.get('chatID');
    const locale = request.headers.get('accept-language') || 'en';
    
    if (!userIdentifier || !playUri) {
      return NextResponse.json(
        {
          status: "error",
          type: "error",
          title: "Missing parameters",
          subtitle: "userIdentifier and playUri are required",
          code: "MISSING_PARAMETERS",
          details: "Both userIdentifier and playUri must be provided"
        } as ErrorApiData,
        { status: 400 }
      );
    }
    
    // Parse play URI
    const { universe, world, room } = parsePlayUri(playUri);
    
    // Check if user is banned
    const banStatus = await checkBanStatus(userIdentifier, ipAddress, world);
    if (banStatus.is_banned) {
      return NextResponse.json({
        status: "ok",
        email: null,
        username: null,
        userUuid: userIdentifier,
        tags: [],
        visitCardUrl: null,
        isCharacterTexturesValid: false,
        characterTextures: [],
        isCompanionTextureValid: false,
        messages: [
          {
            type: "ban",
            message: banStatus.message
          }
        ],
        world,
      } as FetchMemberDataByUuidSuccessResponse);
    }
    
    // Validate OIDC token if provided
    let userInfo = null;
    if (accessToken) {
      userInfo = await validateAccessToken(accessToken);
    }
    
    // Get user data from database
    const user = await getUserData(userIdentifier, userInfo);
    
    if (!user) {
      return NextResponse.json(
        {
          status: "error",
          type: "error",
          title: "User not found",
          subtitle: "The user could not be found",
          code: "USER_NOT_FOUND",
          details: "The specified user does not exist"
        } as ErrorApiData,
        { status: 404 }
      );
    }
    
    // Check room access
    const hasAccess = await checkRoomAccess(user, universe, world, room);
    if (!hasAccess) {
      return NextResponse.json(
        {
          status: "error",
          type: "error",
          title: "Access denied",
          subtitle: "You do not have access to this room",
          code: "ROOM_ACCESS_DENIED",
          details: "You need to be a member to access this room"
        } as ErrorApiData,
        { status: 403 }
      );
    }
    
    // Validate textures
    const textures = await validateTextures(characterTextureIds, user);
    const companion = await validateCompanion(companionTextureId, user);
    
    // Build response
    const response: FetchMemberDataByUuidSuccessResponse = {
      status: "ok",
      email: user.email,
      username: user.name,
      userUuid: user.uuid,
      tags: user.tags || [],
      visitCardUrl: user.visitCardUrl,
      isCharacterTexturesValid: textures.isValid,
      characterTextures: textures.textures,
      isCompanionTextureValid: companion.isValid,
      companionTexture: companion.texture,
      messages: [],
      userRoomToken: "",
      activatedInviteUser: true,
      applications: [],
      canEdit: user.tags?.includes('editor') || false,
      world,
      chatID: chatID || undefined,
    };
    
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/room/access:', error);
    return NextResponse.json(
      {
        status: "error",
        type: "error",
        title: "Connection error",
        subtitle: "Something went wrong",
        code: "ROOM_ACCESS_ERROR",
        details: error instanceof Error ? error.message : "Unknown error"
      } as ErrorApiData,
      { status: 500 }
    );
  }
}

// Helper functions (implement based on your database)
async function checkBanStatus(
  userIdentifier: string,
  ipAddress: string,
  world: string
): Promise<{ is_banned: boolean; message: string }> {
  // Check database for bans
  return { is_banned: false, message: "" };
}

async function getUserData(userIdentifier: string, userInfo: any) {
  // Get user from database
  // Use userInfo if available to enrich data
  return {
    uuid: userIdentifier,
    email: userInfo?.email || null,
    name: userInfo?.name || null,
    tags: userInfo?.tags || [],
    visitCardUrl: null,
  };
}

async function checkRoomAccess(user: any, universe: string, world: string, room: string): Promise<boolean> {
  // Check if user has access to this room
  return true;
}

async function validateTextures(textureIds: string[], user: any) {
  // Validate and get texture details
  return {
    isValid: textureIds.length > 0,
    textures: textureIds.map(id => ({
      id,
      url: `https://example.com/wokas/${id}.png`,
      layer: []
    }))
  };
}

async function validateCompanion(textureId: string | null, user: any) {
  if (!textureId) {
    return { isValid: true, texture: null };
  }
  
  return {
    isValid: true,
    texture: {
      id: textureId,
      url: `https://example.com/companions/${textureId}.png`
    }
  };
}
```

---

## User Management

### GET /api/members

```typescript
// app/api/members/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import type { MemberData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    const searchText = searchParams.get('searchText') || '';
    
    if (!playUri) {
      return NextResponse.json(
        { error: 'playUri is required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(playUri);
    
    // Search members in database using Prisma
    const members = await searchMembers(universe, world, searchText);
    
    const result: MemberData[] = members.map(member => ({
      uuid: member.id,
      name: member.name,
      email: member.email,
      tags: member.tags,
      texture: member.texture,
      visitCardUrl: member.visitCardUrl,
    }));
    
    return NextResponse.json(result);
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

async function searchMembers(universe: string, world: string, searchText: string) {
  // Implement database search using Prisma
  return await prisma.worldMember.findMany({
    where: {
      world: {
        slug: world,
        universe: { slug: universe }
      },
      user: {
        OR: [
          { name: { contains: searchText, mode: 'insensitive' } },
          { email: { contains: searchText, mode: 'insensitive' } }
        ]
      }
    },
    include: { user: true }
  });
}
```

---

## Map & Room Management

### GET /api/room/sameWorld

```typescript
// app/api/room/sameWorld/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import type { ShortMapDescriptionList } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const tags = searchParams.get('tags')?.split(',') || [];
    const bypassTagFilter = searchParams.get('bypassTagFilter') === 'true';
    
    if (!roomUrl) {
      return NextResponse.json(
        { error: 'roomUrl is required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(roomUrl);
    
    // Get rooms from same world using Prisma
    const rooms = await getRoomsInWorld(universe, world, tags, bypassTagFilter);
    
    const result: ShortMapDescriptionList = rooms.map(room => ({
      name: room.name,
      roomUrl: `http://play.workadventure.localhost/@/${universe}/${world}/${room.slug}`,
      wamUrl: `http://play.workadventure.localhost/@/${universe}/${world}/${room.slug}`,
    }));
    
    return NextResponse.json(result);
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

async function getRoomsInWorld(
  universe: string,
  world: string,
  tags: string[],
  bypassTagFilter: boolean
) {
  // Implement database query using Prisma
  return await prisma.room.findMany({
    where: {
      world: {
        slug: world,
        universe: { slug: universe }
      },
      isPublic: true
    }
  });
}
```

---

## Woka & Companion Management

### GET /api/woka/list

```typescript
// app/api/woka/list/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import type { WokaList } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const uuid = searchParams.get('uuid');
    
    if (!roomUrl || !uuid) {
      return NextResponse.json(
        { error: 'roomUrl and uuid are required' },
        { status: 400 }
      );
    }
    
    const { team, world } = parsePlayUri(roomUrl);
    
    // Get user's available wokas
    const wokas = await getUserWokas(uuid, team, world);
    
    const result: WokaList = {
      collections: [
        {
          name: "Default",
          textures: wokas.map(woka => ({
            id: woka.id,
            url: woka.url,
            layer: woka.layers || []
          }))
        }
      ]
    };
    
    return NextResponse.json(result);
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

async function getUserWokas(uuid: string, universe: string, world: string) {
  // Get wokas available to this user using Prisma
  // Query user's avatar preferences or world-specific woka list
  return [];
}
```

---

## Moderation

### GET /api/ban

```typescript
// app/api/ban/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import type { AdminBannedData } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const token = searchParams.get('token'); // user identifier
    const ipAddress = searchParams.get('ipAddress');
    const roomUrl = searchParams.get('roomUrl');
    
    if (!token || !ipAddress || !roomUrl) {
      return NextResponse.json(
        { error: 'Missing required parameters' },
        { status: 400 }
      );
    }
    
    const { world } = parsePlayUri(roomUrl);
    
    // Check ban status
    const banStatus = await checkBanStatus(token, ipAddress, world);
    
    const result: AdminBannedData = {
      is_banned: banStatus.isBanned,
      message: banStatus.message || ""
    };
    
    return NextResponse.json(result);
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

async function checkBanStatus(
  userIdentifier: string,
  ipAddress: string,
  world: string
): Promise<{ isBanned: boolean; message?: string }> {
  // Check database for bans
  // Check both user identifier and IP address
  return { isBanned: false };
}
```

### POST /api/ban

```typescript
// app/api/ban/route.ts (POST method)
export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    
    const body = await request.json();
    const { uuidToBan, playUri, name, message, byUserUuid } = body;
    
    if (!uuidToBan || !playUri || !byUserUuid) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }
    
    const { world } = parsePlayUri(playUri);
    
    // Ban user
    await banUser(uuidToBan, world, {
      name,
      message,
      bannedBy: byUserUuid
    });
    
    return NextResponse.json(true);
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

async function banUser(
  userIdentifier: string,
  world: string,
  banInfo: { name?: string; message?: string; bannedBy: string }
) {
  // Save ban to database
}
```

---

## Error Handling

### Centralized Error Handler

```typescript
// lib/errors.ts
import type { ErrorApiData } from '@/types/workadventure';
import { NextResponse } from 'next/server';

export function createErrorResponse(
  type: ErrorApiData['type'],
  title: string,
  subtitle: string,
  code: string,
  details: string,
  status: number = 500
): NextResponse {
  const error: ErrorApiData = {
    status: "error",
    type,
    title,
    subtitle,
    code,
    details,
  };
  
  return NextResponse.json(error, { status });
}

export function unauthorizedError(): NextResponse {
  return createErrorResponse(
    "unauthorized",
    "Unauthorized",
    "Invalid or missing authentication token",
    "UNAUTHORIZED",
    "Please provide a valid Bearer token in the Authorization header",
    401
  );
}

export function notFoundError(resource: string): NextResponse {
  return createErrorResponse(
    "error",
    "Not found",
    `The ${resource} could not be found`,
    "NOT_FOUND",
    `The requested ${resource} does not exist`,
    404
  );
}
```

---

## Database Integration

### Database Integration with Prisma

**Prisma Client Setup:**

```typescript
// lib/db.ts
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
```

**Using Prisma in Endpoints:**

```typescript
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    // Query database using Prisma
    const users = await prisma.user.findMany({
      where: {
        // your conditions
      },
      include: {
        // relations
      }
    });
    
    return NextResponse.json(users);
  } catch (error) {
    // error handling
  }
}
```

**See [DATABASE.md](./DATABASE.md) for the complete Prisma schema and more examples.**

---

## Next Steps

- Implement these examples in your Next.js project
- Customize based on your database schema
- Add logging and monitoring
- Test with WorkAdventure


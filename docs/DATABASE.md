# Database Schema & Data Model

Complete guide to the database schema required for the WorkAdventure Admin API using **Prisma ORM**.

## Table of Contents

- [Overview](#overview)
- [Prisma Setup](#prisma-setup)
- [Complete Prisma Schema](#complete-prisma-schema)
- [Database Migrations](#database-migrations)
- [Implementation Examples](#implementation-examples)
- [Discovery Features](#discovery-features)

## Overview

The Admin API requires its own database to track:
- **Universe/World/Room hierarchy** - The structure of user-created spaces
- **User memberships** - Which users belong to which worlds/universes
- **Access control** - Permissions and tags for users
- **Social relationships** - Friends, follows, favorites (planned)
- **User data** - Profiles, Matrix chat IDs, avatars, etc.

### Key Concept: Universe Structure

```
Universe (user-created)
  └── World (contained in universe)
      └── Room (contained in world)
```

- **Universe**: Top-level container created by users. All users can create universes.
- **World**: A world belongs to a universe and contains multiple rooms.
- **Room**: A room belongs to a world and is the actual playable space.

This structure enables:
- Universe discovery (browse all universes)
- World discovery (browse worlds within a universe)
- Room discovery (browse rooms within a world)
- Social navigation (favorite, follow, teleport)

## Prisma Setup

### Initialize Prisma

```bash
# Initialize Prisma in your project
npx prisma init

# This creates:
# - prisma/schema.prisma (database schema)
# - .env (with DATABASE_URL)
```

### Prisma Configuration

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

### Environment Variable

Set `DATABASE_URL` in your `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/workadventure
```

## Complete Prisma Schema

Copy this complete schema to `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Users
model User {
  id           String   @id @default(uuid())
  uuid         String   @unique // WorkAdventure user identifier
  email        String?  @unique
  name         String?
  matrixChatId String?  @map("matrix_chat_id") // Matrix ID: "@user:matrix.org"
  createdAt    DateTime @default(now()) @map("created_at")
  updatedAt    DateTime @updatedAt @map("updated_at")

  // Relations
  ownedUniverses    Universe[]        @relation("UniverseOwner")
  worldMemberships  WorldMember[]
  universeMembers   UniverseMember[]
  bans              Ban[]             @relation("BannedUser")
  bannedBy          Ban[]             @relation("BannedBy")
  avatars           UserAvatar[]
  favorites         Favorite[]
  followers         Follow[]          @relation("Follower")
  following         Follow[]          @relation("Following")
  // Friendships: A user can be either user1 OR user2 in a friendship
  // friendships1 = friendships where this user is user1
  // friendships2 = friendships where this user is user2
  // This allows querying all friendships regardless of position
  friendships1      Friendship[]      @relation("User1")
  friendships2      Friendship[]      @relation("User2")

  @@map("users")
}

// Universes
model Universe {
  id          String   @id @default(uuid())
  slug        String   @unique // URL identifier: "my-universe"
  name        String
  description String?
  ownerId     String   @map("owner_id")
  isPublic    Boolean  @default(true) @map("is_public")
  featured    Boolean  @default(false) // For discovery
  thumbnailUrl String? @map("thumbnail_url")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  // Relations
  owner      User      @relation("UniverseOwner", fields: [ownerId], references: [id], onDelete: Cascade)
  worlds     World[]
  members    UniverseMember[]
  bans       Ban[]
  favorites  Favorite[]

  @@map("universes")
}

// Worlds
model World {
  id          String   @id @default(uuid())
  universeId  String   @map("universe_id")
  slug        String   // URL identifier: "office-world"
  name        String
  description String?
  mapUrl      String?  @map("map_url") // Tiled map JSON URL
  wamUrl      String?  @map("wam_url") // WAM file URL
  isPublic    Boolean  @default(true) @map("is_public")
  featured    Boolean  @default(false) // For discovery
  thumbnailUrl String? @map("thumbnail_url")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  // Relations
  universe   Universe     @relation(fields: [universeId], references: [id], onDelete: Cascade)
  rooms      Room[]
  members    WorldMember[]
  bans       Ban[]
  avatars    UserAvatar[]

  @@unique([universeId, slug]) // Slug unique within universe
  @@map("worlds")
}

// Rooms
model Room {
  id          String   @id @default(uuid())
  worldId     String   @map("world_id")
  slug        String   // URL identifier: "lobby"
  name        String
  description String?
  mapUrl      String?  @map("map_url") // Override world map if needed
  isPublic    Boolean  @default(true) @map("is_public")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  // Relations
  world      World      @relation(fields: [worldId], references: [id], onDelete: Cascade)
  favorites  Favorite[]

  @@unique([worldId, slug]) // Slug unique within world
  @@map("rooms")
}

// World Memberships
model WorldMember {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  worldId   String   @map("world_id")
  tags      String[] // Array of tags: ["admin", "editor", "member"]
  joinedAt  DateTime @default(now()) @map("joined_at")

  // Relations
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  world World @relation(fields: [worldId], references: [id], onDelete: Cascade)

  @@unique([userId, worldId])
  @@index([worldId])
  @@index([userId])
  @@map("world_members")
}

// Universe Memberships (Optional)
model UniverseMember {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  universeId String  @map("universe_id")
  role      String   @default("member") // owner, admin, member
  joinedAt  DateTime @default(now()) @map("joined_at")

  // Relations
  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  universe Universe @relation(fields: [universeId], references: [id], onDelete: Cascade)

  @@unique([userId, universeId])
  @@map("universe_members")
}

// Bans
model Ban {
  id        String    @id @default(uuid())
  userId    String?   @map("user_id")
  universeId String?  @map("universe_id")
  worldId   String?   @map("world_id")
  ipAddress String?   @map("ip_address") // IPv4 or IPv6
  reason    String?
  bannedById String?  @map("banned_by")
  bannedAt  DateTime  @default(now()) @map("banned_at")
  expiresAt DateTime? @map("expires_at") // NULL = permanent
  isActive  Boolean   @default(true) @map("is_active")

  // Relations
  user      User?     @relation("BannedUser", fields: [userId], references: [id], onDelete: Cascade)
  universe  Universe? @relation(fields: [universeId], references: [id], onDelete: SetNull)
  world     World?    @relation(fields: [worldId], references: [id], onDelete: SetNull)
  bannedBy  User?     @relation("BannedBy", fields: [bannedById], references: [id])

  @@index([userId])
  @@index([ipAddress])
  @@index([worldId])
  @@map("bans")
}

// User Avatars & Companions
model UserAvatar {
  id              String   @id @default(uuid())
  userId          String   @map("user_id")
  worldId         String   @map("world_id")
  textureIds      String[] @map("texture_ids") // Array of texture IDs: ["male1", "hat1"]
  companionTextureId String? @map("companion_texture_id")
  updatedAt       DateTime @default(now()) @updatedAt @map("updated_at")

  // Relations
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  world World @relation(fields: [worldId], references: [id], onDelete: Cascade)

  @@unique([userId, worldId])
  @@map("user_avatars")
}

// Favorites (for future social features)
model Favorite {
  id         String    @id @default(uuid())
  userId     String    @map("user_id")
  universeId String?   @map("universe_id")
  worldId    String?   @map("world_id")
  roomId     String?   @map("room_id")
  favoritedAt DateTime @default(now()) @map("favorited_at")

  // Relations
  user     User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  universe Universe? @relation(fields: [universeId], references: [id], onDelete: Cascade)
  world    World?   @relation(fields: [worldId], references: [id], onDelete: Cascade)
  room     Room?    @relation(fields: [roomId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("favorites")
}

// Follows (for future social features)
model Follow {
  id         String   @id @default(uuid())
  followerId String   @map("follower_id")
  followingId String @map("following_id")
  followedAt DateTime @default(now()) @map("followed_at")

  // Relations
  follower  User @relation("Follower", fields: [followerId], references: [id], onDelete: Cascade)
  following User @relation("Following", fields: [followingId], references: [id], onDelete: Cascade)

  @@unique([followerId, followingId])
  @@index([followerId])
  @@index([followingId])
  @@map("follows")
}

// Friendships (for future social features)
// Note: This uses a self-referential relationship pattern
// A friendship has user1Id and user2Id, but a User can be either user1 OR user2
// That's why User has both friendships1 and friendships2 relations
model Friendship {
  id         String    @id @default(uuid())
  user1Id    String    @map("user1_id")
  user2Id    String    @map("user2_id")
  status     String    @default("pending") // pending, accepted, blocked
  requestedById String? @map("requested_by")
  createdAt  DateTime  @default(now()) @map("created_at")
  acceptedAt DateTime? @map("accepted_at")

  // Relations
  user1       User   @relation("User1", fields: [user1Id], references: [id], onDelete: Cascade)
  user2       User   @relation("User2", fields: [user2Id], references: [id], onDelete: Cascade)
  requestedBy User?  @relation("RequestedBy", fields: [requestedById], references: [id])

  @@unique([user1Id, user2Id])
  @@index([user1Id])
  @@index([user2Id])
  @@map("friendships")
}
```

## Database Migrations

### Create Initial Migration

```bash
# Generate Prisma Client
npx prisma generate

# Create initial migration
npx prisma migrate dev --name init

# This will:
# 1. Create migration files in prisma/migrations/
# 2. Apply the migration to your database
# 3. Generate the Prisma Client
```

### Apply Migrations in Production

```bash
# Apply pending migrations
npx prisma migrate deploy

# Generate Prisma Client
npx prisma generate
```

### Prisma Studio (Database GUI)

```bash
# Open Prisma Studio to view/edit data
npx prisma studio
```

## Implementation Examples

### Parse Play URI

```typescript
// lib/utils.ts
export function parsePlayUri(playUri: string) {
  const url = new URL(playUri);
  const pathParts = url.pathname.split('/').filter(Boolean);
  
  // Format: /@/universeSlug/worldSlug/roomSlug
  if (pathParts.length >= 4 && pathParts[0] === '@') {
    return {
      universe: pathParts[1],
      world: pathParts[2],
      room: pathParts[3],
    };
  }
  
  throw new Error('Invalid playUri format');
}
```

### Get World Members for Chat

```typescript
// app/api/chat/members/route.ts
import { prisma } from '@/lib/db';
import { parsePlayUri } from '@/lib/utils';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const playUri = searchParams.get('playUri');
  const searchText = searchParams.get('searchText') || '';
  
  const { universe, world } = parsePlayUri(playUri!);
  
  // Query world members using Prisma
  const members = await prisma.worldMember.findMany({
    where: {
      world: {
        slug: world,
        universe: {
          slug: universe
        }
      },
      user: {
        OR: searchText ? [
          { name: { contains: searchText, mode: 'insensitive' } },
          { email: { contains: searchText, mode: 'insensitive' } }
        ] : undefined
      }
    },
    include: {
      user: {
        select: {
          uuid: true,
          name: true,
          email: true,
          matrixChatId: true,
        }
      }
    }
  });
  
  return NextResponse.json({
    total: members.length,
    members: members.map(m => ({
      uuid: m.user.uuid,
      wokaName: m.user.name,
      email: m.user.email,
      chatId: m.user.matrixChatId,
      tags: m.tags || []
    }))
  });
}
```

### Check Room Access

```typescript
// Check if user can access a room
async function checkRoomAccess(
  userIdentifier: string,
  universeSlug: string,
  worldSlug: string,
  roomSlug: string
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { uuid: userIdentifier }
  });
  
  if (!user) return false;
  
  // Check if user is member of the world
  const membership = await prisma.worldMember.findFirst({
    where: {
      userId: user.id,
      world: {
        slug: worldSlug,
        universe: {
          slug: universeSlug
        }
      }
    }
  });
  
  return !!membership;
}
```

## Understanding Self-Referential Relationships

### Friendships Pattern Explained

The `friendships1` and `friendships2` relations on the `User` model might seem confusing at first. This is a common Prisma pattern for **self-referential relationships** (where a model relates to itself).

**Why two relations?**

In the `Friendship` model, we have:
- `user1Id` - One user in the friendship
- `user2Id` - The other user in the friendship

A single `User` can appear in **either position**:
- User A can be `user1` in one friendship (with User B)
- User A can be `user2` in another friendship (with User C)

**The two relations allow you to:**
- `friendships1`: Get all friendships where this user is `user1`
- `friendships2`: Get all friendships where this user is `user2`

**Example Usage:**

```typescript
// Get all friendships for a user (regardless of position)
async function getUserFriendships(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      friendships1: {
        include: { user2: true } // Get the other user
      },
      friendships2: {
        include: { user1: true } // Get the other user
      }
    }
  });
  
  // Combine both sides
  const allFriendships = [
    ...user.friendships1.map(f => ({ ...f, friend: f.user2 })),
    ...user.friendships2.map(f => ({ ...f, friend: f.user1 }))
  ];
  
  return allFriendships;
}

// Or query directly
async function getUserFriendshipsDirect(userId: string) {
  return await prisma.friendship.findMany({
    where: {
      OR: [
        { user1Id: userId },
        { user2Id: userId }
      ],
      status: 'accepted'
    },
    include: {
      user1: true,
      user2: true
    }
  });
}
```

**Alternative: Simpler Approach**

If you find this confusing, you could use a simpler approach with a junction table:

```prisma
// Alternative: Simpler friendship model
model Friendship {
  id        String   @id @default(uuid())
  userId1   String   @map("user_id_1")
  userId2   String   @map("user_id_2")
  status    String   @default("pending")
  createdAt DateTime @default(now())
  
  user1 User @relation("Friendships1", fields: [userId1], references: [id])
  user2 User @relation("Friendships2", fields: [userId2], references: [id])
  
  @@unique([userId1, userId2])
  @@index([userId1])
  @@index([userId2])
}

// Then on User model:
model User {
  // ... other fields
  friendshipsAsUser1 Friendship[] @relation("Friendships1")
  friendshipsAsUser2 Friendship[] @relation("Friendships2")
}
```

Both approaches work - the current schema uses the first pattern which is common in Prisma for bidirectional relationships.

## Discovery Features

### Universe Discovery

```typescript
// Get featured/popular universes
async function getDiscoverableUniverses(limit: number = 20) {
  return await prisma.universe.findMany({
    where: {
      isPublic: true,
      featured: true
    },
    include: {
      _count: {
        select: { worlds: true }
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: limit
  });
}
```

### World Discovery

```typescript
// Get worlds in a universe
async function getDiscoverableWorlds(universeSlug: string) {
  return await prisma.world.findMany({
    where: {
      universe: { slug: universeSlug },
      isPublic: true
    },
    include: {
      _count: {
        select: { rooms: true }
      }
    },
    orderBy: {
      createdAt: 'desc'
    }
  });
}
```

### Room Discovery

```typescript
// Get rooms in a world
async function getDiscoverableRooms(universeSlug: string, worldSlug: string) {
  return await prisma.room.findMany({
    where: {
      world: {
        slug: worldSlug,
        universe: {
          slug: universeSlug
        }
      },
      isPublic: true
    },
    orderBy: {
      createdAt: 'desc'
    }
  });
}
```

## Next Steps

1. Copy the Prisma schema to `prisma/schema.prisma`
2. Set up your database and `DATABASE_URL`
3. Run `npx prisma migrate dev --name init`
4. Generate Prisma Client: `npx prisma generate`
5. Use `prisma` from `@/lib/db` in your API routes
6. Implement membership management endpoints
7. Build discovery endpoints for universe/world/room browsing
8. Add social features (favorites, follows, friends) as needed

## Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [Prisma with Next.js](https://www.prisma.io/docs/guides/deployment/deployment-guides/deploying-to-vercel)
- [Prisma Migrate](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- [Prisma Studio](https://www.prisma.io/studio)

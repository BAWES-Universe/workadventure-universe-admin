/**
 * Database Helper
 * Utilities for database operations in integration tests
 */

import { prisma } from '@/lib/db';

/**
 * Clean database (remove all test data)
 */
export async function cleanDatabase(): Promise<void> {
  // Delete in order to respect foreign key constraints
  await prisma.ban.deleteMany();
  await prisma.favorite.deleteMany();
  await prisma.follow.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.userAvatar.deleteMany();
  await prisma.worldMember.deleteMany();
  await prisma.room.deleteMany();
  await prisma.world.deleteMany();
  await prisma.universe.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * Create test user
 */
export async function createTestUser(data: {
  uuid: string;
  email?: string;
  name?: string;
}) {
  return prisma.user.upsert({
    where: { uuid: data.uuid },
    update: data,
    create: data,
  });
}

/**
 * Create test universe
 */
export async function createTestUniverse(data: {
  slug: string;
  name: string;
  ownerId: string;
  description?: string;
  isPublic?: boolean;
}) {
  return prisma.universe.create({
    data: {
      slug: data.slug,
      name: data.name,
      ownerId: data.ownerId,
      description: data.description,
      isPublic: data.isPublic ?? true,
    },
  });
}

/**
 * Create test world
 */
export async function createTestWorld(data: {
  universeId: string;
  slug: string;
  name: string;
  mapUrl?: string;
  wamUrl?: string;
}) {
  return prisma.world.create({
    data: {
      universeId: data.universeId,
      slug: data.slug,
      name: data.name,
      mapUrl: data.mapUrl,
      wamUrl: data.wamUrl,
      isPublic: true,
    },
  });
}

/**
 * Create test room
 */
export async function createTestRoom(data: {
  worldId: string;
  slug: string;
  name: string;
  mapUrl?: string;
}) {
  return prisma.room.create({
    data: {
      worldId: data.worldId,
      slug: data.slug,
      name: data.name,
      mapUrl: data.mapUrl,
      isPublic: true,
    },
  });
}

/**
 * Seed test data
 */
export async function seedTestData() {
  const user1 = await createTestUser({
    uuid: 'test-user-1',
    email: 'test1@example.com',
    name: 'Test User 1',
  });

  const user2 = await createTestUser({
    uuid: 'test-user-2',
    email: 'test2@example.com',
    name: 'Test User 2',
  });

  const universe1 = await createTestUniverse({
    slug: 'test-universe-1',
    name: 'Test Universe 1',
    ownerId: user1.id,
  });

  const world1 = await createTestWorld({
    universeId: universe1.id,
    slug: 'test-world-1',
    name: 'Test World 1',
    mapUrl: 'https://example.com/maps/test-world-1.json',
  });

  const room1 = await createTestRoom({
    worldId: world1.id,
    slug: 'test-room-1',
    name: 'Test Room 1',
  });

  return {
    user1,
    user2,
    universe1,
    world1,
    room1,
  };
}


/**
 * Integration tests for admin interface flows
 * 
 * Tests admin interface functionality with OIDC authentication.
 * Requires WorkAdventure + OIDC mock to be running.
 */

import { setupIntegrationTests } from './setup';
import { getOidcToken } from './helpers/oidc-mock';
import { loginToAdmin } from './helpers/auth';
import { cleanDatabase, createTestUser } from './helpers/database';
import { getTestConfig } from './config';

describe('Admin Interface Flow', () => {
  beforeAll(async () => {
    await setupIntegrationTests();
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('Login and Dashboard', () => {
    it('should login and access dashboard', async () => {
      try {
        const token = await getOidcToken('User1', 'pwd');
        const loginResponse = await loginToAdmin(token);
        
        expect(loginResponse.user).toBeDefined();
        expect(loginResponse.user.id).toBeDefined();
      } catch (error) {
        if (error instanceof Error && error.message.includes('Could not get OIDC token')) {
          console.warn('Admin interface test skipped: OIDC token not available');
        } else {
          throw error;
        }
      }
    });
  });

  describe('Universe Management', () => {
    it('should create universe via admin API', async () => {
      const config = getTestConfig();
      const user = await createTestUser({
        uuid: 'admin-test-user',
        email: 'admin-test@example.com',
        name: 'Admin Test User',
      });

      const response = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'admin-test-universe',
          name: 'Admin Test Universe',
          ownerId: user.id,
          isPublic: true,
        }),
      });

      expect(response.status).toBe(201);
      const universe = await response.json();
      expect(universe.slug).toBe('admin-test-universe');
      expect(universe.ownerId).toBe(user.id);
    });

    it('should list universes', async () => {
      const config = getTestConfig();

      const response = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.universes).toBeDefined();
      expect(Array.isArray(data.universes)).toBe(true);
    });
  });

  describe('World Management', () => {
    it('should create world in universe', async () => {
      const config = getTestConfig();
      const user = await createTestUser({
        uuid: 'world-test-user',
        email: 'world-test@example.com',
        name: 'World Test User',
      });

      // Create universe first
      const universeResponse = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'world-test-universe',
          name: 'World Test Universe',
          ownerId: user.id,
          isPublic: true,
        }),
      });

      const universe = await universeResponse.json();

      // Create world
      const worldResponse = await fetch(`${config.adminApiUrl}/api/admin/worlds`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          universeId: universe.id,
          slug: 'world-test-world',
          name: 'World Test World',
          mapUrl: 'https://example.com/maps/test.json',
          isPublic: true,
        }),
      });

      expect(worldResponse.status).toBe(201);
      const world = await worldResponse.json();
      expect(world.slug).toBe('world-test-world');
      expect(world.universeId).toBe(universe.id);
    });
  });

  describe('Room Management', () => {
    it('should create room in world', async () => {
      const config = getTestConfig();
      const user = await createTestUser({
        uuid: 'room-test-user',
        email: 'room-test@example.com',
        name: 'Room Test User',
      });

      // Create universe
      const universeResponse = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'room-test-universe',
          name: 'Room Test Universe',
          ownerId: user.id,
          isPublic: true,
        }),
      });

      const universe = await universeResponse.json();

      // Create world
      const worldResponse = await fetch(`${config.adminApiUrl}/api/admin/worlds`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          universeId: universe.id,
          slug: 'room-test-world',
          name: 'Room Test World',
          isPublic: true,
        }),
      });

      const world = await worldResponse.json();

      // Create room
      const roomResponse = await fetch(`${config.adminApiUrl}/api/admin/rooms`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worldId: world.id,
          slug: 'room-test-room',
          name: 'Room Test Room',
          isPublic: true,
        }),
      });

      expect(roomResponse.status).toBe(201);
      const room = await roomResponse.json();
      expect(room.slug).toBe('room-test-room');
      expect(room.worldId).toBe(world.id);
    });
  });
});


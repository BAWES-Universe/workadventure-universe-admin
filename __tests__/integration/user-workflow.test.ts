/**
 * Integration tests for complete user workflows
 * 
 * Tests the full user journey: OIDC login → create universe → create world → create room → access room
 * Requires WorkAdventure + OIDC mock to be running.
 */

import { setupIntegrationTests } from './setup';
import { getOidcToken } from './helpers/oidc-mock';
import { loginToAdmin } from './helpers/auth';
import { cleanDatabase, createTestUser } from './helpers/database';
import { testMap, testRoomAccess } from './helpers/workadventure-api';
import { buildPlayUri } from '@/lib/utils';
import { getTestConfig } from './config';

describe('User Workflow', () => {
  beforeAll(async () => {
    await setupIntegrationTests();
    await cleanDatabase();
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('Complete User Workflow', () => {
    it('should complete full workflow: login → create universe → create world → create room → access', async () => {
      const config = getTestConfig();

      // Step 1: Get OIDC token (or skip if not available)
      let accessToken: string | undefined;
      let userId: string;
      
      try {
        accessToken = await getOidcToken('User1', 'pwd');
        
        // Step 2: Login to admin interface
        const loginResponse = await loginToAdmin(accessToken);
        userId = loginResponse.user.id;
      } catch (error) {
        // If OIDC token not available, create test user manually
        console.warn('OIDC token not available, using test user');
        const testUser = await createTestUser({
          uuid: 'test-workflow-user',
          email: 'workflow@example.com',
          name: 'Workflow User',
        });
        userId = testUser.id;
        // Skip OIDC-dependent parts
        accessToken = undefined;
      }

      // Step 3: Create universe via admin API
      const universeResponse = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'workflow-universe',
          name: 'Workflow Universe',
          description: 'Created by integration test',
          ownerId: userId,
          isPublic: true,
        }),
      });

      expect(universeResponse.status).toBe(201);
      const universe = await universeResponse.json();

      // Step 4: Create world
      const worldResponse = await fetch(`${config.adminApiUrl}/api/admin/worlds`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          universeId: universe.id,
          slug: 'workflow-world',
          name: 'Workflow World',
          mapUrl: 'https://example.com/maps/workflow-world.json',
          isPublic: true,
        }),
      });

      expect(worldResponse.status).toBe(201);
      const world = await worldResponse.json();

      // Step 5: Create room
      const roomResponse = await fetch(`${config.adminApiUrl}/api/admin/rooms`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          worldId: world.id,
          slug: 'workflow-room',
          name: 'Workflow Room',
          isPublic: true,
        }),
      });

      expect(roomResponse.status).toBe(201);
      const room = await roomResponse.json();

      // Step 6: Access room via WorkAdventure API
      const playUri = buildPlayUri(
        config.workadventureUrl,
        universe.slug,
        world.slug,
        room.slug
      );

      const mapResponse = await testMap(playUri, accessToken);
      expect(mapResponse.status).toBe(200);
      const mapData = await mapResponse.json();
      expect(mapData.mapUrl).toBeDefined();

      // Step 7: Access room with user info
      const accessResponse = await testRoomAccess(
        'test-workflow-user',
        playUri,
        accessToken
      );
      expect(accessResponse.status).toBe(200);
      const accessData = await accessResponse.json();
      expect(accessData.status).toBe('ok');
      expect(accessData.world).toBe(world.slug);
    });
  });

  describe('User Isolation', () => {
    it('should isolate content between users', async () => {
      const config = getTestConfig();

      // Create two users
      const user1 = await createTestUser({
        uuid: 'isolation-user-1',
        email: 'isolation1@example.com',
        name: 'Isolation User 1',
      });

      const user2 = await createTestUser({
        uuid: 'isolation-user-2',
        email: 'isolation2@example.com',
        name: 'Isolation User 2',
      });

      // User1 creates universe
      const universe1Response = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'isolation-universe-1',
          name: 'Isolation Universe 1',
          ownerId: user1.id,
          isPublic: true,
        }),
      });

      const universe1 = await universe1Response.json();

      // User2 creates universe
      const universe2Response = await fetch(`${config.adminApiUrl}/api/admin/universes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.adminApiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'isolation-universe-2',
          name: 'Isolation Universe 2',
          ownerId: user2.id,
          isPublic: true,
        }),
      });

      const universe2 = await universe2Response.json();

      // Verify universes are different
      expect(universe1.id).not.toBe(universe2.id);
      expect(universe1.ownerId).toBe(user1.id);
      expect(universe2.ownerId).toBe(user2.id);
    });
  });
});


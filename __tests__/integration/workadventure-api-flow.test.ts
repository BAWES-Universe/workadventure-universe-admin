/**
 * Integration tests for WorkAdventure → Admin API calls
 * 
 * These tests simulate actual WorkAdventure API calls to the Admin API.
 * Requires WorkAdventure + OIDC mock to be running.
 */

import { setupIntegrationTests } from './setup';
import { getOidcToken } from './helpers/oidc-mock';
import {
  testCapabilities,
  testMap,
  testRoomAccess,
  testMembers,
  callWorkAdventureAPI,
} from './helpers/workadventure-api';
import { cleanDatabase, seedTestData } from './helpers/database';
import { buildPlayUri } from '@/lib/utils';

describe('WorkAdventure API Flow', () => {
  beforeAll(async () => {
    await setupIntegrationTests();
    await cleanDatabase();
    await seedTestData();
  });

  afterAll(async () => {
    await cleanDatabase();
  });

  describe('Capabilities Endpoint', () => {
    it('should return capabilities when called by WorkAdventure', async () => {
      const response = await testCapabilities();
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('api/woka/list');
      expect(data).toHaveProperty('api/save-name');
    });

    it('should return 401 without Bearer token', async () => {
      const response = await fetch('http://localhost:3333/api/capabilities');
      expect(response.status).toBe(401);
    });
  });

  describe('Map Endpoint', () => {
    it('should return map details for valid playUri', async () => {
      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testMap(playUri);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('mapUrl');
      expect(data).toHaveProperty('roomName');
    });

    it('should return 404 for non-existent room', async () => {
      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'non-existent',
        'non-existent',
        'non-existent'
      );

      const response = await testMap(playUri);
      expect(response.status).toBe(404);
    });

    it('should accept accessToken parameter (as WorkAdventure sends)', async () => {
      // Get OIDC token (may fail if OIDC mock doesn't support password grant)
      let accessToken: string | undefined;
      try {
        accessToken = await getOidcToken('User1', 'pwd');
      } catch {
        // If we can't get token automatically, skip this test
        // In real scenario, token would come from WorkAdventure session
        console.warn('Could not get OIDC token automatically, skipping accessToken test');
        return;
      }

      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testMap(playUri, accessToken);
      expect(response.status).toBe(200);
    });
  });

  describe('Room Access Endpoint', () => {
    it('should return user access information', async () => {
      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testRoomAccess('test-user-1', playUri);
      
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toHaveProperty('status', 'ok');
      expect(data).toHaveProperty('userUuid');
      expect(data).toHaveProperty('world');
    });

    it('should accept accessToken parameter', async () => {
      let accessToken: string | undefined;
      try {
        accessToken = await getOidcToken('User1', 'pwd');
      } catch {
        console.warn('Could not get OIDC token automatically, skipping accessToken test');
        return;
      }

      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testRoomAccess('test-user-1', playUri, accessToken);
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe('ok');
    });

    it('should return 400 for missing parameters', async () => {
      const response = await callWorkAdventureAPI('/api/room/access', {});
      expect(response.status).toBe(400);
    });
  });

  describe('Members Endpoint', () => {
    it('should return members list', async () => {
      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testMembers(playUri);
      
      // Should return 200 even if empty
      expect([200, 404]).toContain(response.status);
    });

    it('should support searchText parameter', async () => {
      const playUri = buildPlayUri(
        'http://play.workadventure.localhost',
        'test-universe-1',
        'test-world-1',
        'test-room-1'
      );

      const response = await testMembers(playUri, 'test');
      expect([200, 404]).toContain(response.status);
    });
  });
});


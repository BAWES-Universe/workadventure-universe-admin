import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/configuration/route';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  },
}));

// Force the admin-token auth path (getSessionUser returns null)
jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(async () => null),
}));

jest.mock('@/lib/auth', () => ({
  requireAuth: jest.fn(),
}));

jest.mock('@/lib/bot-permissions', () => ({
  canManageBots: jest.fn(async () => true),
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => true),
}));

jest.mock('@/lib/oidc', () => ({
  validateAccessToken: jest.fn(async () => null),
}));

jest.mock('@/lib/bot-config-helpers', () => ({
  resolveRoomIdFromPlayUri: jest.fn(async () => 'room-123'),
  transformBotToServerFormat: jest.fn(async (bot: unknown) => bot),
}));

const validBody = {
  name: 'Test Bot',
  roomUrl: 'https://play.bawes.net/~/room/test',
  behaviorType: 'idle',
};

function configRequest(body: unknown) {
  return new NextRequest('http://localhost:3333/api/bots/configuration', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-admin-token',
    },
    body: JSON.stringify(body),
  });
}

describe('/api/bots/configuration', () => {
  beforeAll(() => {
    // Ensure the admin-token auth path is deterministic regardless of the
    // real environment's ADMIN_API_TOKEN value
    process.env.ADMIN_API_TOKEN = 'test-admin-token';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.bot.create as jest.Mock).mockResolvedValue({ id: 'bot-1', name: 'Test Bot' });
    (prisma.bot.update as jest.Mock).mockResolvedValue({ id: 'bot-1', name: 'Test Bot' });
    (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ behaviorConfig: null });
  });

  describe('legacy vision fallback fields (create)', () => {
    it('ignores legacy visionFallbackProviderRef/Model fields — vision config is provider-level now', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          visionFallbackProviderRef: 'openai',
          visionFallbackModel: 'gpt-4o',
        })
      );

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeUndefined();
      expect(data.visionFallbackModel).toBeUndefined();
    });

    it('persists nothing extra when the legacy fields are omitted', async () => {
      const response = await POST(configRequest(validBody));

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeUndefined();
      expect(data.visionFallbackModel).toBeUndefined();
    });
  });

  describe('vision fallback update semantics (update branch)', () => {
    it('does not overwrite existing values when fields are omitted', async () => {
      const response = await POST(
        configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001' })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      // undefined = Prisma "skip" — existing DB value preserved
      expect(data.visionFallbackProviderRef).toBeUndefined();
      expect(data.visionFallbackModel).toBeUndefined();
    });

    it('preserves legacy optional fields (description/chatInstructions/movementInstructions/aiProviderRef) when omitted', async () => {
      const response = await POST(
        configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001' })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.description).toBeUndefined();
      expect(data.chatInstructions).toBeUndefined();
      expect(data.movementInstructions).toBeUndefined();
      expect(data.aiProviderRef).toBeUndefined();
    });

    it('clears legacy optional fields on explicit null', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          description: null,
          aiProviderRef: null,
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.description).toBeNull();
      expect(data.aiProviderRef).toBeNull();
    });

    it('persists provided legacy field values on update', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          description: 'Updated description',
          aiProviderRef: 'openai',
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.description).toBe('Updated description');
      expect(data.aiProviderRef).toBe('openai');
    });

    it('ignores legacy vision fallback fields on update — vision config is provider-level now', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          visionFallbackProviderRef: 'openai',
          visionFallbackModel: 'gpt-4o',
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeUndefined();
      expect(data.visionFallbackModel).toBeUndefined();
    });

    it('preserves texture, enabled, and behaviorConfig when omitted from update', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          // no characterTextureIds, no enabled, no behaviorConfig in body
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.characterTextureId).toBeUndefined();
      expect(data.enabled).toBeUndefined();
      expect(data.behaviorConfig).toBeUndefined();
    });

    it('clears texture on explicit empty array and applies provided enabled/behaviorConfig', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          characterTextureIds: [],
          enabled: false,
          behaviorConfig: { assignedSpace: { center: { x: 5, y: 5 }, radius: 2 } },
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.characterTextureId).toBeNull();
      expect(data.enabled).toBe(false);
      expect(data.behaviorConfig.assignedSpace.radius).toBe(2);
    });

    it('preserves existing assignedSpace when behaviorConfig omits it', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({
        behaviorConfig: {
          assignedSpace: { center: { x: 9, y: 9 }, radius: 7 },
          walkSpeed: 2,
        },
      });
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          behaviorConfig: { walkSpeed: 3 },
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.behaviorConfig.assignedSpace.radius).toBe(7); // preserved, not reset
      expect(data.behaviorConfig.assignedSpace.center).toEqual({ x: 9, y: 9 });
      expect(data.behaviorConfig.walkSpeed).toBe(3); // updated
    });

    it('applies explicit assignedSpace over the existing value', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({
        behaviorConfig: { assignedSpace: { center: { x: 9, y: 9 }, radius: 7 } },
      });
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          behaviorConfig: { assignedSpace: { center: { x: 5, y: 5 }, radius: 2 } },
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.behaviorConfig.assignedSpace.radius).toBe(2);
      expect(data.behaviorConfig.assignedSpace.center).toEqual({ x: 5, y: 5 });
    });
  });
});

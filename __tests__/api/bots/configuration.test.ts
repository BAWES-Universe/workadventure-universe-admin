import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/configuration/route';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      create: jest.fn(),
      update: jest.fn(),
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
  });

  describe('vision fallback normalization (create)', () => {
    it('normalizes blank visionFallbackProviderRef/Model strings to null', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          visionFallbackProviderRef: '   ',
          visionFallbackModel: '',
        })
      );

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeNull();
      expect(data.visionFallbackModel).toBeNull();
    });

    it('trims and preserves non-blank values', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          visionFallbackProviderRef: '  openai  ',
          visionFallbackModel: 'gpt-4o ',
        })
      );

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBe('openai');
      expect(data.visionFallbackModel).toBe('gpt-4o');
    });

    it('persists null when the fields are omitted', async () => {
      const response = await POST(configRequest(validBody));

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeNull();
      expect(data.visionFallbackModel).toBeNull();
    });

    it('rejects non-string values for vision fallback fields', async () => {
      const response = await POST(
        configRequest({ ...validBody, visionFallbackProviderRef: 42 })
      );

      expect(response.status).toBe(400);
      expect(prisma.bot.create).not.toHaveBeenCalled();
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

    it('clears the setting on explicit null', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          visionFallbackProviderRef: null,
          visionFallbackModel: null,
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeNull();
      expect(data.visionFallbackModel).toBeNull();
    });

    it('persists provided values on update', async () => {
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
      expect(data.visionFallbackProviderRef).toBe('openai');
      expect(data.visionFallbackModel).toBe('gpt-4o');
    });

    it('normalizes blank strings to null on update too', async () => {
      const response = await POST(
        configRequest({
          ...validBody,
          botId: '00000000-0000-4000-8000-000000000001',
          visionFallbackProviderRef: '   ',
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.visionFallbackProviderRef).toBeNull();
      expect(data.visionFallbackModel).toBeUndefined();
    });
  });
});

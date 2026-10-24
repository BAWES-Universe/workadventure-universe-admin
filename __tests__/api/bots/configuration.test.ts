import { NextRequest } from 'next/server';
import { POST } from '@/app/api/bots/configuration/route';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBots, canManageThisBot } from '@/lib/bot-permissions';
import { transformBotToServerFormat } from '@/lib/bot-config-helpers';

jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    room: {
      findUnique: jest.fn(), // Hide bot conversations (#435): looked up when an update moves the bot to another room
    },
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    botsAiProvider: {
      findUnique: jest.fn(),
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

jest.mock('@/lib/bot-permissions', () => {
  const canManageBots = jest.fn(async (_userId?: string, _roomId?: string) => true);
  // canManageThisBot is canManageBots for the bot's room until the bot has rules of its own (#427)
  const canManageThisBot = jest.fn(async (userId: string, _email: string | null, bot: { roomId: string }) => canManageBots(userId, bot.roomId));
  return { canManageBots, canManageThisBot };
});

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
    (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue({ providerId: 'openai' });
  });

  describe('AI provider reference check', () => {
    it('rejects creating a bot with a provider that does not exist (400)', async () => {
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const response = await POST(configRequest({ ...validBody, aiProviderRef: 'not-a-provider' }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('AI provider "not-a-provider" does not exist');
      expect(prisma.bot.create).not.toHaveBeenCalled();
    });

    it('creates a bot whose provider exists', async () => {
      const response = await POST(configRequest({ ...validBody, aiProviderRef: 'openai' }));

      expect(response.status).toBe(201);
      expect((prisma.bot.create as jest.Mock).mock.calls[0][0].data.aiProviderRef).toBe('openai');
    });

    it('rejects switching an existing bot to a provider that does not exist (400)', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ aiProviderRef: 'openai', behaviorConfig: null });
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const response = await POST(
        configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001', aiProviderRef: 'missing' })
      );

      expect(response.status).toBe(400);
      expect(prisma.bot.update).not.toHaveBeenCalled();
    });

    it('refuses a personal AI key when no person is saving (the admin token), as if it did not exist', async () => {
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValueOnce({ providerId: 'key-abc', ownerId: 'user-a' });

      const response = await POST(configRequest({ ...validBody, aiProviderRef: 'key-abc' }));

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('AI provider "key-abc" does not exist');
      expect(prisma.bot.create).not.toHaveBeenCalled();
    });

    it('refuses a Vision pick of a key when no person is saving (the admin token), and says nothing for the others', async () => {
      const pick = { choice: 'another', keyId: 'key-abc', model: 'deepseek-v4-flash-vision-exp' };
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValueOnce({ ownerId: 'user-a' });

      const refused = await POST(configRequest({ ...validBody, behaviorConfig: { vision: pick } }));
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toBe('That key isn’t there.');
      expect(prisma.bot.create).not.toHaveBeenCalled();

      const nonsense = await POST(configRequest({ ...validBody, behaviorConfig: { vision: { choice: 'sideways' } } }));
      expect(nonsense.status).toBe(400);
      expect((await nonsense.json()).error).toBe('Pick where images go: This model, Another model or Universe AI.');

      const picked = await POST(configRequest({ ...validBody, behaviorConfig: { vision: { choice: 'this' } } }));
      expect(picked.status).toBe(201);
      const cleared = await POST(configRequest({ ...validBody, behaviorConfig: { vision: null } }));
      expect(cleared.status).toBe(201);
    });

    it('lets a save carry the Vision pick the bot already has, whoever saves it', async () => {
      const pick = { choice: 'another', keyId: 'key-abc', model: 'deepseek-v4-flash-vision-exp' };
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ aiProviderRef: null, createdById: 'maker', behaviorConfig: { vision: pick } });

      const response = await POST(configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001', behaviorConfig: { vision: pick } }));

      expect(response.status).toBe(200);
      expect(prisma.botsAiProvider.findUnique).not.toHaveBeenCalled();
    });

    it('saves an existing bot whose unchanged provider was deleted', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ aiProviderRef: 'gone', behaviorConfig: null });

      const response = await POST(
        configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001', aiProviderRef: 'gone' })
      );

      expect(response.status).toBe(200);
      expect(prisma.botsAiProvider.findUnique).not.toHaveBeenCalled();
    });

    it('forgets the bot’s model when the save moves it to another provider (#575)', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ aiProviderRef: 'key-a', behaviorConfig: null });

      const response = await POST(
        configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001', aiProviderRef: 'openai' })
      );

      expect(response.status).toBe(200);
      expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data.aiModel).toBeNull();
    });

    it('keeps the bot’s model when the save leaves its provider as it is', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({ aiProviderRef: 'openai', behaviorConfig: null });

      await POST(configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001', aiProviderRef: 'openai' }));
      await POST(configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001' }));

      for (const call of (prisma.bot.update as jest.Mock).mock.calls) expect('aiModel' in call[0].data).toBe(false);
    });
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

    it('preserves texture, enabled, and behaviorConfig values when omitted from update', async () => {
      // Existing config must survive: merge keeps stored keys (walkSpeed,
      // assignedSpace) while syncing the embedded behaviorType to the scalar.
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({
        behaviorConfig: {
          behaviorType: 'idle',
          walkSpeed: 2,
          assignedSpace: { center: { x: 9, y: 9 }, radius: 7 },
        },
      });
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
      // Omitted behaviorConfig is merged, not reset: stored keys preserved
      expect(data.behaviorConfig.walkSpeed).toBe(2);
      expect(data.behaviorConfig.assignedSpace).toEqual({ center: { x: 9, y: 9 }, radius: 7 });
      expect(data.behaviorConfig.behaviorType).toBe('idle'); // synced to scalar
    });

    it('keeps a hidden bot Private when the update moves it to a room in a universe that does not hide (#435)', async () => {
      (prisma.bot.findUnique as jest.Mock).mockImplementation(async (args: { select?: { hideConversations?: boolean } }) =>
        args.select?.hideConversations
          ? { hideConversations: null, room: { world: { universe: { hideBotConversations: true } } } }
          : { id: 'bot-1', roomId: 'room-old', createdById: null, behaviorConfig: null },
      );
      (prisma.room.findUnique as jest.Mock).mockResolvedValue({ id: 'room-123', world: { universe: { hideBotConversations: false } } });
      const response = await POST(configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001' }));

      expect(response.status).toBe(200);
      expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data).toMatchObject({ roomId: 'room-123', hideConversations: true });
    });

    it('does not touch privacy when the update leaves the bot in its room', async () => {
      (prisma.bot.findUnique as jest.Mock).mockImplementation(async () => ({ id: 'bot-1', roomId: 'room-123', createdById: null, behaviorConfig: null }));
      const response = await POST(configRequest({ ...validBody, botId: '00000000-0000-4000-8000-000000000001' }));

      expect(response.status).toBe(200);
      expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('hideConversations');
    });

    it('syncs embedded behaviorConfig.behaviorType when behaviorType changes without behaviorConfig in the body', async () => {
      // Scalar behaviorType is required, so it is always written — the JSON
      // copy must follow or GET returns a divergent behavior type.
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({
        behaviorConfig: {
          behaviorType: 'idle',
          walkSpeed: 2,
          assignedSpace: { center: { x: 9, y: 9 }, radius: 7 },
        },
      });
      const response = await POST(
        configRequest({
          ...validBody,
          behaviorType: 'patrol', // changed scalar, NO behaviorConfig in body
          botId: '00000000-0000-4000-8000-000000000001',
        })
      );

      expect(response.status).toBe(200);
      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.behaviorConfig.behaviorType).toBe('patrol'); // follows the scalar
      expect(data.behaviorConfig.walkSpeed).toBe(2); // existing keys preserved
      expect(data.behaviorConfig.assignedSpace).toEqual({ center: { x: 9, y: 9 }, radius: 7 });
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

  describe('tool timeout (Patience)', () => {
    const botId = '00000000-0000-4000-8000-000000000001';

    it('saves the tool timeout on create', async () => {
      const response = await POST(configRequest({ ...validBody, toolTimeoutSeconds: 180 }));

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.toolTimeoutSeconds).toBe(180);
    });

    it('stores null on create when no tool timeout is given, so the default applies', async () => {
      await POST(configRequest(validBody));

      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.toolTimeoutSeconds).toBeNull();
    });

    it('keeps the saved tool timeout when an update omits it', async () => {
      await POST(configRequest({ ...validBody, botId }));

      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.toolTimeoutSeconds).toBeUndefined();
    });

    it('updates and clears the tool timeout', async () => {
      await POST(configRequest({ ...validBody, botId, toolTimeoutSeconds: 15 }));
      expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data.toolTimeoutSeconds).toBe(15);

      await POST(configRequest({ ...validBody, botId, toolTimeoutSeconds: null }));
      expect((prisma.bot.update as jest.Mock).mock.calls[1][0].data.toolTimeoutSeconds).toBeNull();
    });

    it.each([0, 4, 601, 30.5, '90'])('rejects an invalid tool timeout (%p)', async (value) => {
      const response = await POST(configRequest({ ...validBody, toolTimeoutSeconds: value }));

      expect(response.status).toBe(400);
      expect(prisma.bot.create).not.toHaveBeenCalled();
    });
  });

  describe('companion', () => {
    const botId = '00000000-0000-4000-8000-000000000001';

    it('saves the companion on create', async () => {
      const response = await POST(configRequest({ ...validBody, companionTextureId: 'dog1' }));

      expect(response.status).toBe(201);
      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.companionTextureId).toBe('dog1');
    });

    it('stores null on create when no companion is given', async () => {
      await POST(configRequest(validBody));

      const data = (prisma.bot.create as jest.Mock).mock.calls[0][0].data;
      expect(data.companionTextureId).toBeNull();
    });

    it('keeps the saved companion when an update omits it', async () => {
      await POST(configRequest({ ...validBody, botId }));

      const data = (prisma.bot.update as jest.Mock).mock.calls[0][0].data;
      expect(data.companionTextureId).toBeUndefined();
    });

    it('updates and clears the companion', async () => {
      await POST(configRequest({ ...validBody, botId, companionTextureId: 'cat2' }));
      expect((prisma.bot.update as jest.Mock).mock.calls[0][0].data.companionTextureId).toBe('cat2');

      await POST(configRequest({ ...validBody, botId, companionTextureId: null }));
      expect((prisma.bot.update as jest.Mock).mock.calls[1][0].data.companionTextureId).toBeNull();
    });

    it('rejects a companion id longer than 100 characters', async () => {
      const response = await POST(configRequest({ ...validBody, companionTextureId: 'x'.repeat(101) }));

      expect(response.status).toBe(400);
      expect(prisma.bot.create).not.toHaveBeenCalled();
    });
  });

  describe('IDOR guard — cross-room bot update (session user path)', () => {
    const botId = '00000000-0000-4000-8000-000000000002';

    beforeEach(() => {
      // Force the session-user auth path (not admin token): getSessionUser
      // returns a user, so userId is set and isAdminToken is false.
      (getSessionUser as jest.Mock).mockResolvedValue({
        id: 'user-1',
        email: 'user@bawes.net',
      });
      (canManageBots as jest.Mock).mockResolvedValue(true);
    });

    it('rejects updating a bot from a room the user cannot manage (403)', async () => {
      // Destination room (room-123) is authorized; the bot actually lives in
      // room-999 which the user does NOT manage → IDOR attempt must fail.
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({ roomId: 'room-999' });
      (canManageBots as jest.Mock)
        .mockResolvedValueOnce(true) // destination room check
        .mockResolvedValueOnce(false); // existing room check

      const response = await POST(
        configRequest({ ...validBody, botId })
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toContain('permission');
      expect(prisma.bot.update).not.toHaveBeenCalled();
    });

    it('rejects when the bot does not exist (404)', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce(null);

      const response = await POST(
        configRequest({ ...validBody, botId })
      );

      expect(response.status).toBe(404);
      expect(prisma.bot.update).not.toHaveBeenCalled();
    });

    it('lets a Yes on Manage this bot update the bot in its own room without Manage bots there (CodeRabbit finding on #458)', async () => {
      (canManageBots as jest.Mock).mockResolvedValue(false);
      (canManageThisBot as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({ id: botId, createdById: 'someone', roomId: 'room-123' });

      const response = await POST(configRequest({ ...validBody, botId }));

      expect(response.status).toBe(200);
      expect(canManageBots).not.toHaveBeenCalled();
      expect(prisma.bot.update).toHaveBeenCalled();
      // the answer shows what the bot's own check says too, not the room's
      expect(transformBotToServerFormat).toHaveBeenLastCalledWith(expect.anything(), true, true);
    });

    it('still refuses that person when the bot says no, and anyone to a missing bot without Manage bots (403 before 404)', async () => {
      (canManageBots as jest.Mock).mockResolvedValue(false);
      (canManageThisBot as jest.Mock).mockResolvedValueOnce(false);
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({ id: botId, createdById: 'someone', roomId: 'room-123' });
      expect((await POST(configRequest({ ...validBody, botId }))).status).toBe(403);

      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce(null);
      expect((await POST(configRequest({ ...validBody, botId }))).status).toBe(403);
      expect(prisma.bot.update).not.toHaveBeenCalled();
    });

    it('creating a bot, or moving one to another room, still needs Manage bots in the room it lands in', async () => {
      (canManageBots as jest.Mock).mockResolvedValue(false);
      expect((await POST(configRequest(validBody))).status).toBe(403);
      expect(prisma.bot.create).not.toHaveBeenCalled();

      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({ id: botId, createdById: 'someone', roomId: 'room-999' });
      expect((await POST(configRequest({ ...validBody, botId }))).status).toBe(403);
      expect(canManageBots).toHaveBeenLastCalledWith('user-1', 'room-123');
      expect(prisma.bot.update).not.toHaveBeenCalled();
    });

    it('allows updating a bot that lives in the same authorized room', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValueOnce({ roomId: 'room-123' });

      const response = await POST(
        configRequest({ ...validBody, botId })
      );

      expect(response.status).toBe(200);
      expect(prisma.bot.update).toHaveBeenCalled();
    });
  });
});

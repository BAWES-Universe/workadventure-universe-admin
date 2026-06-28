import { NextRequest } from 'next/server';
import { GET, POST } from '@/app/api/bots/[id]/mcp-servers/route';
import { PATCH, DELETE } from '@/app/api/bots/[id]/mcp-servers/[serverId]/route';
import { prisma } from '@/lib/db';
import * as auth from '@/lib/auth';
import * as superAdmin from '@/lib/super-admin';
import * as encryption from '@/lib/encryption';

// Mock Prisma
jest.mock('@/lib/db', () => ({
  prisma: {
    bot: {
      findUnique: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    botMcpServer: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  },
}));

// Mock auth
jest.mock('@/lib/auth', () => ({
  requireAdminSession: jest.fn(),
}));

// Mock super admin
jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(),
}));

// Mock encryption
jest.mock('@/lib/encryption', () => ({
  encryptApiKey: jest.fn((key: string) => `encrypted:${key}`),
  decryptApiKey: jest.fn((key: string) => key.replace('encrypted:', '')),
}));

const MOCK_BOT_ID = 'bot-123';
const MOCK_USER_ID = 'user-456';
const MOCK_SERVER_ID = 'server-789';

describe('/api/bots/[id]/mcp-servers', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default auth: requireAdminSession returns the mock user
    (auth.requireAdminSession as jest.Mock).mockResolvedValue({ userId: MOCK_USER_ID });
    (superAdmin.isSuperAdmin as jest.Mock).mockReturnValue(false);

    // Default bot lookup: owned by MOCK_USER_ID
    (prisma.bot.findUnique as jest.Mock).mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === MOCK_BOT_ID) {
        return Promise.resolve({ id: MOCK_BOT_ID, createdById: MOCK_USER_ID });
      }
      return Promise.resolve(null);
    });

    // Default user lookup
    (prisma.user.findUnique as jest.Mock).mockResolvedValue({ id: MOCK_USER_ID, email: 'test@example.com' });
  });

  describe('GET', () => {
    it('should return list of MCP servers for a bot', async () => {
      const mockServers = [
        {
          id: 'srv-1',
          botId: MOCK_BOT_ID,
          name: 'Test Server',
          serverUrl: 'https://example.com/mcp',
          authType: 'none',
          enabled: true,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-01'),
        },
      ];

      (prisma.botMcpServer.findMany as jest.Mock).mockResolvedValue(mockServers);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`);
      const response = await GET(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('Test Server');
      expect(data[0].serverUrl).toBe('https://example.com/mcp');
      // authConfig should NOT be in response
      expect(data[0].authConfig).toBeUndefined();
    });

    it('should return 403 if user is not owner or super admin', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_BOT_ID,
        createdById: 'some-other-user',
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`);
      const response = await GET(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      expect(response.status).toBe(403);
    });

    it('should return 404 if bot not found', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`);
      const response = await GET(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      expect(response.status).toBe(404);
    });
  });

  describe('POST', () => {
    it('should create an MCP server and return 201', async () => {
      (prisma.botMcpServer.count as jest.Mock).mockResolvedValue(0);
      (prisma.botMcpServer.create as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'New Server',
        serverUrl: 'https://example.com/mcp',
        authType: 'none',
        authConfig: null,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Server',
          serverUrl: 'https://example.com/mcp',
          authType: 'none',
        }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });
      const data = await response.json();

      expect(response.status).toBe(201);
      expect(data.id).toBe(MOCK_SERVER_ID);
      expect(data.name).toBe('New Server');
    });

    it('should encrypt authConfig when creating', async () => {
      (prisma.botMcpServer.count as jest.Mock).mockResolvedValue(0);
      (prisma.botMcpServer.create as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'Server With Auth',
        serverUrl: 'https://example.com/mcp',
        authType: 'bearer',
        authConfig: 'encrypted:my-api-key',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Server With Auth',
          serverUrl: 'https://example.com/mcp',
          authType: 'bearer',
          authConfig: 'my-api-key',
        }),
      });

      await POST(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      // Verify encryption was called
      expect(encryption.encryptApiKey).toHaveBeenCalledWith('my-api-key');
      // Verify prisma create received encrypted value
      expect(prisma.botMcpServer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authConfig: 'encrypted:my-api-key',
          }),
        })
      );
    });

    it('should reject >5 servers with 422', async () => {
      (prisma.botMcpServer.count as jest.Mock).mockResolvedValue(5);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Extra Server',
          serverUrl: 'https://example.com/mcp',
          authType: 'none',
        }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });
      const data = await response.json();

      expect(response.status).toBe(422);
      expect(data.error).toContain('Maximum of 5');
    });

    it('should return 400 for invalid body (missing name)', async () => {
      (prisma.botMcpServer.count as jest.Mock).mockResolvedValue(0);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl: 'not-a-url',
          authType: 'invalid',
        }),
      });

      const response = await POST(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH', () => {
    it('should update an MCP server', async () => {
      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'Old Name',
        serverUrl: 'https://old.example.com',
        authType: 'none',
        enabled: true,
      });

      (prisma.botMcpServer.update as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'Updated Name',
        serverUrl: 'https://new.example.com',
        authType: 'bearer',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Updated Name',
          serverUrl: 'https://new.example.com',
          authType: 'bearer',
        }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.name).toBe('Updated Name');
    });

    it('should re-encrypt authConfig when it changes', async () => {
      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'Server',
        serverUrl: 'https://example.com',
        authType: 'bearer',
        enabled: true,
      });

      (prisma.botMcpServer.update as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
        name: 'Server',
        serverUrl: 'https://example.com',
        authType: 'bearer',
        authConfig: 'encrypted:new-key',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authConfig: 'new-key' }),
      });

      await PATCH(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });

      expect(encryption.encryptApiKey).toHaveBeenCalledWith('new-key');
      expect(prisma.botMcpServer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ authConfig: 'encrypted:new-key' }),
        })
      );
    });

    it('should return 404 if server not found', async () => {
      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      });

      const response = await PATCH(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });

      expect(response.status).toBe(404);
    });
  });

  describe('DELETE', () => {
    it('should delete an MCP server and return 204', async () => {
      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
      });

      (prisma.botMcpServer.delete as jest.Mock).mockResolvedValue({ id: MOCK_SERVER_ID });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });

      expect(response.status).toBe(204);
      expect(prisma.botMcpServer.delete).toHaveBeenCalledWith({
        where: { id: MOCK_SERVER_ID },
      });
    });

    it('should return 404 if server not found on delete', async () => {
      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue(null);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });

      expect(response.status).toBe(404);
    });

    it('should return 403 if user is not authorized', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_BOT_ID,
        createdById: 'some-other-user',
      });

      (prisma.botMcpServer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_SERVER_ID,
        botId: MOCK_BOT_ID,
      });

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers/${MOCK_SERVER_ID}`, {
        method: 'DELETE',
      });

      const response = await DELETE(request, {
        params: Promise.resolve({ id: MOCK_BOT_ID, serverId: MOCK_SERVER_ID }),
      });

      expect(response.status).toBe(403);
    });
  });

  describe('Authorization', () => {
    it('should allow super admin access for GET', async () => {
      (prisma.bot.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_BOT_ID,
        createdById: 'other-user',
      });
      (superAdmin.isSuperAdmin as jest.Mock).mockReturnValue(true);
      (prisma.botMcpServer.findMany as jest.Mock).mockResolvedValue([]);

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`);
      const response = await GET(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      expect(response.status).toBe(200);
    });

    it('should return 401 when not authenticated', async () => {
      (auth.requireAdminSession as jest.Mock).mockRejectedValue(new Error('Unauthorized'));

      const request = new NextRequest(`http://localhost:3333/api/bots/${MOCK_BOT_ID}/mcp-servers`);
      const response = await GET(request, { params: Promise.resolve({ id: MOCK_BOT_ID }) });

      expect(response.status).toBe(401);
    });
  });
});

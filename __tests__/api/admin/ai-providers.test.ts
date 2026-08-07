import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/admin/ai-providers/route';
import { PATCH } from '@/app/api/admin/ai-providers/[id]/route';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: {
    botsAiProvider: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

jest.mock('@/lib/auth-session', () => ({
  getSessionUser: jest.fn(async () => ({ id: 'admin-1', email: 'admin@bawes.net' })),
}));

jest.mock('@/lib/super-admin', () => ({
  isSuperAdmin: jest.fn(() => true),
}));

jest.mock('@/lib/encryption', () => ({
  encryptApiKey: jest.fn((key: string) => `enc:${key}`),
}));

const validCreateBody = {
  providerId: 'openai',
  name: 'OpenAI',
  type: 'openai',
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o',
};

function adminRequest(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('/api/admin/ai-providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST (create)', () => {
    it('accepts valid tri-state values and persists them raw', async () => {
      for (const supportsVision of [true, false, null]) {
        (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.botsAiProvider.create as jest.Mock).mockResolvedValue({ providerId: 'openai' });

        const response = await POST(
          adminRequest('http://localhost:3333/api/admin/ai-providers', {
            ...validCreateBody,
            supportsVision,
          })
        );

        expect(response.status).toBe(201);
        const lastCall = (prisma.botsAiProvider.create as jest.Mock).mock.calls.at(-1)[0];
        expect(lastCall.data.supportsVision).toBe(supportsVision);
      }
    });

    it('persists omitted supportsVision as null (auto)', async () => {
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.botsAiProvider.create as jest.Mock).mockResolvedValue({ providerId: 'openai' });

      const response = await POST(adminRequest('http://localhost:3333/api/admin/ai-providers', validCreateBody));

      expect(response.status).toBe(201);
      expect((prisma.botsAiProvider.create as jest.Mock).mock.calls[0][0].data.supportsVision).toBeNull();
    });

    it('rejects non-boolean, non-null supportsVision with 400', async () => {
      for (const bad of ['yes', 1, {}, []]) {
        const response = await POST(
          adminRequest('http://localhost:3333/api/admin/ai-providers', {
            ...validCreateBody,
            supportsVision: bad,
          })
        );

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('supportsVision');
        expect(prisma.botsAiProvider.create).not.toHaveBeenCalled();
      }
    });
  });

  describe('PATCH (update)', () => {
    beforeEach(() => {
      (prisma.botsAiProvider.findUnique as jest.Mock).mockResolvedValue({ providerId: 'openai' });
    });

    it('accepts valid tri-state values, including explicit null to reset', async () => {
      for (const supportsVision of [true, false, null]) {
        (prisma.botsAiProvider.update as jest.Mock).mockResolvedValue({ providerId: 'openai' });

        const response = await PATCH(
          adminRequest('http://localhost:3333/api/admin/ai-providers/openai', { supportsVision }),
          { params: Promise.resolve({ id: 'openai' }) }
        );

        expect(response.status).toBe(200);
        const lastCall = (prisma.botsAiProvider.update as jest.Mock).mock.calls.at(-1)[0];
        expect(lastCall.data.supportsVision).toBe(supportsVision);
      }
    });

    it('omits supportsVision from the update payload when not provided', async () => {
      (prisma.botsAiProvider.update as jest.Mock).mockResolvedValue({ providerId: 'openai' });

      const response = await PATCH(
        adminRequest('http://localhost:3333/api/admin/ai-providers/openai', { name: 'OpenAI v2' }),
        { params: Promise.resolve({ id: 'openai' }) }
      );

      expect(response.status).toBe(200);
      expect(
        (prisma.botsAiProvider.update as jest.Mock).mock.calls[0][0].data
      ).not.toHaveProperty('supportsVision');
    });

    it('rejects non-boolean, non-null supportsVision with 400', async () => {
      for (const bad of ['yes', 1, {}]) {
        const response = await PATCH(
          adminRequest('http://localhost:3333/api/admin/ai-providers/openai', { supportsVision: bad }),
          { params: Promise.resolve({ id: 'openai' }) }
        );

        expect(response.status).toBe(400);
        const data = await response.json();
        expect(data.error).toContain('supportsVision');
        expect(prisma.botsAiProvider.update).not.toHaveBeenCalled();
      }
    });
  });

  describe('GET', () => {
    it('still lists providers', async () => {
      (prisma.botsAiProvider.findMany as jest.Mock).mockResolvedValue([{ providerId: 'openai' }]);
      const response = await GET(adminRequest('http://localhost:3333/api/admin/ai-providers'));
      expect(response.status).toBe(200);
    });
  });
});

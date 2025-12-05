import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/login/route';
import { validateAccessToken } from '@/lib/oidc';
import { prisma } from '@/lib/db';

// Mock OIDC
jest.mock('@/lib/oidc', () => ({
  validateAccessToken: jest.fn(),
}));

// Mock Prisma
jest.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

describe('/api/auth/login', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should login with valid OIDC token', async () => {
    const mockUserInfo = {
      sub: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      tags: ['admin'],
    };

    const mockUser = {
      id: '1',
      uuid: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
    };

    (validateAccessToken as jest.Mock).mockResolvedValue(mockUserInfo);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(mockUser);
    (prisma.user.update as jest.Mock).mockResolvedValue(mockUser);

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: 'valid-token',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user).toBeDefined();
    expect(data.user.email).toBe('test@example.com');
    expect(response.cookies.get('user_session')).toBeDefined();
  });

  it('should create new user if not exists', async () => {
    const mockUserInfo = {
      sub: 'new-user-123',
      email: 'new@example.com',
      name: 'New User',
      tags: [],
    };

    const mockUser = {
      id: '2',
      uuid: 'new-user-123',
      email: 'new@example.com',
      name: 'New User',
    };

    (validateAccessToken as jest.Mock).mockResolvedValue(mockUserInfo);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue(mockUser);

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: 'valid-token',
      }),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(prisma.user.create).toHaveBeenCalled();
  });

  it('should return 401 with invalid token', async () => {
    (validateAccessToken as jest.Mock).mockResolvedValue(null);

    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accessToken: 'invalid-token',
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toContain('Invalid access token');
  });

  it('should return 400 without access token', async () => {
    const request = new NextRequest('http://localhost:3000/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain('Access token required');
  });
});


/**
 * GET /api/admin/github-app: whether Universe's GitHub App is made, for the "GitHub for Universe" row on Orbit home. Super admins only,
 * and nothing secret in the answer.
 */
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isSuperAdmin?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
const mockApp: { current: Record<string, unknown> | null } = { current: null };
jest.mock('@/lib/github/app', () => ({ getGitHubApp: jest.fn(async () => mockApp.current) }));

import { GET } from '@/app/api/admin/github-app/route';

const ask = () => GET(new NextRequest('https://orbit.example.com/api/admin/github-app'));

beforeEach(() => {
  mockUser.current = null;
  mockApp.current = null;
});

describe('GET /api/admin/github-app', () => {
  it('turns away someone who is not signed in, and anyone who is not a super admin', async () => {
    expect((await ask()).status).toBe(401);
    mockUser.current = { id: 'u1', isSuperAdmin: false };
    expect((await ask()).status).toBe(403);
  });

  it('says not made while there is no app', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    const response = await ask();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ made: false });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('says made, with where it is on GitHub, and never the secrets', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    mockApp.current = { appId: 1, slug: 'bawes-universe', clientId: 'c', clientSecret: 'shh', webhookSecret: 'shh2', pem: 'PEM', htmlUrl: 'https://github.com/apps/bawes-universe' };
    const body = await (await ask()).json();
    expect(body).toEqual({ made: true, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' });
  });
});

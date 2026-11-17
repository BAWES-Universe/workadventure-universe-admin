/**
 * GET /api/admin/github-app: whether Universe's GitHub App is made, for the "GitHub for Universe" row on Orbit home. Super admins only,
 * and nothing secret in the answer.
 */
import { NextRequest } from 'next/server';

const mockUser: { current: { id: string; isSuperAdmin?: boolean } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
const mockApp: { current: Record<string, unknown> | null } = { current: null };
const mockKept: { current: number | null | Error } = { current: null };
/** This server's copy of the app (up to a minute old): what getGitHubApp answers until it is told to forget it */
const mockCopy: { current: Record<string, unknown> | null | 'fresh' } = { current: 'fresh' };
jest.mock('@/lib/github/app', () => ({
  getGitHubApp: jest.fn(async () => (mockCopy.current === 'fresh' ? mockApp.current : mockCopy.current)),
  forgetGitHubApp: jest.fn(() => {
    mockCopy.current = 'fresh';
  }),
  keptGitHubAppId: jest.fn(async () => {
    if (mockKept.current instanceof Error) throw mockKept.current;
    return mockKept.current;
  }),
}));

import { GET } from '@/app/api/admin/github-app/route';

const ask = () => GET(new NextRequest('https://orbit.example.com/api/admin/github-app'));

beforeEach(() => {
  mockUser.current = null;
  mockApp.current = null;
  mockKept.current = null;
  mockCopy.current = 'fresh';
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
    mockKept.current = 1;
    mockApp.current = { appId: 1, slug: 'bawes-universe', clientId: 'c', clientSecret: 'shh', webhookSecret: 'shh2', pem: 'PEM', htmlUrl: 'https://github.com/apps/bawes-universe' };
    const body = await (await ask()).json();
    expect(body).toEqual({ made: true, appId: 1, slug: 'bawes-universe', url: 'https://github.com/apps/bawes-universe' });
  });

  it('says made even when the app cannot be read back, without its address', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    mockKept.current = 1;
    expect(await (await ask()).json()).toEqual({ made: true, appId: 1 });
  });

  it('never says not made when the store cannot be read: it answers 500, so the row stays away', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    mockKept.current = new Error('database is down');
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await ask();
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('made');
    error.mockRestore();
  });

  it('never puts another app\'s address next to this app\'s number when this server\'s copy is out of date', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    // Another server just replaced app 1 with app 2: this one still holds app 1 until it is told to read again
    mockKept.current = 2;
    mockCopy.current = { appId: 1, slug: 'old-app', htmlUrl: 'https://github.com/apps/old-app' };
    mockApp.current = { appId: 2, slug: 'new-app', htmlUrl: 'https://github.com/apps/new-app' };
    expect(await (await ask()).json()).toEqual({ made: true, appId: 2, slug: 'new-app', url: 'https://github.com/apps/new-app' });
  });

  it('leaves the address out rather than show a wrong one when the app kept cannot be read back as that number', async () => {
    mockUser.current = { id: 'u1', isSuperAdmin: true };
    mockKept.current = 2;
    mockApp.current = { appId: 1, slug: 'old-app', htmlUrl: 'https://github.com/apps/old-app' };
    expect(await (await ask()).json()).toEqual({ made: true, appId: 2 });
  });
});

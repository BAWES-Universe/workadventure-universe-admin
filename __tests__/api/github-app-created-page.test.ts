/**
 * GET /api/admin/github-app/created: where GitHub sends the super admin after Create. It now opens in a window of its own, so the
 * page can close itself, and always says the way back to the game.
 */
import { NextRequest } from 'next/server';

const mockState = { asker: { email: 'sara@example.test' } as { email: string } | null, kept: null as number | null };
jest.mock('@/lib/db', () => ({ prisma: { user: { findUnique: jest.fn(async () => mockState.asker) } } }));
jest.mock('@/lib/encryption', () => ({ decryptApiKey: jest.fn((value: string) => value), encryptApiKey: jest.fn((value: string) => value) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email: string) => email === 'sara@example.test') }));
jest.mock('@/lib/github/api', () => ({
  gitHubRequest: jest.fn(async () => ({ ok: true, status: 201, data: { id: 9, slug: 'bawes-universe', client_id: 'c', client_secret: 's', pem: 'PEM', html_url: 'https://github.com/apps/bawes-universe' } })),
}));
jest.mock('@/lib/github/app', () => ({
  keptGitHubAppId: jest.fn(async () => mockState.kept),
  saveGitHubApp: jest.fn(async (conversion: { id: number; slug: string }) => ({ appId: conversion.id, slug: conversion.slug })),
}));

import { GET } from '@/app/api/admin/github-app/created/route';

const state = (extra: object = {}) => JSON.stringify({ kind: 'github-app-create', userId: 'u1', replaces: null, exp: Math.floor(Date.now() / 1000) + 600, ...extra });
const back = (query: string) => GET(new NextRequest(`https://orbit.example.com/api/admin/github-app/created?${query}`));
const before = process.env.CORS_ALLOWED_ORIGINS;

beforeEach(() => {
  mockState.asker = { email: 'sara@example.test' };
  mockState.kept = null;
  process.env.CORS_ALLOWED_ORIGINS = 'https://play.example.com,https://other.example.com';
});
afterAll(() => {
  if (before === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = before;
});

describe('GitHub App created page', () => {
  it('says it is set up, can close its window, and goes back to the game', async () => {
    const response = await back(`code=abc&state=${encodeURIComponent(state())}`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('GitHub is set up');
    expect(html).toContain('Orbit shows it as set up. You can close this window.');
    expect(html).toContain('onclick="window.close()">Close this window</button>');
    expect(html).toContain('<a href="https://play.example.com">Back to Universe</a>');
  });

  it('still says the way back when the setup ran out, and never links anywhere it was not given', async () => {
    const response = await back(`code=abc&state=${encodeURIComponent(state({ exp: 1 }))}`);
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain('This setup ran out');
    expect(html).toContain('Back to Universe');
    process.env.CORS_ALLOWED_ORIGINS = 'not an address';
    expect(await (await back(`code=abc&state=${encodeURIComponent(state({ exp: 1 }))}`)).text()).not.toContain('Back to Universe');
  });

  it('keeps the other app when another setup finished first, and says the window can close', async () => {
    mockState.kept = 5;
    const response = await back(`code=abc&state=${encodeURIComponent(state())}`);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Close this window');
  });
});

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/map/route';
import { prisma } from '@/lib/db';
import { safeWamExists, createWamFile } from '@/lib/map-storage';

jest.mock('@/lib/db', () => ({
  prisma: { room: { findFirst: jest.fn(), update: jest.fn() } },
}));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/map-storage', () => ({
  safeWamExists: jest.fn(async () => true),
  createWamFile: jest.fn(),
  getWamUrl: jest.fn(() => 'https://maps.example.test/secret-universe/secret-world/secret-room/map.wam'),
  getWamPath: jest.fn(() => 'secret-universe/secret-world/secret-room/map.wam'),
}));

const PLAY_URI = 'https://play.example.test/@/secret-universe/secret-world/secret-room';

function room(overrides: { room?: boolean; world?: boolean; universe?: boolean; owner?: { name: string | null; email: string } }) {
  return {
    id: 'room-1',
    slug: 'secret-room',
    name: 'Secret Room',
    mapUrl: 'https://maps.example.test/secret-map.tmj',
    wamUrl: null,
    isPublic: overrides.room ?? true,
    authenticationMandatory: false,
    world: {
      slug: 'secret-world',
      name: 'Secret World',
      isPublic: overrides.world ?? true,
      universe: {
        slug: 'secret-universe',
        name: 'Secret Universe',
        isPublic: overrides.universe ?? true,
        owner: overrides.owner ?? { name: 'Olivia Owner', email: 'olivia@example.test' },
      },
    },
  };
}

function call(accessToken?: string) {
  const url = new URL('http://localhost:3333/api/map');
  url.searchParams.set('playUri', PLAY_URI);
  if (accessToken) url.searchParams.set('accessToken', accessToken);
  return GET(new NextRequest(url));
}

const SECRETS = ['Secret Room', 'Secret World', 'Secret Universe', 'secret-map', 'secret-room', 'secret-world', 'secret-universe', 'Olivia', 'olivia@example.test', 'map.wam'];

describe('map details of members-only rooms', () => {
  beforeAll(() => {
    process.env.PUBLIC_MAP_STORAGE_URL = 'https://maps.example.test';
    process.env.MAP_STORAGE_API_TOKEN = 'storage-token';
    process.env.PLAY_URL = 'https://play.example.test';
    process.env.BASE_START_MAP_URL = 'https://start.example.test/office.tmj';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (safeWamExists as jest.Mock).mockResolvedValue(true);
  });

  describe.each([
    ['a private room', { room: false }],
    ['a private world', { world: false }],
    ['a private universe', { universe: false }],
  ])('%s', (_name, layers) => {
    beforeEach(() => {
      (prisma.room.findFirst as jest.Mock).mockResolvedValue(room(layers));
    });

    it('tells someone who has not signed in only to sign in: no names, owner or addresses', async () => {
      const res = await call();
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.authenticationMandatory).toBe(true);
      const text = JSON.stringify(json);
      SECRETS.forEach((secret) => expect(text).not.toContain(secret));
      expect(json.wamUrl).toBeUndefined();
      expect(json.roomName).toBeUndefined();
    });

    it('does not look up, create or write a map file for someone who has not signed in', async () => {
      await call();
      expect(safeWamExists).not.toHaveBeenCalled();
      expect(createWamFile).not.toHaveBeenCalled();
      expect(prisma.room.update).not.toHaveBeenCalled();
    });

    it('gives the full details to somebody who has signed in, so Orbit can then decide whether they may enter', async () => {
      const res = await call('oidc-token');
      const json = await res.json();
      expect(json.wamUrl).toBe('https://maps.example.test/secret-universe/secret-world/secret-room/map.wam');
      expect(json.roomName).toBe('Secret Room');
      expect(json.authenticationMandatory).toBe(true);
      expect(json.metatags.title).toContain('Secret World');
    });
  });

  it('keeps showing a public room to everyone, signed in or not', async () => {
    (prisma.room.findFirst as jest.Mock).mockResolvedValue(room({}));
    const json = await (await call()).json();
    expect(json.roomName).toBe('Secret Room');
    expect(json.authenticationMandatory).toBe(false);
    expect(json.wamUrl).toContain('map.wam');
  });

  it('never publishes the owner\'s email, even when the owner has no name', async () => {
    (prisma.room.findFirst as jest.Mock).mockResolvedValue(room({ owner: { name: null, email: 'olivia@example.test' } }));
    const json = await (await call()).json();
    expect(JSON.stringify(json)).not.toContain('olivia@example.test');
    expect(json.metatags.author).toBe('Universe');
  });
});

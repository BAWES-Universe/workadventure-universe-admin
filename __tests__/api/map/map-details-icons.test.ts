import fs from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/map/route';
import { prisma } from '@/lib/db';

jest.mock('@/lib/db', () => ({
  prisma: { room: { findFirst: jest.fn(), update: jest.fn() } },
}));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn() }));
jest.mock('@/lib/oidc', () => ({ validateAccessToken: jest.fn(async () => null) }));
jest.mock('@/lib/map-storage', () => ({
  safeWamExists: jest.fn(async () => true),
  createWamFile: jest.fn(),
  getWamUrl: jest.fn(() => 'https://maps.example.test/universe/world/room/map.wam'),
  getWamPath: jest.fn(() => 'universe/world/room/map.wam'),
}));

const PLAY_URI = 'https://play.example.test/@/universe/world/room';
const ASSETS = path.join(__dirname, '../../../public/assets');

// Width and height live at a fixed place in a PNG file, so the sizes the manifest promises can be checked
function pngSize(file: string) {
  const header = fs.readFileSync(file);
  return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
}

describe('app icons in the map details', () => {
  beforeAll(() => {
    process.env.PUBLIC_MAP_STORAGE_URL = 'https://maps.example.test';
    process.env.MAP_STORAGE_API_TOKEN = 'storage-token';
    process.env.PLAY_URL = 'https://play.example.test';
    process.env.BASE_START_MAP_URL = 'https://start.example.test/office.tmj';
  });

  async function metatags() {
    (prisma.room.findFirst as jest.Mock).mockResolvedValue({
      id: 'room-1',
      slug: 'room',
      name: 'Room',
      mapUrl: 'https://maps.example.test/map.tmj',
      wamUrl: null,
      isPublic: true,
      authenticationMandatory: false,
      world: {
        slug: 'world',
        name: 'World',
        isPublic: true,
        universe: { slug: 'universe', name: 'Universe', isPublic: true, owner: { name: 'Owner', email: 'o@example.test' } },
      },
    });
    const url = new URL('http://localhost:3333/api/map');
    url.searchParams.set('playUri', PLAY_URI);
    const res = await GET(new NextRequest(url));
    return (await res.json()).metatags;
  }

  it('sends the four install icons, each file present and exactly the size it says', async () => {
    const { manifestIcons } = await metatags();
    expect(manifestIcons.map((i: { sizes: string; purpose: string }) => `${i.purpose} ${i.sizes}`)).toEqual([
      'any 192x192',
      'any 512x512',
      'maskable 192x192',
      'maskable 512x512',
    ]);
    for (const icon of manifestIcons) {
      const file = path.join(ASSETS, path.basename(icon.src));
      expect(pngSize(file)).toBe(icon.sizes);
    }
  });

  it('sends an iPhone icon that exists and is 180x180', async () => {
    const { favIcons } = await metatags();
    const apple = favIcons.find((i: { rel: string }) => i.rel === 'apple-touch-icon');
    expect(pngSize(path.join(ASSETS, path.basename(apple.src)))).toBe('180x180');
  });
});

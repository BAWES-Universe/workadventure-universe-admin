/**
 * A guest who signs in joins their account in Visitors (#630): the game sends the guest id the device used before once,
 * right after sign-in, and the visits saved under it that belong to no account move onto the account. Only that id,
 * only for an account whose token Orbit verified, and a failure never stops anyone getting in.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => {
  const prisma: Record<string, unknown> = {
    user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    world: { findFirst: jest.fn() },
    room: { findFirst: jest.fn() },
    ban: { findFirst: jest.fn().mockResolvedValue(null) },
    worldMember: { findUnique: jest.fn().mockResolvedValue(null) },
    userAvatar: { findUnique: jest.fn().mockResolvedValue(null) },
    visitCard: { findUnique: jest.fn().mockResolvedValue(null) },
    bot: { findFirst: jest.fn().mockResolvedValue(null) },
    roomAccess: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn(), updateMany: jest.fn() },
    roomAccessRelink: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn((callback: (tx: unknown) => unknown) => callback(prisma));
  return { prisma };
});
jest.mock('@/lib/oidc', () => ({ authenticateRequest: jest.fn() }));
jest.mock('@/lib/user-outfits', () => ({ currentOutfit: jest.fn().mockResolvedValue(null), recordOutfitPick: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/discord', () => ({ notifyRoomAccess: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/avatar-catalog-validator', () => ({
  resolveTextureUrls: jest.fn().mockResolvedValue({ valid: true, textures: [] }),
  resolveCompanionTexture: jest.fn().mockResolvedValue({ valid: true, texture: null }),
}));
jest.mock('@sentry/nextjs', () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { authenticateRequest } from '@/lib/oidc';
import { GET as roomAccess } from '@/app/api/room/access/route';
import { isLinkableGuestId } from '@/lib/guest-sign-in-link';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const GUEST = '5b522f38-d7d2-4e37-be94-2476cb1efdfe';
const ACCOUNT = { id: 'u1', uuid: 'elj-uuid', email: 'elj@example.test', name: 'el-j', isGuest: false, matrixChatId: null };
const SIGNED_IN = { isAuthenticated: true, identifier: 'elj-uuid', email: 'elj@example.test', name: 'el-j' };
const OLD_VISITS = [
  { id: 'v1', userUuid: GUEST, userId: null, userName: 'el-j', userEmail: null, isGuest: true },
  { id: 'v2', userUuid: GUEST, userId: null, userName: null, userEmail: null, isGuest: true },
];

async function enter(extra = '', identifier = 'elj-uuid') {
  const url = `http://localhost/api/room/access?userIdentifier=${identifier}&accessToken=token${extra}&playUri=${encodeURIComponent('http://play.test/@/uni/world/room')}`;
  const request = new NextRequest(url, { headers: { Authorization: process.env.ADMIN_API_TOKEN as string } });
  return (await roomAccess(request)).json();
}

beforeAll(() => {
  process.env.ADMIN_API_TOKEN = 'test-token';
});
beforeEach(() => {
  jest.clearAllMocks();
  (authenticateRequest as jest.Mock).mockResolvedValue(SIGNED_IN);
  db.world.findFirst.mockResolvedValue({ id: 'w', universeId: 'un', isPublic: true, universe: { id: 'un', slug: 'uni', isPublic: true, ownerId: 'owner' } });
  db.room.findFirst.mockResolvedValue({ id: 'r', isPublic: true });
  db.user.findFirst.mockResolvedValue(ACCOUNT);
  db.user.update.mockImplementation(({ data }) => Promise.resolve({ ...ACCOUNT, ...data }));
  db.user.findUnique.mockResolvedValue(null);
  db.roomAccess.findMany.mockResolvedValue(OLD_VISITS);
  db.roomAccess.updateMany.mockResolvedValue({ count: 1 });
});

describe('GET /api/room/access, a guest signing in (#630)', () => {
  it('moves the visits made under the guest id onto the account, logged so they can be undone, still marked not signed in', async () => {
    const body = await enter(`&previousGuestUuid=${GUEST}`);
    expect(body.status).toBe('ok');
    expect(db.roomAccess.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userUuid: GUEST, userId: null } }));
    expect(db.roomAccessRelink.create.mock.calls).toEqual([
      [{ data: { roomAccessId: 'v1', userId: 'u1', oldUserUuid: GUEST, oldUserId: null, oldUserName: 'el-j', oldUserEmail: null, oldIsGuest: true } }],
      [{ data: { roomAccessId: 'v2', userId: 'u1', oldUserUuid: GUEST, oldUserId: null, oldUserName: null, oldUserEmail: null, oldIsGuest: true } }],
    ]);
    const claim = (id: string) => ({
      where: { id, userId: null },
      data: { userId: 'u1', userUuid: 'elj-uuid', isGuest: false, userName: 'el-j', userEmail: 'elj@example.test' },
    });
    expect(db.roomAccess.updateMany.mock.calls).toEqual([[claim('v1')], [claim('v2')]]);
    // Nothing is marked signed in, so Visitors lists them as Guest inside the card
    expect(JSON.stringify(db.roomAccess.updateMany.mock.calls)).not.toContain('isAuthenticated');
  });

  it('moves nothing when the guest id has no visits left without an account (a second account sending the same id)', async () => {
    db.roomAccess.findMany.mockResolvedValue([]);
    const body = await enter(`&previousGuestUuid=${GUEST}`);
    expect(body.status).toBe('ok');
    expect(db.roomAccessRelink.create).not.toHaveBeenCalled();
    expect(db.roomAccess.updateMany).not.toHaveBeenCalled();
  });

  it('logs only the visits this sign-in moved when another sign-in with the same guest id got some of them first', async () => {
    db.roomAccess.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    await enter(`&previousGuestUuid=${GUEST}`);
    expect(db.roomAccessRelink.create).toHaveBeenCalledTimes(1);
    expect(db.roomAccessRelink.create).toHaveBeenCalledWith({ data: expect.objectContaining({ roomAccessId: 'v2' }) });
  });

  it("never hands over an id that is some account's own", async () => {
    db.user.findUnique.mockResolvedValue({ id: 'someone-else' });
    await enter(`&previousGuestUuid=${GUEST}`);
    expect(db.roomAccess.updateMany).not.toHaveBeenCalled();
  });

  it('does nothing without the id, as every visit did before', async () => {
    await enter();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('does nothing when the sign-in could not be verified: whoever sent it is a guest, not that account (#408)', async () => {
    (authenticateRequest as jest.Mock).mockResolvedValue({ isAuthenticated: false });
    const body = await enter(`&previousGuestUuid=${GUEST}`);
    expect(body.status).toBe('ok');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('still lets the person in when the move fails, and tells Sentry', async () => {
    db.roomAccess.findMany.mockRejectedValue(new Error('db down'));
    const body = await enter(`&previousGuestUuid=${GUEST}`);
    expect(body.status).toBe('ok');
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe('isLinkableGuestId', () => {
  it('is only a uuid, and never the account’s own', () => {
    expect(isLinkableGuestId(GUEST, 'elj-uuid')).toBe(true);
    expect(isLinkableGuestId(GUEST.toUpperCase(), 'elj-uuid')).toBe(true);
    expect(isLinkableGuestId(GUEST, GUEST)).toBe(false);
    for (const bad of [null, undefined, '', 'a@b.co', `unverified-${'a'.repeat(32)}`, 'bot-123', 'elj-uuid', `${GUEST}x`]) expect(isLinkableGuestId(bad, 'elj-uuid')).toBe(false);
  });
});

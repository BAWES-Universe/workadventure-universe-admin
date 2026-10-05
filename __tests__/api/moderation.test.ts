/**
 * Reports and bans are self-moderated: a world's admins and its universe's owner handle them, a ban covers one world
 * for as long as they pick, and a banned player gets one appeal.
 *
 * Prisma is mocked; each test sets the rows the database would return.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/db', () => ({
  prisma: {
    $transaction: jest.fn(),
    user: { findFirst: jest.fn() },
    world: { findFirst: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
    room: { findFirst: jest.fn() },
    worldMember: { findFirst: jest.fn() },
    report: { create: jest.fn(), count: jest.fn(), updateMany: jest.fn() },
    ban: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/auth', () => ({ requireAuth: jest.fn(), getClientIp: () => '127.0.0.1' }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { banEndsAt, bansCoveringWorld, parseWorldAddress } from '@/lib/moderation';
import { POST as banFromGame } from '@/app/api/ban/route';
import { POST as report } from '@/app/api/report/route';
import { POST as appeal } from '@/app/api/ban/appeal/route';
import { POST as act } from '@/app/api/admin/worlds/[id]/safety/route';

type Mocked = Record<string, Record<string, jest.Mock>> & { $transaction: jest.Mock };
const db = prisma as unknown as Mocked;
const session = getSessionUser as jest.Mock;

const office = { id: 'w-office', name: 'Office', universeId: 'u-bawes' };
const admin = { id: 'u-mishari', uuid: 'uuid-mishari', email: null, name: 'Mishari', tags: [], isSuperAdmin: false };
const sam = { id: 'u-sam', uuid: 'uuid-sam' };

const json = (url: string, body: unknown) =>
  new NextRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const safety = (body: unknown) => act(json(`http://orbit.test/api/admin/worlds/${office.id}/safety`, body), { params: Promise.resolve({ id: office.id }) });

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env.PLAY_URL;
  db.$transaction.mockImplementation(async (operations: unknown[]) => Promise.all(operations));
});

describe('ban length and reach', () => {
  it('ends a day or a week from now, or never', () => {
    const now = new Date('2026-10-04T10:00:00Z');
    expect(banEndsAt('1d', now)?.toISOString()).toBe('2026-10-05T10:00:00.000Z');
    expect(banEndsAt('7d', now)?.toISOString()).toBe('2026-10-11T10:00:00.000Z');
    expect(banEndsAt('forever', now)).toBeNull();
  });

  it('counts a universe ban only when it names no world, so one world’s ban never closes its neighbours', () => {
    const where = bansCoveringWorld(office);
    const reach = (where.AND as { OR: unknown[] }[])[0].OR;
    expect(reach).toEqual([
      { worldId: office.id },
      { worldId: null, universeId: office.universeId },
      { worldId: null, universeId: null },
    ]);
  });
});

describe('a play address', () => {
  it('names its world as the database has it, even when the slugs are percent-encoded', () => {
    expect(parseWorldAddress('https://play.test/@/bawes/caf%C3%A9/lobby')).toEqual({ universe: 'bawes', world: 'café', room: 'lobby' });
    expect(parseWorldAddress('https://play.test/@/bawes/café/lobby')).toEqual({ universe: 'bawes', world: 'café', room: 'lobby' });
  });

  it('names no world when it is malformed', () => {
    expect(parseWorldAddress('https://play.test/@/bawes/%E0%A4%A/lobby')).toBeNull();
    expect(parseWorldAddress('https://play.test/rooms/lobby')).toBeNull();
  });
});

describe('a ban made in the game', () => {
  const request = (playUri: string) =>
    json('http://orbit.test/api/ban', { uuidToBan: 'uuid-sam', playUri, message: 'User banned by admin uuid-mishari', byUserUuid: 'uuid-mishari' });

  it('covers that world only, and keeps the admin’s id out of the reason the player sees', async () => {
    db.user.findFirst.mockResolvedValueOnce(sam).mockResolvedValueOnce({ id: admin.id });
    db.world.findFirst.mockResolvedValue(office);

    const response = await banFromGame(request('http://play.test/@/bawes/office/lobby'));

    expect(response.status).toBe(200);
    const data = db.ban.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: sam.id, worldId: office.id, reason: null });
    expect(data).not.toHaveProperty('universeId');
  });

  it('refuses an address that is not a room with a 400', async () => {
    const response = await banFromGame(request('http://play.test/@/bawes/%E0%A4%A/lobby'));

    expect(response.status).toBe(400);
    expect(db.ban.create).not.toHaveBeenCalled();
  });

  it('bans nobody when the world is unknown, rather than everywhere', async () => {
    db.user.findFirst.mockResolvedValue(sam);
    db.world.findFirst.mockResolvedValue(null);

    const response = await banFromGame(request('http://play.test/@/bawes/gone/lobby'));

    expect(response.status).toBe(404);
    expect(db.ban.create).not.toHaveBeenCalled();
  });
});

describe('a report from the game', () => {
  const request = (comment: string) =>
    json('http://orbit.test/api/report', {
      reportedUserUuid: 'uuid-sam',
      reportedUserComment: comment,
      reporterUserUuid: 'uuid-lina',
      reportWorldSlug: 'http://play.test/@/bawes/office/lobby',
    });

  it('is saved for the world’s admins, with the room it came from', async () => {
    db.world.findFirst.mockResolvedValue({ id: office.id });
    db.report.count.mockResolvedValue(0);
    db.user.findFirst.mockResolvedValueOnce(sam).mockResolvedValueOnce({ id: 'u-lina' });
    db.room.findFirst.mockResolvedValue({ id: 'r-lobby' });

    const response = await report(request('  Spamming links  '));

    expect(response.status).toBe(200);
    expect(db.report.create.mock.calls[0][0].data).toMatchObject({
      worldId: office.id,
      roomId: 'r-lobby',
      reportedUserId: sam.id,
      reporterUserId: 'u-lina',
      comment: 'Spamming links',
    });
  });

  it('needs the world it came from', async () => {
    const response = await report(
      json('http://orbit.test/api/report', { reportedUserUuid: 'uuid-sam', reporterUserUuid: 'uuid-lina', reportWorldSlug: '' }),
    );

    expect(response.status).toBe(400);
    expect(db.report.create).not.toHaveBeenCalled();
  });

  it('is dropped quietly once a player has sent too many in an hour', async () => {
    db.world.findFirst.mockResolvedValue({ id: office.id });
    db.report.count.mockResolvedValue(20);

    const response = await report(request('again'));

    expect(response.status).toBe(200);
    expect(db.report.create).not.toHaveBeenCalled();
  });
});

describe('an appeal', () => {
  const request = () => json('http://orbit.test/api/ban/appeal', { userIdentifier: 'uuid-sam', playUri: 'http://play.test/@/bawes/office/lobby', text: ' Sorry ' });
  const banned = (ban: Record<string, unknown> | null) => {
    db.world.findFirst.mockResolvedValue(office);
    db.user.findFirst.mockResolvedValue(sam);
    db.ban.findFirst.mockResolvedValue(ban);
  };

  it('is saved once', async () => {
    banned({ id: 'b-1', worldId: office.id });
    db.ban.updateMany.mockResolvedValue({ count: 1 });

    const response = await appeal(request());

    expect(response.status).toBe(200);
    expect(db.ban.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'b-1', appealedAt: null }, data: { appealText: 'Sorry' } });
  });

  it('is refused the second time', async () => {
    banned({ id: 'b-1', worldId: office.id });
    db.ban.updateMany.mockResolvedValue({ count: 0 });

    expect((await appeal(request())).status).toBe(409);
  });

  it('needs a ban from that world', async () => {
    banned(null);
    expect((await appeal(request())).status).toBe(404);
  });
});

describe('the Safety tab’s actions', () => {
  it('are refused to someone who doesn’t run the world', async () => {
    session.mockResolvedValue({ ...admin, id: 'u-visitor' });
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue(null);

    const response = await safety({ action: 'dismiss', person: sam.id });

    expect(response.status).toBe(403);
    expect(db.report.updateMany).not.toHaveBeenCalled();
  });

  it('ban a reported player from the world for the chosen time and mark their reports done', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.user.findFirst.mockResolvedValue(sam);
    db.world.findFirst.mockResolvedValue(null);

    const before = Date.now();
    const response = await safety({ action: 'ban', person: sam.id, duration: '7d', reason: 'Spamming links in Lobby' });

    expect(response.status).toBe(200);
    const data = db.ban.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: sam.id, worldId: office.id, reason: 'Spamming links in Lobby', bannedById: admin.id });
    expect(data.expiresAt.getTime() - before).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
    expect(db.report.updateMany.mock.calls[0][0]).toMatchObject({
      where: { worldId: office.id, status: 'open', OR: [{ reportedUserId: sam.id }, { reportedUserId: null, reportedUuid: sam.uuid }] },
      data: { status: 'banned', handledById: admin.id },
    });
  });

  it('close the reports a banned player had before Orbit knew them, and those since', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.user.findFirst.mockResolvedValue(sam);
    db.world.findFirst.mockResolvedValue(null);

    const response = await safety({ action: 'ban', person: `uuid:${sam.uuid}`, duration: '1d' });

    expect(response.status).toBe(200);
    expect(db.report.updateMany.mock.calls[0][0].where.OR).toEqual([
      { reportedUserId: sam.id },
      { reportedUserId: null, reportedUuid: sam.uuid },
    ]);
  });

  it('dismiss every open report about a player, from before Orbit knew them and since', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.user.findFirst.mockResolvedValue(sam);

    const response = await safety({ action: 'dismiss', person: sam.id });

    expect(response.status).toBe(200);
    expect(db.report.updateMany.mock.calls[0][0]).toMatchObject({
      where: { worldId: office.id, status: 'open', OR: [{ reportedUserId: sam.id }, { reportedUserId: null, reportedUuid: sam.uuid }] },
      data: { status: 'dismissed', handledById: admin.id },
    });
  });

  it('dismiss a guest Orbit never saw by their game uuid', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.user.findFirst.mockResolvedValue(null);

    const response = await safety({ action: 'dismiss', person: 'uuid:guest-1' });

    expect(response.status).toBe(200);
    expect(db.report.updateMany.mock.calls[0][0].where.OR).toEqual([{ reportedUserId: null, reportedUuid: 'guest-1' }]);
  });

  it('leave a ban that already ran out alone', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.ban.findFirst.mockResolvedValue(null);

    const response = await safety({ action: 'lift', banId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });

    expect(response.status).toBe(404);
    expect(db.ban.findFirst.mock.calls[0][0].where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }]);
    expect(db.ban.update).not.toHaveBeenCalled();
  });

  it('never ban the universe’s owner', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.user.findFirst.mockResolvedValue({ id: 'u-khalid', uuid: 'uuid-khalid' });
    db.world.findFirst.mockResolvedValue({ id: office.id });

    const response = await safety({ action: 'ban', person: 'u-khalid', duration: 'forever' });

    expect(response.status).toBe(400);
    expect(db.ban.create).not.toHaveBeenCalled();
  });

  it('answer an appeal when lifting the ban', async () => {
    session.mockResolvedValue(admin);
    db.world.findUnique.mockResolvedValue({ universe: { ownerId: 'u-khalid' } });
    db.worldMember.findFirst.mockResolvedValue({ id: 'm-1' });
    db.ban.findFirst.mockResolvedValue({ id: 'b-1', appealedAt: new Date(), appealDecision: null });

    const response = await safety({ action: 'lift', banId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' });

    expect(response.status).toBe(200);
    expect(db.ban.update.mock.calls[0][0].data).toMatchObject({ isActive: false, liftedById: admin.id, appealDecision: 'lifted' });
  });
});

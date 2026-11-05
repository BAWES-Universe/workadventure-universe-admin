// Passing a universe to another account (#820): the rules of the offer without a database. The same rules run against a real
// one in __tests__/api/ownership-transfer-db.test.ts (with ROLES_DB_TEST=yes).
import { Prisma } from '@prisma/client';

const mockTx = {
  ownershipOffer: { findUnique: jest.fn(), deleteMany: jest.fn() },
  universeMember: { findUnique: jest.fn() },
  role: { findUniqueOrThrow: jest.fn() },
  universe: { updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
const mockPrisma = {
  ...mockTx,
  ownershipOffer: { ...mockTx.ownershipOffer, create: jest.fn() },
  $transaction: jest.fn(async (work: (client: typeof mockTx) => unknown) => work(mockTx)),
};
jest.mock('@/lib/db', () => ({ get prisma() { return mockPrisma; } }));
jest.mock('@/lib/notices', () => ({ addNotice: jest.fn(async () => true), clearNotices: jest.fn(async () => undefined) }));
jest.mock('@/lib/universe-members', () => ({ joinUniverse: jest.fn(async () => []) }));
jest.mock('@/lib/roles', () => ({ ADMIN_KEY: 'admin', ensureBuiltInRoles: jest.fn(async () => undefined) }));

import { addNotice, clearNotices } from '@/lib/notices';
import { joinUniverse } from '@/lib/universe-members';
import { ensureBuiltInRoles } from '@/lib/roles';
import { OfferError, acceptOffer, declineOffer, mayOffer, startOffer, takeBackOffer } from '@/lib/ownership-offer';
import { endOfferIfLeft } from '@/lib/ownership-offer-ends';

const universe = { id: 'u1', name: 'Autonode Labs', ownerId: 'yousef' };
const owner = { id: 'yousef', isSuperAdmin: false };
const root = { id: 'root', isSuperAdmin: true };
const notices = addNotice as jest.Mock;
const joined = joinUniverse as jest.Mock;

const refused = async (work: Promise<unknown>) => {
  const error = await work.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(OfferError);
  return error as OfferError;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.universeMember.findUnique.mockResolvedValue({ id: 'm1' });
  mockPrisma.ownershipOffer.create.mockResolvedValue({ id: 'o1', universeId: 'u1', toUserId: 'lab', offeredById: 'yousef', createdAt: new Date() });
  mockPrisma.user.findUnique.mockResolvedValue({ name: 'Yousef' });
  mockPrisma.ownershipOffer.deleteMany.mockResolvedValue({ count: 1 });
});

describe('who may offer', () => {
  it('is the owner or a super admin, and nobody else', () => {
    expect(mayOffer(owner, universe)).toBe(true);
    expect(mayOffer(root, universe)).toBe(true);
    expect(mayOffer({ id: 'admin', isSuperAdmin: false }, universe)).toBe(false);
  });
});

describe('starting an offer', () => {
  const start = (overrides: Partial<Parameters<typeof startOffer>[0]> = {}) =>
    startOffer({ universe, by: owner, toUserId: 'lab', typedName: 'Autonode Labs', ...overrides });

  it('needs the owner or a super admin', async () => {
    expect((await refused(start({ by: { id: 'admin', isSuperAdmin: false } }))).status).toBe(403);
    expect(mockPrisma.ownershipOffer.create).not.toHaveBeenCalled();
  });

  it('needs the universe’s name typed exactly', async () => {
    for (const typedName of ['', 'autonode labs', 'Autonode Labs ', 'Autonode']) {
      expect((await refused(start({ typedName }))).status).toBe(400);
    }
    expect(mockPrisma.ownershipOffer.create).not.toHaveBeenCalled();
  });

  it('does not offer the universe to its owner, or to someone who is not a member', async () => {
    expect((await refused(start({ toUserId: 'yousef' }))).status).toBe(400);
    mockPrisma.universeMember.findUnique.mockResolvedValue(null);
    expect((await refused(start())).status).toBe(404);
    expect(mockPrisma.ownershipOffer.create).not.toHaveBeenCalled();
  });

  it('takes the offer back at once when the person left while it was being made', async () => {
    mockPrisma.universeMember.findUnique.mockResolvedValueOnce({ id: 'm1' }).mockResolvedValueOnce(null);
    expect((await refused(start())).status).toBe(404);
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1' } });
    expect(notices).not.toHaveBeenCalled();
  });

  it('takes the “offered to you” card down again when the offer ended while the notice was being written', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(null);
    await start();
    expect(clearNotices).toHaveBeenCalledWith('lab', 'ownership-offer', 'offered:o1');
    (clearNotices as jest.Mock).mockClear();
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ id: 'o1' });
    await start();
    expect(clearNotices).not.toHaveBeenCalled();
  });

  it('allows one offer at a time', async () => {
    mockPrisma.ownershipOffer.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: 'test' }));
    expect((await refused(start())).status).toBe(409);
  });

  it('lets other errors through, so a failure is never taken for “already waiting”', async () => {
    mockPrisma.ownershipOffer.create.mockRejectedValue(new Error('connection lost'));
    await expect(start()).rejects.toThrow('connection lost');
  });

  it('tells the person, and tells the owner too only when a super admin started it', async () => {
    await start();
    expect(notices.mock.calls.map(([notice]) => [notice.userId, notice.dedupeKey, notice.kind])).toEqual([['lab', 'offered:o1', 'ownership-offer']]);
    expect(notices.mock.calls[0][0].body).toMatch(/^Yousef offered you the whole universe/);

    notices.mockClear();
    await start({ by: root });
    expect(notices.mock.calls.map(([notice]) => notice.userId)).toEqual(['lab', 'yousef']);
    expect(notices.mock.calls[0][0].body).toMatch(/A super admin offered you the whole universe, on behalf of Yousef/);
  });

  it('never puts an email in a notice', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ name: null });
    await start();
    expect(JSON.stringify(notices.mock.calls)).not.toMatch(/@/);
  });
});

describe('taking back and declining', () => {
  it('lets the owner take back, and clears the person’s notice', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ id: 'o1', toUserId: 'lab' });
    await takeBackOffer({ universe, by: owner });
    // Spent only while the universe is still the taker's: a stale request after a hand-over takes back nothing
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1', universe: { ownerId: 'yousef' } } });
    expect(clearNotices).toHaveBeenCalledWith('lab', 'ownership-offer', 'offered:o1');
  });

  it('lets a super admin take back whoever owns the universe now', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ id: 'o1', toUserId: 'lab' });
    await takeBackOffer({ universe, by: root });
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1' } });
  });

  it('does not clear the person’s notice when the owner changed under a stale take back', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ id: 'o1', toUserId: 'lab' });
    mockPrisma.ownershipOffer.deleteMany.mockResolvedValue({ count: 0 });
    await refused(takeBackOffer({ universe, by: owner }));
    expect(clearNotices).not.toHaveBeenCalled();
  });

  it('refuses a take back from anyone else, and when nothing waits', async () => {
    expect((await refused(takeBackOffer({ universe, by: { id: 'lab', isSuperAdmin: false } }))).status).toBe(403);
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(null);
    expect((await refused(takeBackOffer({ universe, by: owner }))).status).toBe(404);
  });

  it('lets only the person it is for decline, and tells the owner', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ id: 'o1', toUserId: 'lab', offeredById: 'yousef', universe });
    expect((await refused(declineOffer({ offerId: 'o1', userId: 'someone-else' }))).status).toBe(404);
    expect(mockPrisma.ownershipOffer.deleteMany).not.toHaveBeenCalled();

    await declineOffer({ offerId: 'o1', userId: 'lab' });
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1', toUserId: 'lab' } });
    expect(notices.mock.calls.map(([notice]) => notice.userId)).toEqual(['yousef']);
  });
});

describe('accepting', () => {
  const offer = { id: 'o1', toUserId: 'lab', offeredById: 'yousef', universe };

  beforeEach(() => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(offer);
    mockPrisma.role.findUniqueOrThrow.mockResolvedValue({ id: 'r-admin' });
    mockPrisma.universe.updateMany.mockResolvedValue({ count: 1 });
  });

  it('spends the offer, makes both Admin in every world, then changes the owner, all in one transaction', async () => {
    const result = await acceptOffer({ offerId: 'o1', userId: 'lab' });
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1', toUserId: 'lab' } });
    expect(ensureBuiltInRoles).toHaveBeenCalledWith(mockTx, 'u1');
    const everywhere = { allWorlds: true, worldIds: [] };
    const admin = [{ roleId: 'r-admin', scope: everywhere }];
    expect(joined.mock.calls.map(([client, input]) => [client, input])).toEqual([
      [mockTx, { universeId: 'u1', userId: 'lab', worlds: everywhere, roles: admin }],
      [mockTx, { universeId: 'u1', userId: 'yousef', worlds: everywhere, roles: admin }],
    ]);
    expect(mockPrisma.universe.updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', ownerId: 'yousef' },
      data: { ownerId: 'lab', ownerSince: expect.any(Date), previousOwnerId: 'yousef' },
    });
    expect(result).toMatchObject({ universeId: 'u1', universeName: 'Autonode Labs' });
  });

  it('tells both sides and takes the “offered to you” notice away', async () => {
    await acceptOffer({ offerId: 'o1', userId: 'lab' });
    expect(clearNotices).toHaveBeenCalledWith('lab', 'ownership-offer', 'offered:o1');
    expect(notices.mock.calls.map(([notice]) => [notice.userId, notice.dedupeKey]).sort()).toEqual([
      ['lab', 'now-yours:o1'],
      ['yousef', 'accepted:o1'],
    ]);
  });

  it('is void when the universe changed hands after the offer was made, unless a super admin made it', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ ...offer, offeredById: 'old-owner' });
    mockTx.user.findUnique.mockResolvedValue({ email: 'plain@example.test' });
    const error = await refused(acceptOffer({ offerId: 'o1', userId: 'lab' }));
    expect(error.status).toBe(409);
    expect(mockPrisma.universe.updateMany).not.toHaveBeenCalled();
    expect(joined).not.toHaveBeenCalled();
    expect(clearNotices).toHaveBeenCalledWith('lab', 'ownership-offer', 'offered:o1');
    expect(notices).not.toHaveBeenCalled();
  });

  it('still goes through when a super admin made the offer for the owner', async () => {
    const before = process.env.SUPER_ADMINS;
    process.env.SUPER_ADMINS = 'root@example.test';
    try {
      mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ ...offer, offeredById: 'root' });
      mockTx.user.findUnique.mockResolvedValue({ email: 'root@example.test' });
      await acceptOffer({ offerId: 'o1', userId: 'lab' });
      expect(mockPrisma.universe.updateMany).toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env.SUPER_ADMINS; else process.env.SUPER_ADMINS = before;
    }
  });

  it('is only for the person it was made to', async () => {
    expect((await refused(acceptOffer({ offerId: 'o1', userId: 'someone-else' }))).status).toBe(404);
    expect(joined).not.toHaveBeenCalled();
    expect(mockPrisma.universe.updateMany).not.toHaveBeenCalled();
  });

  it('finds a spent offer gone', async () => {
    mockPrisma.ownershipOffer.deleteMany.mockResolvedValue({ count: 0 });
    expect((await refused(acceptOffer({ offerId: 'o1', userId: 'lab' }))).status).toBe(404);
    expect(joined).not.toHaveBeenCalled();
  });

  it('refuses someone who is no longer a member', async () => {
    mockPrisma.universeMember.findUnique.mockResolvedValue(null);
    expect((await refused(acceptOffer({ offerId: 'o1', userId: 'lab' }))).status).toBe(409);
    expect(mockPrisma.universe.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to hand a universe to its own owner', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ ...offer, universe: { ...universe, ownerId: 'lab' } });
    expect((await refused(acceptOffer({ offerId: 'o1', userId: 'lab' }))).status).toBe(409);
  });

  it('rolls everything back when the owner changed in the meantime', async () => {
    mockPrisma.universe.updateMany.mockResolvedValue({ count: 0 });
    expect((await refused(acceptOffer({ offerId: 'o1', userId: 'lab' }))).status).toBe(409);
    // Thrown inside the transaction, so the database undoes the spent offer and the roles; no notice goes out
    expect(notices).not.toHaveBeenCalled();
  });
});

describe('when someone leaves', () => {
  const waiting = { id: 'o1', toUserId: 'lab', offeredById: 'yousef', universe };

  it('ends the offer made to them and tells the owner', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(waiting);
    mockPrisma.universeMember.findUnique.mockResolvedValue(null);
    await endOfferIfLeft(mockPrisma as never, 'u1', 'lab');
    expect(mockPrisma.ownershipOffer.deleteMany).toHaveBeenCalledWith({ where: { id: 'o1' } });
    expect(notices.mock.calls.map(([notice]) => notice.userId)).toEqual(['yousef']);
  });

  it('tells the starter who is not the owner that nothing changed', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue({ ...waiting, offeredById: 'root' });
    mockPrisma.universeMember.findUnique.mockResolvedValue(null);
    await endOfferIfLeft(mockPrisma as never, 'u1', 'lab');
    const byUser = Object.fromEntries(notices.mock.calls.map(([notice]) => [notice.userId, notice.body]));
    expect(Object.keys(byUser).sort()).toEqual(['root', 'yousef']);
    expect(byUser.root).toMatch(/Nothing changed\.$/);
  });

  it('leaves the offer alone while they are still a member, or when it is for someone else', async () => {
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(waiting);
    await endOfferIfLeft(mockPrisma as never, 'u1', 'lab');
    await endOfferIfLeft(mockPrisma as never, 'u1', 'other');
    mockPrisma.ownershipOffer.findUnique.mockResolvedValue(null);
    await endOfferIfLeft(mockPrisma as never, 'u1', 'lab');
    expect(mockPrisma.ownershipOffer.deleteMany).not.toHaveBeenCalled();
  });
});

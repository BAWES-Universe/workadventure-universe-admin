/**
 * Passing a universe to another account (#820): the offer, take back, accept and decline routes against a real database,
 * so the accept transaction, who may offer and what ends an offer are tested end to end. Runs only with ROLES_DB_TEST=yes
 * and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/ownership-transfer-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (records: unknown[]) => records) }));
jest.mock('@/lib/push-messages', () => ({ notifyInvitation: jest.fn(), notifyRoleGiven: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { checkKeyForBot } from '@/lib/ai-key-pay';
import { ensureBuiltInRoles, worldAccessFor } from '@/lib/roles';
import { joinUniverse, leaveUniverse, leaveWorld } from '@/lib/universe-members';
import { has } from '@/lib/permissions';
import * as offerRoute from '@/app/api/admin/universes/[id]/ownership-offer/route';
import * as memberRoute from '@/app/api/admin/universes/[id]/members/[userId]/route';
import { GET as myOffers } from '@/app/api/memberships/ownership-offers/route';
import { POST as accept } from '@/app/api/memberships/ownership-offers/[id]/accept/route';
import { POST as decline } from '@/app/api/memberships/ownership-offers/[id]/decline/route';
import { GET as myUniverses } from '@/app/api/memberships/my/universes/route';
import { PATCH as patchUniverse } from '@/app/api/admin/universes/[id]/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const tag = randomUUID().slice(0, 8);
const people: Record<string, string> = {};
const all = { allWorlds: true, worldIds: [] as string[] };
let universeId = '';
let worldA = '';
let worldB = '';
let roomId = '';
let botId = '';
let keyId = '';
let adminRoleId = '';

async function call(who: string, route: unknown, params: Record<string, string>, init?: { method: string; body?: unknown }, superAdmin = false) {
  session.mockResolvedValue({ id: people[who], uuid: who, email: `${who}-${tag}@example.test`, name: who, tags: [], isSuperAdmin: superAdmin });
  const request = new NextRequest('http://localhost/api', {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const response = await (route as Handler)(request, { params: Promise.resolve(params) });
  return { status: response.status, body: await response.json() };
}

const offer = (who: string, to: string, universeName = 'Autonode Test', superAdmin = false) =>
  call(who, offerRoute.POST, { id: universeId }, { method: 'POST', body: { toUserId: people[to], universeName } }, superAdmin);
const takeBack = (who: string, superAdmin = false) => call(who, offerRoute.DELETE, { id: universeId }, { method: 'DELETE' }, superAdmin);
const waitingFor = (who: string) => prisma.ownershipOffer.findUnique({ where: { universeId } }).then((row) => (row?.toUserId === people[who] ? row : null));
const ownerId = async () => (await prisma.universe.findUniqueOrThrow({ where: { id: universeId } })).ownerId;
const tagsOf = async (who: string, worldId: string) =>
  (await prisma.worldMember.findUnique({ where: { userId_worldId: { userId: people[who], worldId } } }))?.tags ?? null;
const openNotices = (who: string) => prisma.userNotice.findMany({ where: { userId: people[who], kind: 'ownership-offer', dismissedAt: null } });

/** Put the universe back to how the next test expects it: owner is `owner`, no offer, `plain` and `sara` are members. */
async function reset() {
  await prisma.ownershipOffer.deleteMany({ where: { universeId } });
  await prisma.universe.update({ where: { id: universeId }, data: { ownerId: people.owner, ownerSince: null, previousOwnerId: null } });
  await prisma.universeMember.deleteMany({ where: { universeId } });
  await prisma.worldMember.deleteMany({ where: { worldId: { in: [worldA, worldB] } } });
  await prisma.userNotice.deleteMany({ where: { userId: { in: Object.values(people) } } });
  await joinUniverse(prisma, { universeId, userId: people.sara, worlds: all, roles: [] });
  await joinUniverse(prisma, { universeId, userId: people.plain, worlds: { allWorlds: false, worldIds: [worldA] }, roles: [] });
}

run('passing a universe to another account (real database)', () => {
  beforeAll(async () => {
    for (const who of ['owner', 'sara', 'plain', 'outsider', 'root']) {
      people[who] = (await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } })).id;
    }
    const universe = await prisma.universe.create({ data: { slug: `own-${tag}`, name: 'Autonode Test', ownerId: people.owner, isPublic: false } });
    universeId = universe.id;
    worldA = (await prisma.world.create({ data: { universeId, slug: 'a', name: 'A' } })).id;
    worldB = (await prisma.world.create({ data: { universeId, slug: 'b', name: 'B' } })).id;
    roomId = (await prisma.room.create({ data: { worldId: worldA, slug: 'lab', name: 'Lab' } })).id;
    await ensureBuiltInRoles(prisma, universeId);
    adminRoleId = (await prisma.role.findUniqueOrThrow({ where: { universeId_key: { universeId, key: 'admin' } } })).id;
    // The owner's bot runs on the owner's own key, lent to this universe
    keyId = `key-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId: keyId, name: 'Owner key', type: 'openai', ownerId: people.owner } });
    await prisma.aiKeyLend.create({ data: { providerId: keyId, universeId } });
    botId = (await prisma.bot.create({ data: { roomId, name: 'Nora', createdById: people.owner } })).id;
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId: keyId } });
    await prisma.userNotice.deleteMany({ where: { userId: { in: Object.values(people) } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people) } } });
    await prisma.$disconnect();
  });

  beforeEach(reset);

  const botRuns = () => checkKeyForBot({ keyId, keyOwnerId: people.owner, bot: { id: botId, createdById: people.owner, roomId, ownerId: null } });

  describe('who may offer, and to whom', () => {
    it('lets the owner offer to a member after typing the universe’s name, and changes nothing yet', async () => {
      const { status, body } = await offer('owner', 'sara');
      expect(status).toBe(201);
      expect(body.offer.toUserId).toBe(people.sara);
      expect(await ownerId()).toBe(people.owner);
      expect(await tagsOf('sara', worldA)).toEqual(['member']);
      // Sara is told, and sees it on Memberships
      expect(await openNotices('sara')).toHaveLength(1);
      const mine = await call('sara', myOffers, {});
      expect(mine.body.offers).toEqual([
        expect.objectContaining({ id: body.offer.id, universe: { id: universeId, name: 'Autonode Test', worldCount: 2 }, owner: { id: people.owner, name: 'owner' } }),
      ]);
      // Nobody else sees it
      expect((await call('plain', myOffers, {})).body.offers).toEqual([]);
    });

    it('refuses a wrong or missing name, and writes nothing', async () => {
      expect((await offer('owner', 'sara', 'autonode test')).status).toBe(400);
      expect((await offer('owner', 'sara', '')).status).toBe(400);
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
    });

    it('refuses someone who is not the owner, even a member with every role', async () => {
      await joinUniverse(prisma, { universeId, userId: people.plain, worlds: all, roles: [{ roleId: adminRoleId, scope: all }] });
      expect((await offer('plain', 'sara')).status).toBe(403);
      expect((await offer('sara', 'sara')).status).toBe(403);
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
    });

    it('refuses someone who is not a member, the owner themselves, and a person that does not exist', async () => {
      expect((await offer('owner', 'outsider')).status).toBe(404);
      expect((await offer('owner', 'owner')).status).toBe(400);
      const missing = await call('owner', offerRoute.POST, { id: universeId }, { method: 'POST', body: { toUserId: randomUUID(), universeName: 'Autonode Test' } });
      expect(missing.status).toBe(404);
    });

    it('hides the universe from someone who cannot see it', async () => {
      expect((await offer('outsider', 'sara')).status).toBe(404);
    });

    it('lets a super admin offer for an owner who lost their account, and tells the owner', async () => {
      const { status } = await offer('root', 'sara', 'Autonode Test', true);
      expect(status).toBe(201);
      expect(await ownerId()).toBe(people.owner);
      const told = await openNotices('owner');
      expect(told.map((notice) => notice.title)).toEqual(['Autonode Test was offered to someone else']);
      expect(told[0].body).toMatch(/super admin/);
    });

    it('allows one offer at a time', async () => {
      expect((await offer('owner', 'sara')).status).toBe(201);
      const second = await offer('owner', 'plain');
      expect(second.status).toBe(409);
      expect(await waitingFor('sara')).not.toBeNull();
    });
  });

  describe('the member page', () => {
    it('shows the owner Make owner, then who is waiting, and shows nobody else anything', async () => {
      const before = await call('owner', memberRoute.GET, { id: universeId, userId: people.sara });
      expect(before.body.ownership).toMatchObject({ canOffer: true, waiting: null });
      await offer('owner', 'sara');
      const onHers = await call('owner', memberRoute.GET, { id: universeId, userId: people.sara });
      expect(onHers.body.ownership).toMatchObject({ canOffer: false, waiting: { toName: 'sara', toThem: true } });
      const onOthers = await call('owner', memberRoute.GET, { id: universeId, userId: people.plain });
      expect(onOthers.body.ownership).toMatchObject({ canOffer: false, waiting: { toName: 'sara', toThem: false } });
      await joinUniverse(prisma, { universeId, userId: people.plain, worlds: all, roles: [{ roleId: adminRoleId, scope: all }] });
      const asAdmin = await call('plain', memberRoute.GET, { id: universeId, userId: people.sara });
      expect(asAdmin.body.ownership).toMatchObject({ canOffer: false, waiting: null });
    });
  });

  describe('taking back and declining', () => {
    it('lets the owner take it back, which leaves the other person’s list and clears their notice', async () => {
      await offer('owner', 'sara');
      expect(await openNotices('sara')).toHaveLength(1);
      expect((await takeBack('owner')).status).toBe(200);
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
      expect((await call('sara', myOffers, {})).body.offers).toEqual([]);
      expect(await openNotices('sara')).toHaveLength(0);
      expect((await takeBack('owner')).status).toBe(404);
    });

    it('does not let a member take the offer back', async () => {
      await offer('owner', 'sara');
      expect((await takeBack('sara')).status).toBe(403);
      expect(await waitingFor('sara')).not.toBeNull();
    });

    it('lets a super admin take it back, and tells the owner', async () => {
      await offer('owner', 'sara');
      expect((await takeBack('root', true)).status).toBe(200);
      expect((await openNotices('owner')).map((notice) => notice.title)).toEqual(['The offer for Autonode Test was taken back']);
    });

    it('lets the person decline: the offer ends, nothing changes, and the owner is told', async () => {
      const { body } = await offer('owner', 'sara');
      expect((await call('plain', decline, { id: body.offer.id }, { method: 'POST' })).status).toBe(404);
      expect((await call('sara', decline, { id: body.offer.id }, { method: 'POST' })).status).toBe(200);
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
      expect(await ownerId()).toBe(people.owner);
      expect(await tagsOf('sara', worldA)).toEqual(['member']);
      expect((await openNotices('owner')).map((notice) => notice.title)).toEqual(['sara declined Autonode Test']);
      expect(await openNotices('sara')).toHaveLength(0);
      // A new offer can go out again
      expect((await offer('owner', 'sara')).status).toBe(201);
    });
  });

  describe('accepting', () => {
    it('changes the owner for the whole universe and gives both people Admin in every world, in one go', async () => {
      const { body } = await offer('owner', 'sara');
      expect(await botRuns()).toMatchObject({ ok: true });
      expect((await call('plain', accept, { id: body.offer.id }, { method: 'POST' })).status).toBe(404);
      expect(await ownerId()).toBe(people.owner);

      const done = await call('sara', accept, { id: body.offer.id }, { method: 'POST' });
      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ success: true, universe: { id: universeId, name: 'Autonode Test' }, previousOwnerName: 'owner' });

      const universe = await prisma.universe.findUniqueOrThrow({ where: { id: universeId } });
      expect(universe).toMatchObject({ ownerId: people.sara, previousOwnerId: people.owner });
      expect(universe.ownerSince).toBeInstanceOf(Date);
      // Worlds and rooms follow the universe: they have no owner of their own
      expect(await prisma.world.count({ where: { universeId } })).toBe(2);
      expect(await prisma.room.findUniqueOrThrow({ where: { id: roomId } })).toBeTruthy();
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);

      // Both are Admin in every world, in Orbit and in the game (world_members tags are what the game reads)
      for (const who of ['sara', 'owner']) {
        expect(await tagsOf(who, worldA)).toEqual(['admin', 'member']);
        expect(await tagsOf(who, worldB)).toEqual(['admin', 'member']);
        for (const worldId of [worldA, worldB]) {
          const access = await worldAccessFor({ userId: people[who], worldId, universeId });
          expect(has(access.permissions, 'MANAGE_BOTS')).toBe(true);
          expect(has(access.permissions, 'INVITE_AND_REMOVE')).toBe(true);
        }
      }
      // Someone else is untouched
      expect(await tagsOf('plain', worldA)).toEqual(['member']);
      expect(await tagsOf('plain', worldB)).toBeNull();

      // The new owner now lists it under "You own", the old one under "Member of"
      const sara = (await call('sara', myUniverses, {})).body.universes.find((entry: { universe: { id: string } }) => entry.universe.id === universeId);
      const old = (await call('owner', myUniverses, {})).body.universes.find((entry: { universe: { id: string } }) => entry.universe.id === universeId);
      expect([sara.isOwner, old.isOwner]).toEqual([true, false]);
      expect(old.roles.map((given: { key: string }) => given.key)).toEqual(['admin']);

      // Both sides get a notice, and the "offered to you" one is gone
      expect((await openNotices('sara')).map((notice) => notice.title)).toEqual(['You own Autonode Test']);
      expect((await openNotices('owner')).map((notice) => notice.title)).toEqual(['sara owns Autonode Test now']);

      // Their pages say so
      const page = await call('owner', memberRoute.GET, { id: universeId, userId: people.sara });
      expect(page.body.member.isOwner).toBe(true);
      expect(page.body.ownership).toMatchObject({ since: expect.any(String), from: 'owner', canOffer: false });
    });

    it('keeps the old owner’s bot running on their lent key, which needs them to still manage bots', async () => {
      const { body } = await offer('owner', 'sara');
      await call('sara', accept, { id: body.offer.id }, { method: 'POST' });
      expect(await botRuns()).toEqual({ ok: true, lendModels: null });
      expect(await prisma.bot.findUniqueOrThrow({ where: { id: botId } })).toMatchObject({ createdById: people.owner });
      expect(await prisma.aiKeyLend.count({ where: { providerId: keyId, universeId } })).toBe(1);
      expect((await prisma.botsAiProvider.findUniqueOrThrow({ where: { providerId: keyId } })).ownerId).toBe(people.owner);
    });

    it('is why Admin is given: changing only the owner column would stop that bot', async () => {
      await prisma.universe.update({ where: { id: universeId }, data: { ownerId: people.sara } });
      expect(await botRuns()).toEqual({ ok: false, reason: 'no-access' });
    });

    it('gives an old owner who never joined a membership with Admin in every world', async () => {
      // The owner row alone: the owner made the universe and never joined it
      expect(await prisma.universeMember.count({ where: { universeId, userId: people.owner } })).toBe(0);
      const { body } = await offer('owner', 'sara');
      await call('sara', accept, { id: body.offer.id }, { method: 'POST' });
      const member = await prisma.universeMember.findUniqueOrThrow({ where: { universeId_userId: { universeId, userId: people.owner } }, include: { roles: true } });
      expect(member).toMatchObject({ allWorlds: true });
      expect(member.roles).toEqual([expect.objectContaining({ roleId: adminRoleId, allWorlds: true })]);
    });

    it('keeps the new owner’s other roles and adds Admin on top', async () => {
      const builder = await prisma.role.create({ data: { universeId, key: 'builder', name: 'Builder', position: 20 } });
      await joinUniverse(prisma, { universeId, userId: people.sara, worlds: all, roles: [{ roleId: builder.id, scope: { allWorlds: false, worldIds: [worldA] } }] });
      const { body } = await offer('owner', 'sara');
      await call('sara', accept, { id: body.offer.id }, { method: 'POST' });
      const given = await prisma.universeMemberRole.findMany({ where: { member: { universeId, userId: people.sara } }, include: { role: true } });
      expect(given.map((row) => row.role.key).sort()).toEqual(['admin', 'builder']);
      expect(given.find((row) => row.role.key === 'builder')).toMatchObject({ allWorlds: false, worldIds: [worldA] });
      expect(await tagsOf('sara', worldA)).toEqual(['admin', 'builder', 'member']);
    });

    it('lets the first accept win: a second one finds the offer spent', async () => {
      const { body } = await offer('owner', 'sara');
      const [first, second] = await Promise.all([
        call('sara', accept, { id: body.offer.id }, { method: 'POST' }),
        call('sara', accept, { id: body.offer.id }, { method: 'POST' }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 404]);
      expect(await ownerId()).toBe(people.sara);
    });

    it('hands over from whoever owns it now, if the owner changed some other way while the offer waited', async () => {
      const { body } = await offer('owner', 'sara');
      await prisma.universe.update({ where: { id: universeId }, data: { ownerId: people.plain } });
      expect((await call('sara', accept, { id: body.offer.id }, { method: 'POST' })).status).toBe(200);
      expect(await ownerId()).toBe(people.sara);
      expect((await prisma.universe.findUniqueOrThrow({ where: { id: universeId } })).previousOwnerId).toBe(people.plain);
    });

    it('does nothing at all when a step fails halfway: same owner, same roles, and the offer still waits', async () => {
      const { body } = await offer('owner', 'sara');
      // Making the old owner a member is the last step before the owner changes: make that step fail
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION fail_old_owner_${tag}() RETURNS trigger AS $$
        BEGIN
          IF NEW.user_id = '${people.owner}' THEN RAISE EXCEPTION 'forced failure'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_old_owner_${tag} BEFORE INSERT ON universe_members FOR EACH ROW EXECUTE FUNCTION fail_old_owner_${tag}()`);
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const failed = await call('sara', accept, { id: body.offer.id }, { method: 'POST' });
        expect(failed.status).toBe(500);
      } finally {
        errors.mockRestore();
        await prisma.$executeRawUnsafe(`DROP TRIGGER fail_old_owner_${tag} ON universe_members`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION fail_old_owner_${tag}()`);
      }
      expect(await ownerId()).toBe(people.owner);
      expect(await tagsOf('sara', worldA)).toEqual(['member']);
      expect(await waitingFor('sara')).not.toBeNull();
      expect(await botRuns()).toMatchObject({ ok: true });
      // And she can still accept once it works
      expect((await call('sara', accept, { id: body.offer.id }, { method: 'POST' })).status).toBe(200);
    });

    it('refuses someone who left meanwhile, and the offer is already gone', async () => {
      const { body } = await offer('owner', 'sara');
      await prisma.$transaction((tx) => leaveUniverse(tx, universeId, people.sara));
      expect((await call('sara', accept, { id: body.offer.id }, { method: 'POST' })).status).toBe(404);
      expect(await ownerId()).toBe(people.owner);
    });
  });

  describe('what ends an offer', () => {
    it('ends when the person is removed, and tells the owner', async () => {
      await offer('owner', 'sara');
      const removed = await call('owner', memberRoute.DELETE, { id: universeId, userId: people.sara }, { method: 'DELETE' });
      expect(removed.status).toBe(200);
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
      expect((await openNotices('owner')).map((notice) => notice.title)).toEqual(['The offer for Autonode Test ended']);
      expect(await openNotices('sara')).toHaveLength(0);
    });

    it('ends when the person leaves the last world they were in', async () => {
      await prisma.universeMember.deleteMany({ where: { universeId, userId: people.sara } });
      await joinUniverse(prisma, { universeId, userId: people.sara, worlds: { allWorlds: false, worldIds: [worldA] }, roles: [] });
      await offer('owner', 'sara');
      await prisma.$transaction((tx) => leaveWorld(tx, worldA, people.sara));
      expect(await prisma.ownershipOffer.count({ where: { universeId } })).toBe(0);
    });

    it('stays while the person still belongs to another world', async () => {
      await prisma.universeMember.deleteMany({ where: { universeId, userId: people.sara } });
      await joinUniverse(prisma, { universeId, userId: people.sara, worlds: { allWorlds: false, worldIds: [worldA, worldB] }, roles: [] });
      await offer('owner', 'sara');
      await prisma.$transaction((tx) => leaveWorld(tx, worldA, people.sara));
      expect(await waitingFor('sara')).not.toBeNull();
    });

    it('does not list an offer to someone who is no longer a member, even if the row somehow stayed', async () => {
      await offer('owner', 'sara');
      await prisma.universeMember.deleteMany({ where: { universeId, userId: people.sara } });
      expect((await call('sara', myOffers, {})).body.offers).toEqual([]);
    });

    it('goes with the universe', async () => {
      const other = await prisma.universe.create({ data: { slug: `gone-${tag}`, name: 'Gone', ownerId: people.owner } });
      await prisma.universeMember.create({ data: { universeId: other.id, userId: people.sara } });
      await prisma.ownershipOffer.create({ data: { universeId: other.id, toUserId: people.sara, offeredById: people.owner } });
      await prisma.universe.delete({ where: { id: other.id } });
      expect(await prisma.ownershipOffer.count({ where: { universeId: other.id } })).toBe(0);
    });
  });

  it('keeps the old PATCH path locked: a session still cannot set the owner', async () => {
    const response = await call('owner', patchUniverse, { id: universeId }, { method: 'PATCH', body: { ownerId: people.sara } });
    expect([400, 403]).toContain(response.status);
    expect(await ownerId()).toBe(people.owner);
    const asRoot = await call('root', patchUniverse, { id: universeId }, { method: 'PATCH', body: { ownerId: people.sara } }, true);
    expect([400, 403]).toContain(asRoot.status);
    expect(await ownerId()).toBe(people.owner);
  });
});

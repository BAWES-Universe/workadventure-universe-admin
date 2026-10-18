/**
 * accessForMany (many universes in three queries) gives exactly what accessFor gives one at a time, against a real
 * database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/access-for-many-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { fromKeys } from '@/lib/permissions';
import { accessFor, accessForMany, type Access } from '@/lib/role-access';
import { ensureBuiltInRoles } from '@/lib/roles';
import { joinUniverse } from '@/lib/universe-members';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const people: Record<string, string> = {};
const universes: string[] = [];

/** An access as plain data, so two can be compared */
const plain = (access: Access | null | undefined) =>
  access && { ...access, everywhere: access.everywhere.toString(), perWorld: [...access.perWorld].map(([world, permissions]) => [world, permissions.toString()]) };

run('accessForMany against a real database', () => {
  beforeAll(async () => {
    for (const who of ['owner', 'greeter', 'plain', 'outsider']) {
      people[who] = (await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } })).id;
    }
    for (const slug of ['one', 'two', 'three']) {
      const universe = await prisma.universe.create({ data: { slug: `many-${slug}-${tag}`, name: slug, ownerId: people.owner, isPublic: false } });
      universes.push(universe.id);
      const hq = (await prisma.world.create({ data: { universeId: universe.id, slug: 'hq', name: 'HQ' } })).id;
      await prisma.world.create({ data: { universeId: universe.id, slug: 'campus', name: 'Campus' } });
      await ensureBuiltInRoles(prisma, universe.id);
      const greeter = await prisma.role.create({
        data: { universeId: universe.id, key: 'greeter', name: 'Greeter', position: 10, permissions: fromKeys(['INVITE_AND_REMOVE']) },
      });
      // Greeter works in HQ only in the first universe, everywhere in the second, and isn't a member of the third
      if (slug === 'one') {
        await joinUniverse(prisma, { universeId: universe.id, userId: people.greeter, worlds: { allWorlds: true, worldIds: [] }, roles: [{ roleId: greeter.id, scope: { allWorlds: false, worldIds: [hq] } }] });
      }
      if (slug === 'two') {
        await joinUniverse(prisma, { universeId: universe.id, userId: people.greeter, worlds: { allWorlds: true, worldIds: [] }, roles: [{ roleId: greeter.id, scope: { allWorlds: true, worldIds: [] } }] });
      }
      await joinUniverse(prisma, { universeId: universe.id, userId: people.plain, worlds: { allWorlds: false, worldIds: [hq] }, roles: [] });
    }
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: { in: universes } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(people) } } });
    await prisma.$disconnect();
  });

  it.each(['owner', 'greeter', 'plain', 'outsider'])('gives %s what accessFor gives, universe by universe', async (who) => {
    const viewer = { id: people[who], isSuperAdmin: false };
    const many = await accessForMany(prisma, universes, viewer);
    expect(many.size).toBe(universes.length);
    for (const universeId of universes) {
      expect(plain(many.get(universeId))).toEqual(plain(await accessFor(prisma, universeId, viewer)));
    }
  });

  it('gives a super admin full access everywhere, leaves out a universe that does not exist, and takes none without error', async () => {
    const many = await accessForMany(prisma, [...universes, randomUUID()], { id: people.outsider, isSuperAdmin: true });
    expect(many.size).toBe(universes.length);
    expect([...many.values()].every((access) => access.full)).toBe(true);
    expect((await accessForMany(prisma, [], { id: people.outsider })).size).toBe(0);
  });
});

/**
 * The Members list in rank order (`order=roles`) against a real database: the highest role first (not the most roles),
 * newest within a rank, pages that never skip or repeat anyone, and a hidden role that lifts nobody for a viewer who
 * cannot see it. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/universe-members-order-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn() }));
jest.mock('@/lib/woka-avatar', () => ({ withWokas: jest.fn(async (records: unknown[]) => records) }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { ensureBuiltInRoles } from '@/lib/roles';
import { GET } from '@/app/api/admin/universes/[id]/members/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;

const tag = randomUUID().slice(0, 8);
const PLAIN = 55;
const ids: Record<string, string> = {};
let universeId = '';

interface Listed {
  members: { userId: string; roles: { roleId: string }[] }[];
  total: number;
  nextCursor: string | null;
}

async function page(as: string, cursor: string | null): Promise<Listed> {
  session.mockResolvedValue({ id: ids[as], uuid: as, email: `${as}-${tag}@example.test`, name: as, tags: [], isSuperAdmin: false });
  const query = new URLSearchParams({ order: 'roles' });
  if (cursor) query.set('cursor', cursor);
  const response = await GET(new NextRequest(`http://localhost/api?${query}`), { params: Promise.resolve({ id: universeId }) });
  expect(response.status).toBe(200);
  return response.json();
}

/** Every page, in order, as the Members page reads them. */
async function everyone(as: string): Promise<{ order: string[]; pages: number; total: number }> {
  const order: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let total = 0;
  do {
    const answer: Listed = await page(as, cursor);
    pages += 1;
    total = answer.total;
    order.push(...answer.members.map((member) => member.userId));
    cursor = answer.nextCursor;
  } while (cursor && pages < 10);
  return { order, pages, total };
}

run('the Members list in rank order (real database)', () => {
  beforeAll(async () => {
    const names = ['owner', 'viewer', 'admin', 'lows', 'secret', ...Array.from({ length: PLAIN }, (_, n) => `plain${n}`)];
    for (const who of names) {
      const user = await prisma.user.create({ data: { uuid: `${who}-${tag}`, email: `${who}-${tag}@example.test`, name: who } });
      ids[who] = user.id;
    }
    universeId = (await prisma.universe.create({ data: { slug: `order-${tag}`, name: 'Order test', ownerId: ids.owner, isPublic: false } })).id;
    await ensureBuiltInRoles(prisma, universeId);
    const built = Object.fromEntries((await prisma.role.findMany({ where: { universeId } })).map((role) => [role.key, role.id]));
    const low1 = (await prisma.role.create({ data: { universeId, key: 'low-one', name: 'Low one', position: 10 } })).id;
    const low2 = (await prisma.role.create({ data: { universeId, key: 'low-two', name: 'Low two', position: 11 } })).id;
    const secret = (await prisma.role.create({ data: { universeId, key: 'secret', name: 'Secret', position: 500, showBadge: false } })).id;

    // Everyone joined at a different moment; the Admin joined first of all, so only rank can put them on top
    const start = Date.parse('2026-01-01T00:00:00Z');
    const joined = (n: number) => new Date(start + n * 60_000);
    const member = async (who: string, n: number, given: string[] = []) => {
      const row = await prisma.universeMember.create({ data: { universeId, userId: ids[who], allWorlds: true, joinedAt: joined(n) } });
      for (const roleId of given) await prisma.universeMemberRole.create({ data: { memberId: row.id, roleId, allWorlds: true } });
    };
    await member('admin', 0, [built.admin]);
    await member('lows', 1, [low1, low2]);
    await member('secret', 2, [secret]);
    await member('viewer', 3);
    for (let n = 0; n < PLAIN; n += 1) await member(`plain${n}`, 10 + n);
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(ids) } } });
    await prisma.$disconnect();
  });

  it('puts a lone Admin before someone with two low roles, however early or late each joined', async () => {
    const { order } = await everyone('owner');
    expect(order[0]).toBe(ids.admin);
    expect(order.indexOf(ids.admin)).toBeLessThan(order.indexOf(ids.lows));
  });

  it('ranks by highest role, then newest, and pages continue without gaps or repeats', async () => {
    const { order, pages, total } = await everyone('owner');
    // 60 people (the owner never joined): more than one page of 50
    expect(total).toBe(PLAIN + 4);
    expect(pages).toBe(2);
    expect(order).toHaveLength(total);
    expect(new Set(order).size).toBe(total);
    // The owner sees every role: Admin, then the Secret role (500), then the two low roles (11), then Member by newest
    expect(order.slice(0, 3)).toEqual([ids.admin, ids.secret, ids.lows]);
    const plain = order.slice(3);
    expect(plain[0]).toBe(ids.plain54);
    expect(plain[plain.length - 1]).toBe(ids.viewer);
    expect(plain.slice(0, PLAIN)).toEqual(Array.from({ length: PLAIN }, (_, n) => ids[`plain${PLAIN - 1 - n}`]));
  });

  it('does not let a hidden role lift someone for a viewer who cannot see it', async () => {
    const { order, total } = await everyone('viewer');
    expect(order).toHaveLength(total);
    expect(new Set(order).size).toBe(total);
    // The Secret role is invisible to them, so that person is just a Member who joined early (last of all, after the viewer)
    expect(order.slice(0, 2)).toEqual([ids.admin, ids.lows]);
    const members = order.slice(2);
    expect(members[members.length - 1]).toBe(ids.secret);
    expect(members[members.length - 2]).toBe(ids.viewer);
  });
});

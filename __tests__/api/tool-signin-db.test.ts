/**
 * The cards of a tool's lost sign-in against a real database: a card that is made for an instant another person's dismissed card already holds
 * (same key) must not undo the rest of the work. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/tool-signin-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/bot-permissions', () => ({
  ...jest.requireActual('@/lib/bot-permissions'),
  canManageBotMcpServers: jest.fn(async () => true),
}));

process.env.ENCRYPTION_KEY = 'ab'.repeat(32);

import { prisma } from '@/lib/db';
import { ensureDefaultBrick } from '@/lib/brick-default';
import { syncToolSignInNotices, TOOL_SIGNIN_KIND } from '@/lib/tool-signin';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const people: string[] = [];
let counter = 0;
async function person(name: string) {
  const unique = `${name}-${tag}-${++counter}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const { brick } = await ensureDefaultBrick(user.id);
  return { id: user.id, brickId: brick!.id };
}

run('a tool sign-in card that is a duplicate, in a real database', () => {
  afterAll(async () => {
    await prisma.userNotice.deleteMany({ where: { userId: { in: people } } });
    await prisma.bot.deleteMany({ where: { createdById: { in: people } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: people } } });
  });

  it('keeps the other person’s updated card, and says it finished, when the new card for another person is one that was already made and dismissed', async () => {
    const owner = await person('owner');
    const other = await person('other');
    const early = new Date('2026-11-05T09:54:00.000Z');
    const late = new Date('2026-11-05T09:58:00.000Z');
    const connection = (name: string, connectedById: string, signInLostAt: Date) =>
      prisma.botMcpServer.create({ data: { botId: owner.brickId, name, serverUrl: `https://${name}.example.test/mcp`, authType: 'oauth', signInLostAt, connectedById } });
    await connection('First', owner.id, early);
    const second = await connection('Second', other.id, late);
    const dedupeKey = `${TOOL_SIGNIN_KIND}:${owner.brickId}:${late.toISOString()}`;
    // The owner has a card up for an earlier outage; the other person dismissed their card for this very instant
    const open = await prisma.userNotice.create({ data: { userId: owner.id, kind: TOOL_SIGNIN_KIND, dedupeKey: `${TOOL_SIGNIN_KIND}:${owner.brickId}:old`, title: 'old title', body: 'old body' } });
    await prisma.userNotice.create({ data: { userId: other.id, kind: TOOL_SIGNIN_KIND, dedupeKey, title: 't', body: 'b', dismissedAt: new Date() } });

    await expect(syncToolSignInNotices(owner.brickId, { serverId: second.id, at: late })).resolves.toBe(true);

    // The owner's card was brought up to date in the same transaction: a duplicate for the other person did not roll it back
    expect((await prisma.userNotice.findUniqueOrThrow({ where: { id: open.id } })).title).not.toBe('old title');
    // The dismissed card is still dismissed, and no second one was made
    const others = await prisma.userNotice.findMany({ where: { userId: other.id, kind: TOOL_SIGNIN_KIND } });
    expect(others).toHaveLength(1);
    expect(others[0].dismissedAt).not.toBeNull();
  });
});

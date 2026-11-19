/**
 * The row a copy of someone else's artifact is made from is held while the copy is made (changeInACopy): a change of how it is shared, committed while
 * the copy is being made, waits for it, and what the copy looks at is then the sharing that stands. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to
 * a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/artifact-copy-lock-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { holdForCopy } from '@/lib/artifact-service';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

run('the original of a copy, in a real database', () => {
  const made: string[] = [];
  afterAll(async () => {
    await prisma.artifact.deleteMany({ where: { id: { in: made } } });
    await prisma.$disconnect();
  });

  it('makes a change of how it is shared, committed meanwhile, wait for the copy, which then looks at the sharing it was read with', async () => {
    const id = randomUUID();
    made.push(id);
    await prisma.artifact.create({ data: { id, makerBotId: `bot-${id}`, makerName: 'Bot', title: 'Page', kind: 'page', openScope: 'chat', changeScope: 'openers' } });
    let letGo: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let held: () => void = () => undefined;
    const atTheLock = new Promise<void>((resolve) => (held = resolve));
    // The copy's transaction: holds the row, then looks at the sharing (as it was read) once the test lets it go
    const copy = prisma.$transaction(async (tx) => {
      await holdForCopy(tx, id);
      held();
      await gate;
      return tx.artifact.count({ where: { id, openScope: 'chat', changeScope: 'openers' } });
    });
    await atTheLock;
    // The owner makes it "Just you" now: this write waits for the copy's transaction
    let changed = false;
    const owner = prisma.artifact.update({ where: { id }, data: { openScope: 'me' } }).then(() => {
      changed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(changed).toBe(false);
    letGo();
    // The copy saw the sharing it was read with and was saved; only then does the change go through
    expect(await copy).toBe(1);
    await owner;
    expect(changed).toBe(true);
    expect((await prisma.artifact.findUniqueOrThrow({ where: { id } })).openScope).toBe('me');
  });
});

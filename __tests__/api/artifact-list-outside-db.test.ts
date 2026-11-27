/**
 * The list of a chat's artifacts for someone outside it (GPT audit 26 Nov, O12), in a real database: ordered by when what THEY are shown
 * changed (the publish time of a published one, the change time of one never published), paged by the database, across more than one page.
 * Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/artifact-list-outside-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';
import { ARTIFACT_PAGE_SIZE, listChatArtifacts } from '@/lib/artifact-service';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

run('the outside list of a chat, in a real database', () => {
  const chat = { kind: 'nearby' as const, ref: `outside-${randomUUID()}` };
  const made: string[] = [];
  afterAll(async () => {
    await prisma.artifact.deleteMany({ where: { id: { in: made } } });
    await prisma.$disconnect();
  });

  it('pages by what the visitor sees: a draft changed last never moves a published one up, and every artifact comes once, in order', async () => {
    const base = Date.parse('2026-11-20T00:00:00Z');
    const minutes = (n: number) => new Date(base + n * 60_000);
    // More than a page: every third never published (shown by its change time), the rest published long ago and changed (as a draft) recently
    const expected: { id: string; at: number }[] = [];
    const count = ARTIFACT_PAGE_SIZE + 12;
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      made.push(id);
      const published = i % 3 !== 0;
      const shownAt = minutes(i * 10);
      await prisma.artifact.create({
        data: {
          id,
          makerBotId: 'bot-outside',
          makerName: 'Bot',
          title: `Page ${i}`,
          kind: 'page',
          openScope: 'link',
          chatKind: chat.kind,
          chatRef: chat.ref,
          latestVersion: published ? 2 : 1,
          publishedVersion: published ? 1 : null,
          publishedAt: published ? shownAt : null,
          publishedTitle: published ? `Page ${i}` : null,
        },
      });
      // The draft of a published one changed after everything else (the database sets updatedAt itself, so it is written straight)
      const changed = published ? minutes(100_000 + i) : shownAt;
      await prisma.$executeRaw`UPDATE "artifacts" SET "updated_at" = ${changed} WHERE "id" = ${id}`;
      expected.push({ id, at: shownAt.getTime() });
    }
    expected.sort((a, b) => b.at - a.at);
    const viewer = { person: { signedIn: false, name: 'Visitor' }, inChat: false, chat };
    const first = await listChatArtifacts(viewer, 0);
    expect(first.total).toBe(count);
    expect(first.next).toBe(ARTIFACT_PAGE_SIZE);
    const second = await listChatArtifacts(viewer, first.next as number);
    expect(second.next).toBeNull();
    const seen = [...first.artifacts, ...second.artifacts];
    expect(seen.map((a) => a.id)).toEqual(expected.map((e) => e.id));
    // Each says the time of what is shown: never a draft's change time
    for (const artifact of seen) expect(Date.parse(artifact.updatedAt)).toBe(expected.find((e) => e.id === artifact.id)?.at);
  });
});

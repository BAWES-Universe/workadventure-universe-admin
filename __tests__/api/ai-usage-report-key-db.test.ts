/**
 * The report key on a usage row, against a real database: Orbit's own id for one report, so a report written twice after a lost commit answer
 * is one row. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest -i __tests__/api/ai-usage-report-key-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const providerId = `rk-${tag}`;
const botId = `bot-${tag}`;

run('the report key of a usage row', () => {
  beforeAll(async () => {
    await prisma.botsAiProvider.create({ data: { providerId, name: `Key ${tag}`, type: 'openai', enabled: true, model: 'm' } });
  });
  afterAll(async () => {
    await prisma.botsAiUsage.deleteMany({ where: { providerId } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId } });
    await prisma.$disconnect();
  });

  const data = (reportKey: string | null) => ({ botId, providerId, tokensUsed: 10, apiCalls: 1, reportKey });

  it('refuses a second row with the same key (the database says so as P2002), and keeps the first', async () => {
    const key = randomUUID();
    const first = await prisma.botsAiUsage.create({ data: data(key) });
    const second = await prisma.botsAiUsage.create({ data: data(key) }).catch((error) => error as { code?: string });
    expect(second).toMatchObject({ code: 'P2002' });
    expect(await prisma.botsAiUsage.count({ where: { reportKey: key } })).toBe(1);
    expect((await prisma.botsAiUsage.findUnique({ where: { reportKey: key } }))?.id).toBe(first.id);
  });

  it('takes any number of rows without a key (older rows, and rows written without one)', async () => {
    await prisma.botsAiUsage.create({ data: data(null) });
    await prisma.botsAiUsage.create({ data: data(null) });
    expect(await prisma.botsAiUsage.count({ where: { providerId, reportKey: null } })).toBeGreaterThanOrEqual(2);
  });
});

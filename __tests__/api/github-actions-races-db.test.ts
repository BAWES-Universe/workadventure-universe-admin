/**
 * GitHub actions judged in the moments between two reads (CodeRabbit on #1045): a heading moved after the rows were last brought up to date,
 * and a grant brought over between the two reads of gitHubJudgeFor. Each moment is made by holding back one call once. Runs only with
 * ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/github-actions-races-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

jest.mock('@/lib/app-actions/catalog', () => {
  const actual = jest.requireActual('@/lib/app-actions/catalog');
  return { ...actual, ensureAppActions: jest.fn(actual.ensureAppActions) };
});
jest.mock('@/lib/app-actions/grant', () => {
  const actual = jest.requireActual('@/lib/app-actions/grant');
  return { ...actual, actionJudgeFor: jest.fn(actual.actionJudgeFor) };
});

import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { createBrick } from '@/lib/brick-create';
import { grantToBrick } from '@/lib/app-connections';
import { readServerTools, setToolSetting } from '@/lib/mcp-tool-policy';
import { ensureAppActions } from '@/lib/app-actions/catalog';
import { actionJudgeFor } from '@/lib/app-actions/grant';
import { gitHubJudgeFor } from '@/lib/github/judge';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const envBefore = { key: process.env.ENCRYPTION_KEY };
const people: string[] = [];
let made = 0;

async function withGitHub(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  const auth = { provider: 'github', accessToken: 'ghu_x', refreshToken: 'ghr_x', expiresAt: Math.floor(Date.now() / 1000) + 3600, login: `${name}-gh`, githubId: 900 + made };
  const connection = await prisma.appConnection.create({
    data: { ownerId: user.id, name: 'GitHub', serverUrl: '', source: 'github', catalogKey: '@github', authType: 'oauth', authConfig: encryptApiKey(JSON.stringify(auth)) },
  });
  const grant = await grantToBrick(user.id, connection.id, brick.id);
  return { brickId: brick.id, connectionId: connection.id, serverId: grant!.id };
}

run('GitHub actions judged between two reads, in a real database', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  });
  afterAll(async () => {
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = envBefore.key;
    await prisma.$disconnect();
  });

  it('judges Run a workflow by the heading read with its row, not by the starting choice saved before the heading was set Off', async () => {
    const sara = await withGitHub('sara');
    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(tools.tools.find((tool) => tool.name === 'github_run_workflow')?.setting).toBe('asksFirst');
    // The heading is set Off, and the rows are not brought up to date before the judge reads them (the list can't be read this once)
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'off' } });
    jest.mocked(ensureAppActions).mockResolvedValueOnce(null);
    expect((await prisma.botMcpTool.findFirst({ where: { serverId: sara.serverId, name: 'github_run_workflow' } }))?.setting).toBe('asksFirst');
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('off');
  });

  it('judges a grant brought over between its two reads by its rows, with the person’s Off', async () => {
    const sara = await withGitHub('sara');
    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    await setToolSetting(sara.brickId, sara.serverId, tools.tools.find((tool) => tool.name === 'github_write_files')!.id, 'off');
    // The first read saw the grant before it was brought over
    jest.mocked(actionJudgeFor).mockResolvedValueOnce(null);
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_write_files').setting).toBe('off');
  });
});

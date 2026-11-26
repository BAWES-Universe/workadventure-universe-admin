/**
 * Universe's own GitHub as an App's actions on a Brick (lib/github/actions.ts, lib/github/judge.ts): the list is saved from the code under
 * its own key, a GitHub grant is brought over to one row per action like a ready-made App's, Run a workflow starts on Asks first, and a
 * grant not brought over yet is judged the same way from its headings. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated
 * THROWAWAY database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest __tests__/api/github-actions-db.test.ts --runInBand
 */
import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db';
import { encryptApiKey } from '@/lib/encryption';
import { createBrick } from '@/lib/brick-create';
import { grantToBrick } from '@/lib/app-connections';
import { readServerTools, setToolSetting, syncCatalog } from '@/lib/mcp-tool-policy';
import { actionsKeyOf } from '@/lib/app-actions/grant';
import { GITHUB_ACTIONS, GITHUB_ACTIONS_KEY, ownActionList } from '@/lib/github/actions';
import { GITHUB_TOOLS } from '@/lib/github/tools';
import { computerStops, gitHubJudgeFor } from '@/lib/github/judge';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().slice(0, 8);
const envBefore = { key: process.env.ENCRYPTION_KEY };
const people: string[] = [];
let made = 0;

/** A person with Universe's GitHub connected, given to their Brick. */
async function withGitHub(name: string) {
  const unique = `${name}-${tag}-${++made}`;
  const user = await prisma.user.create({ data: { uuid: unique, email: `${unique}@example.test`, name } });
  people.push(user.id);
  const brick = await createBrick({ ownerId: user.id, name: `${name}'s Brick` });
  const auth = { provider: 'github', accessToken: 'ghu_x', refreshToken: 'ghr_x', expiresAt: Math.floor(Date.now() / 1000) + 3600, login: `${name}-gh`, githubId: 700 + made };
  const connection = await prisma.appConnection.create({
    data: { ownerId: user.id, name: 'GitHub', serverUrl: '', source: 'github', catalogKey: '@github', authType: 'oauth', authConfig: encryptApiKey(JSON.stringify(auth)) },
  });
  const grant = await grantToBrick(user.id, connection.id, brick.id);
  return { personId: user.id, brickId: brick.id, connectionId: connection.id, serverId: grant!.id };
}

run('Universe’s GitHub as an App’s actions, in a real database', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
  });
  afterAll(async () => {
    // Universe's GitHub list is the same for everyone and is saved again from the code: it stays
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: people } } });
    await prisma.user.deleteMany({ where: { id: { in: people } } });
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = envBefore.key;
    await prisma.$disconnect();
  });

  it('keeps GitHub’s list under its own key, apart from the provider’s GitHub App', () => {
    expect(GITHUB_ACTIONS.map((action) => action.slug)).toEqual(GITHUB_TOOLS.map((tool) => tool.name));
    expect(actionsKeyOf({ source: 'github', providerToolkit: null })).toBe(GITHUB_ACTIONS_KEY);
    expect(actionsKeyOf({ source: 'ready_made', providerToolkit: 'github' })).toBe('github');
    expect(ownActionList('github')).toBeNull();
    expect(ownActionList(GITHUB_ACTIONS_KEY)).toBe(GITHUB_ACTIONS);
  });

  it('brings a GitHub grant over to one row per action, sorted by Universe, with Run a workflow on Asks first', async () => {
    const sara = await withGitHub('sara');
    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(tools.kind).toBe('appActions');
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(GITHUB_TOOLS.map((tool) => tool.name).sort());
    // Sorted by Universe, so nobody has to confirm them
    expect(tools.state).toBe('confirmed');
    expect(tools.tools.every((tool) => tool.confirmedBy?.name === null)).toBe(true);
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('github_read_file')).toMatchObject({ title: 'Read a file', heading: 'looksUp', setting: null });
    expect(byName.get('github_write_files')).toMatchObject({ title: 'Commit files', heading: 'changesThings', setting: null });
    expect(byName.get('github_run_workflow')).toMatchObject({ title: 'Run a workflow', heading: 'changesThings', setting: 'asksFirst' });
    expect(tools.tools.filter((tool) => tool.setting !== null).map((tool) => tool.name)).toEqual(['github_run_workflow']);
    // The list itself: Universe's words, never the sorter's
    const saved = await prisma.appAction.findMany({ where: { toolkit: GITHUB_ACTIONS_KEY }, select: { slug: true, title: true, heading: true, source: true } });
    expect(saved).toHaveLength(GITHUB_ACTIONS.length);
    expect(saved.every((row) => row.source === 'universe')).toBe(true);
    expect(saved.find((row) => row.slug === 'github_run_workflow')).toMatchObject({ title: 'Run a workflow', heading: 'changesThings' });

    const judge = await gitHubJudgeFor(sara.brickId, sara.connectionId);
    expect(judge?.judge('github_run_workflow').setting).toBe('asksFirst');
    expect(judge?.judge('github_write_files').setting).toBe('rightAway');
  });

  it('keeps a person’s choice when the grant is read again, and Run a workflow on Right away once they say so', async () => {
    const sara = await withGitHub('sara');
    const first = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    const runId = first.tools.find((tool) => tool.name === 'github_run_workflow')!.id;
    const commitId = first.tools.find((tool) => tool.name === 'github_write_files')!.id;
    await setToolSetting(sara.brickId, sara.serverId, runId, 'rightAway');
    await setToolSetting(sara.brickId, sara.serverId, commitId, 'off');
    // A new list version (a release with a changed action) brings the rows up to date without touching the choices
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { appActionsVersion: -1 } });
    const again = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    const byName = new Map(again.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('github_run_workflow')?.setting).toBe('rightAway');
    expect(byName.get('github_write_files')?.setting).toBe('off');
    const judge = (await gitHubJudgeFor(sara.brickId, sara.connectionId))!;
    expect(judge.judge('github_run_workflow').setting).toBe('rightAway');
    expect(computerStops(judge, 'Nudge').push).toBe('Commit files is off for Nudge in GitHub, so nothing was pushed.');
    expect(computerStops(judge, 'Nudge').read).toBeNull();
  });

  it('never loosens what a person set before the grant was brought over: a tool under a heading set Off stays Off as its own choice', async () => {
    const sara = await withGitHub('sara');
    // The bot server read GitHub's tools before Orbit knew App actions, and the person turned Makes new things off
    await syncCatalog(sara.brickId, sara.serverId, {
      tools: [
        { name: 'github_write_files', fingerprint: 'f-write', suggestedHeading: 'makesNew', suggestionSource: 'server' },
        { name: 'github_read_file', fingerprint: 'f-read', suggestedHeading: 'looksUp', suggestionSource: 'server' },
      ],
    });
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { makeSetting: 'off' } });
    const before = (await gitHubJudgeFor(sara.brickId, sara.connectionId))!;
    // Before it is brought over, Orbit judges by Universe's sorting and never looser than the grant's own rows: Commit files stays Off,
    // on the computer too; an action the rows never had follows Universe's sorting
    expect(before.judge('github_write_files').setting).toBe('off');
    expect(computerStops(before, 'Nudge').push).toBe('Commit files is off for Nudge in GitHub, so nothing was pushed.');
    expect(before.judge('github_create_branch').setting).toBe('rightAway');

    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    expect(byName.get('github_write_files')).toMatchObject({ heading: 'changesThings', setting: 'off' });
    expect(byName.get('github_read_file')).toMatchObject({ heading: 'looksUp', setting: null });
    expect(byName.get('github_create_branch')?.setting).toBeNull();
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_write_files').setting).toBe('off');
  });

  it('never makes Run a workflow looser than its heading: a heading set Off keeps it Off, before and after the grant is brought over', async () => {
    const sara = await withGitHub('sara');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'off' } });
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('off');
    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(tools.tools.find((tool) => tool.name === 'github_run_workflow')?.setting).toBeNull();
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('off');
  });

  it('starts Run a workflow on Asks first under a heading set Asks first too, with nothing of its own', async () => {
    const sara = await withGitHub('sara');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'asksFirst' } });
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('asksFirst');
    const tools = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(tools.tools.find((tool) => tool.name === 'github_run_workflow')?.setting).toBeNull();
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('asksFirst');
  });

  it('follows the person’s heading as they change it: Off holds Run a workflow Off, and a looser heading brings back Asks first; a choice of their own stays', async () => {
    const sara = await withGitHub('sara');
    const first = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    const runId = first.tools.find((tool) => tool.name === 'github_run_workflow')!.id;
    const settingOfRun = async () => (await readServerTools(sara.brickId, sara.serverId, { appActions: true })).tools.find((tool) => tool.name === 'github_run_workflow')?.setting;
    const judged = async () => (await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting;
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'off' } });
    expect(await judged()).toBe('off');
    expect(await settingOfRun()).toBeNull();
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'rightAway' } });
    expect(await settingOfRun()).toBe('asksFirst');
    expect(await judged()).toBe('asksFirst');
    // The person picks Right away for it themselves: that stays, whatever the heading does
    await setToolSetting(sara.brickId, sara.serverId, runId, 'rightAway');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'asksFirst' } });
    expect(await settingOfRun()).toBe('rightAway');
    expect(await judged()).toBe('rightAway');
  });

  it('brings Run a workflow back to Asks first when the person loosens a heading that was Off', async () => {
    const sara = await withGitHub('sara');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'off' } });
    await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    // The heading moves to Right away and nothing has read the grant since: the row still has no choice of its own
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'rightAway' } });
    expect((await prisma.botMcpTool.findFirst({ where: { serverId: sara.serverId, name: 'github_run_workflow' } }))?.setting).toBeNull();
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('asksFirst');
  });

  it('keeps Asks first for Run a workflow when the person chose it themselves, even under a heading set Off', async () => {
    const sara = await withGitHub('sara');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'off' } });
    const first = await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    const runId = first.tools.find((tool) => tool.name === 'github_run_workflow')!.id;
    await setToolSetting(sara.brickId, sara.serverId, runId, 'asksFirst');
    const row = () => prisma.botMcpTool.findUniqueOrThrow({ where: { id: runId }, select: { setting: true, settingByPerson: true } });
    expect(await row()).toEqual({ setting: 'asksFirst', settingByPerson: true });
    await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(await row()).toEqual({ setting: 'asksFirst', settingByPerson: true });
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('asksFirst');
    // A new list version keeps it too
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { appActionsVersion: -1 } });
    await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(await row()).toEqual({ setting: 'asksFirst', settingByPerson: true });
    // Back to "as its heading": it follows Off again
    await setToolSetting(sara.brickId, sara.serverId, runId, null);
    await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    expect(await row()).toEqual({ setting: null, settingByPerson: false });
    expect((await gitHubJudgeFor(sara.brickId, sara.connectionId))!.judge('github_run_workflow').setting).toBe('off');
  });

  it('judges an action of Universe’s list that the grant has no row for by Universe’s list, not as Right away', async () => {
    const sara = await withGitHub('sara');
    await readServerTools(sara.brickId, sara.serverId, { appActions: true });
    // As if a release added Run a workflow and its list was not saved yet
    await prisma.botMcpTool.deleteMany({ where: { serverId: sara.serverId, name: 'github_run_workflow' } });
    const judge = (await gitHubJudgeFor(sara.brickId, sara.connectionId))!;
    expect(judge.knows('github_run_workflow')).toBe(true);
    expect(judge.judge('github_run_workflow')).toMatchObject({ title: 'Run a workflow', heading: 'changesThings', setting: 'asksFirst' });
  });

  it('judges a grant not brought over yet by Universe’s sorting and its headings, Run a workflow asking first', async () => {
    const sara = await withGitHub('sara');
    const judge = (await gitHubJudgeFor(sara.brickId, sara.connectionId))!;
    expect(judge.toolkit).toBe(GITHUB_ACTIONS_KEY);
    expect(judge.judge('github_run_workflow')).toMatchObject({ title: 'Run a workflow', heading: 'changesThings', setting: 'asksFirst' });
    expect(judge.judge('github_read_file')).toMatchObject({ heading: 'looksUp', setting: 'rightAway' });
    // Not in the list: the strictest heading, at its setting
    expect(judge.knows('github_delete_everything')).toBe(false);
    expect(judge.judge('github_delete_everything').heading).toBe('deletesOrSends');
    await prisma.botMcpServer.update({ where: { id: sara.serverId }, data: { changeSetting: 'asksFirst' } });
    const asks = (await gitHubJudgeFor(sara.brickId, sara.connectionId))!;
    expect(computerStops(asks, 'Nudge')).toEqual({
      read: null,
      push: "Commit files asks first for Nudge in GitHub, and a computer can't ask, so nothing was pushed. Ask your owner in chat: Commit files there shows them a card.",
      branch: "Make a branch asks first for Nudge in GitHub, and a computer can't ask, so nothing was pushed. Ask your owner in chat: Make a branch there shows them a card.",
      pullRequest: "Open a pull request asks first for Nudge in GitHub, and a computer can't ask, so no pull request was opened. Ask your owner in chat: Open a pull request there shows them a card.",
    });
    // No grant of this connection on another Brick: nothing to judge
    const omar = await withGitHub('omar');
    expect(await gitHubJudgeFor(omar.brickId, sara.connectionId)).toBeNull();
  });
});

/**
 * A ready-made App's actions on a Brick (lib/app-actions): Universe sorts each App's actions once, a Brick's grant holds them as its rows
 * with Right away, Asks first or Off per heading and per action, and the App's link refuses and hides what is Off. Against a real database
 * and a FAKE adapter (the real provider is never called). Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';

const mockUser: { current: { id: string; email?: string | null } | null } = { current: null };
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => mockUser.current) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: (email: string | null) => email === 'boss@example.test' }));

import { prisma } from '@/lib/db';
import { setAdapterForTests, type LinkAnswer, type ProviderAction, type ReadyMadeAdapter } from '@/lib/app-adapter';
import { saveReadyMadeApps } from '@/lib/app-adapter/settings';
import { createConnection, grantToBrick } from '@/lib/app-connections';
import { saveMeterSettings } from '@/lib/meter';
import { createBrick } from '@/lib/brick-create';
import { readServerTools, syncCatalog } from '@/lib/mcp-tool-policy';
import { ensureAppActionTools, actionJudgeFor, actionFingerprint, lockGrant } from '@/lib/app-actions/grant';
import { ensureAppActions, refreshAppActions, saveSorterPicks, unsortedActions, SHRINK_BELIEVED_AFTER_MS } from '@/lib/app-actions/catalog';
import { GET as getTools } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/route';
import { PATCH as patchTool } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/[toolId]/route';
import { POST as confirmTools } from '@/app/api/bots/[id]/mcp-servers/[serverId]/tools/confirm/route';
import { GET as getUnsorted, PUT as putUnsorted } from '@/app/api/app-actions/unsorted/route';
import { POST as linkApp } from '@/app/api/ready-made/link/route';
import { POST as useApp } from '@/app/api/ready-made/use/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);
// Letters and digits only, as the provider's own App slugs are: its actions start with it in upper case
const KEY = `gm${tag}`;
const U = KEY.toUpperCase();
const SERVICE_TOKEN = `service-${tag}`;
const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

const action = (name: string, tags: string[]): ProviderAction => ({ slug: `${U}_${name}`, description: `Does ${name.toLowerCase()} with Composio`, tags, version: 'v1' });
const GMAIL_LIKE = (): ProviderAction[] => [
  action('FETCH_EMAILS', ['readOnlyHint', 'openWorldHint']),
  action('LIST_LABELS', ['readOnlyHint']),
  action('ADD_LABEL_TO_EMAIL', ['updateHint']),
  action('CREATE_FILTER', ['createHint']),
  action('SEND_EMAIL', ['createHint']),
  action('DELETE_MESSAGE', ['destructiveHint']),
  action('MYSTERY', ['important']),
];

let sara = '';
let omar = '';
let boss = '';
let saraBrick = '';
const envBefore = { service: process.env.BOT_SERVICE_TOKEN, key: process.env.ENCRYPTION_KEY };
// Settings shared with the rest of the database: put back as they were, never deleted whole
// 'meter' is the key lib/meter.ts keeps its ceilings under
const SHARED_SETTINGS = ['ready-made-apps', 'meter'];
let settingsBefore: { key: string; value: Prisma.InputJsonValue; updatedById: string | null }[] = [];
const restoreSettings = async (keys: readonly string[]) => {
  await prisma.appSetting.deleteMany({ where: { key: { in: [...keys] } } });
  const kept = settingsBefore.filter((row) => keys.includes(row.key));
  if (kept.length > 0) await prisma.appSetting.createMany({ data: kept });
};

function fake(list: () => ProviderAction[] = GMAIL_LIKE) {
  const adapter = {
    startConnect: jest.fn(async () => ({ redirectUrl: 'https://connect.example/sign-in', providerAccountId: `ca_${tag}`, expiresAt: null })),
    connectionStatus: jest.fn(async (): Promise<'active' | 'pending' | 'failed'> => 'active'),
    appLink: jest.fn(async () => ({ url: `https://mcp.example/${tag}/mcp` })),
    callLink: jest.fn(
      async (_input: { url: string; message: Record<string, unknown>; sessionId: string | null }): Promise<LinkAnswer> => ({ status: 200, contentType: 'application/json', sessionId: 'mcp-1', body: '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{}"}]}}' }),
    ),
    use: jest.fn(async () => ({ ok: true, data: { done: true }, error: null, providerCallId: 'log_1' })),
    actions: jest.fn(async (_toolkit: string) => list()),
  } satisfies ReadyMadeAdapter;
  return adapter;
}

run('a ready-made App’s actions on a Brick, in a real database', () => {
  beforeAll(async () => {
    settingsBefore = (await prisma.appSetting.findMany({ where: { key: { in: SHARED_SETTINGS } } })).map((row) => ({ key: row.key, value: row.value as Prisma.InputJsonValue, updatedById: row.updatedById }));
    process.env.BOT_SERVICE_TOKEN = SERVICE_TOKEN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const person = (name: string, email?: string) => prisma.user.create({ data: { uuid: `${name}-${tag}`, email: email ?? `${name}-${tag}@example.test`, name } });
    sara = (await person('sara')).id;
    omar = (await person('omar')).id;
    boss = (await person('boss', 'boss@example.test')).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Nudge' })).id;
  });
  beforeEach(async () => {
    await saveMeterSettings({ appUseCeilingMicros: 1_000_000_000, appUseMemberCeilingMicros: 1_000_000_000 }, boss);
    await saveReadyMadeApps({ apps: { [KEY]: { name: 'Gmail', authConfigId: 'ac_1', enabled: true } } }, boss);
  });
  afterEach(async () => {
    setAdapterForTests(null);
    mockUser.current = null;
    await prisma.meterEvent.deleteMany({ where: { personId: { in: [sara, omar] } } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara, omar] } } });
    await prisma.appAction.deleteMany({ where: { toolkit: KEY } });
    await prisma.appActionCatalog.deleteMany({ where: { toolkit: KEY } });
    await restoreSettings(['ready-made-apps']);
  });
  afterAll(async () => {
    if (envBefore.service === undefined) delete process.env.BOT_SERVICE_TOKEN;
    else process.env.BOT_SERVICE_TOKEN = envBefore.service;
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = envBefore.key;
    await restoreSettings(SHARED_SETTINGS);
    await prisma.user.deleteMany({ where: { id: { in: [sara, omar, boss] } } });
    await prisma.$disconnect();
  });

  const asSara = () => (mockUser.current = { id: sara, email: `sara-${tag}@example.test` });
  const asOmar = () => (mockUser.current = { id: omar, email: `omar-${tag}@example.test` });

  async function readyMadeConnection() {
    const row = await createConnection(sara, { name: 'Gmail', serverUrl: `https://mcp.example/${tag}/mcp`, authType: 'none', authConfig: undefined, source: 'ready_made', providerToolkit: KEY, providerAccountId: `ca_${tag}` });
    await prisma.appConnection.update({ where: { id: row.id }, data: { providerConfirmedAt: new Date() } });
    return row.id;
  }

  async function granted(list?: () => ProviderAction[]) {
    const adapter = fake(list);
    setAdapterForTests(adapter);
    const connectionId = await readyMadeConnection();
    const grant = await grantToBrick(sara, connectionId, saraBrick);
    // The first read of a reader that knows App actions brings the grant over
    await readServerTools(saraBrick, grant!.id, { appActions: true });
    return { adapter, connectionId, serverId: grant!.id };
  }

  const toolsOf = async (serverId: string) => {
    asSara();
    const response = await getTools(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/tools?actions=1`), params({ id: saraBrick, serverId }));
    expect(response.status).toBe(200);
    return response.json();
  };
  const toolId = async (serverId: string, name: string) => (await prisma.botMcpTool.findFirstOrThrow({ where: { serverId, name: `${U}_${name}` } })).id;
  const patch = (serverId: string, id: string, body: unknown) =>
    asSara() &&
    patchTool(request(`/api/bots/${saraBrick}/mcp-servers/${serverId}/tools/${id}`, { method: 'PATCH', body }), params({ id: saraBrick, serverId, toolId: id }));


  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const catalogRow = () => prisma.appActionCatalog.findUniqueOrThrow({ where: { toolkit: KEY } });

  describe('the App’s list and a Brick’s grant', () => {
    it('makes the grant’s rows the App’s actions when it is granted: sorted, confirmed by Universe, under today’s defaults', async () => {
      const { adapter, serverId } = await granted();
      expect(adapter.actions).toHaveBeenCalledTimes(1);
      expect(adapter.actions).toHaveBeenCalledWith(KEY);
      const body = await toolsOf(serverId);
      expect(body).toMatchObject({ kind: 'appActions', state: 'confirmed', settings: { looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' }, truncated: false, totalSeen: null });
      const byName = Object.fromEntries(body.tools.map((tool: { name: string }) => [tool.name, tool]));
      expect(Object.keys(byName).sort()).toEqual(GMAIL_LIKE().map((entry) => entry.slug).sort());
      expect(byName[`${U}_FETCH_EMAILS`]).toMatchObject({ title: 'Fetch emails', heading: 'looksUp', suggestionSource: 'builtIn', state: 'confirmed', confirmedBy: { name: null }, setting: null, description: 'Does fetch_emails with' });
      expect(byName[`${U}_ADD_LABEL_TO_EMAIL`].heading).toBe('changesThings');
      // Creating something others may see is a change; a send and a delete, and anything not known yet, ask under the strictest heading
      expect(byName[`${U}_CREATE_FILTER`].heading).toBe('changesThings');
      expect(byName[`${U}_SEND_EMAIL`].heading).toBe('deletesOrSends');
      expect(byName[`${U}_DELETE_MESSAGE`].heading).toBe('deletesOrSends');
      expect(byName[`${U}_MYSTERY`].heading).toBe('deletesOrSends');
      expect(JSON.stringify(body)).not.toMatch(/composio/i);
    });

    it('waits on a first read for another reader that took the claim at the same moment', async () => {
      const adapter = fake();
      setAdapterForTests(adapter);
      // This process loses the claim to another reader, which holds it and reads the list a moment later
      // Kept from the moment it is scheduled, so the test always waits for it, however the read below ends
      let other: Promise<boolean> = Promise.resolve(false);
      const spy = jest
        .spyOn(prisma.appActionCatalog, 'updateMany')
        .mockImplementationOnce((async () => {
          await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: new Date(Date.now() + 120_000) } });
          other = new Promise((resolve) => setTimeout(resolve, 300)).then(() => refreshAppActions(KEY));
          return { count: 0 };
        }) as never)
        // The other reader's own claim, taken as its earlier one runs out
        .mockImplementationOnce((async (args: { data: { claimedUntil: Date } }) => {
          await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: args.data.claimedUntil } });
          return { count: 1 };
        }) as never);
      try {
        const state = await ensureAppActions(KEY, 3_000);
        expect(state?.refreshedAt).toBeInstanceOf(Date);
        expect(adapter.actions).toHaveBeenCalledTimes(1);
      } finally {
        await other;
        spy.mockRestore();
      }
    });

    it('writes nothing from a read that outlived its claim, and never clears the claim of the reader that took it over', async () => {
      const { adapter } = await granted();
      const before = await catalogRow();
      const later = new Date(Date.now() + 10 * 60_000);
      // Another reader takes the list while this one is still asking the provider (its claim ran out)
      const takeOver = () => prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: later } });
      adapter.actions.mockImplementationOnce(async () => {
        await takeOver();
        return [action('ONLY_NEW', ['readOnlyHint']), ...GMAIL_LIKE()];
      });
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(await prisma.appAction.count({ where: { toolkit: KEY, slug: `${U}_ONLY_NEW` } })).toBe(0);
      const after = await catalogRow();
      expect(after).toMatchObject({ claimedUntil: later, version: before.version, retryAfter: null });
      expect(Date.now() - after.refreshedAt!.getTime()).toBeGreaterThan(24 * 60 * 60_000);
      // A read that fails the same way sets no wait and leaves the other reader's claim
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: null } });
      adapter.actions.mockImplementationOnce(async () => {
        await takeOver();
        throw new Error('down');
      });
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(await catalogRow()).toMatchObject({ claimedUntil: later, retryAfter: null });
      // A claim that ran out with nobody taking it over (the read took longer than the claim): that read writes nothing either, list or wait
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: null } });
      // Only the clock moves (no timers are faked): the claim stays exactly as this reader set it
      jest.useFakeTimers({ now: Date.now(), doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
      try {
        const runOut = () => jest.setSystemTime(Date.now() + 7 * 60_000);
        adapter.actions.mockImplementationOnce(async () => {
          runOut();
          return [action('ONLY_NEW', ['readOnlyHint']), ...GMAIL_LIKE()];
        });
        expect(await refreshAppActions(KEY)).toBe(false);
        expect(await prisma.appAction.count({ where: { toolkit: KEY, slug: `${U}_ONLY_NEW` } })).toBe(0);
        expect((await catalogRow()).version).toBe(before.version);
        await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { claimedUntil: null } });
        adapter.actions.mockImplementationOnce(async () => {
          runOut();
          throw new Error('down');
        });
        expect(await refreshAppActions(KEY)).toBe(false);
        expect((await catalogRow()).retryAfter).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('stamps a grant with the list its rows came from, never with one a read saves in between', async () => {
      const { serverId } = await granted();
      // The grant is one version behind, and a read of the provider is saving a new action at this very moment
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { version: { increment: 1 } } });
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const saving = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "app_action_catalogs" WHERE "toolkit" = ${KEY} FOR UPDATE`;
          await tx.appAction.create({ data: { toolkit: KEY, slug: `${U}_JUST_LISTED`, title: 'Just listed', heading: 'looksUp', source: 'tags', position: 99 } });
          await tx.appActionCatalog.update({ where: { toolkit: KEY }, data: { version: { increment: 1 } } });
          locked();
          await sleep(400);
        },
        { timeout: 10_000 },
      );
      await isLocked;
      const synced = ensureAppActionTools(serverId);
      await saving;
      await synced;
      const server = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId }, select: { appActionsVersion: true, tools: { select: { name: true } } } });
      expect(server.appActionsVersion).toBe((await catalogRow()).version);
      expect(server.tools.map((tool) => tool.name)).toContain(`${U}_JUST_LISTED`);
    });

    it('does not wait on a first read when nobody reads the list (no App provider set up)', async () => {
      setAdapterForTests(null);
      const started = Date.now();
      expect((await ensureAppActions(KEY, 3_000))?.refreshedAt ?? null).toBeNull();
      expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('brings a grant made before over on its first read, keeps its heading settings, drops the meta tools, and is the same when read again or at once', async () => {
      const adapter = fake();
      setAdapterForTests(adapter);
      const connectionId = await readyMadeConnection();
      // As it was before: the provider's meta tools, one moved and confirmed by a person, and the person's own heading settings
      const old = await prisma.botMcpServer.create({ data: { botId: saraBrick, connectionId, name: 'Gmail', serverUrl: '', authType: 'none', deleteSendSetting: 'off', changeSetting: 'rightAway' } });
      await prisma.botMcpTool.createMany({
        data: [
          { serverId: old.id, name: 'COMPOSIO_SEARCH_TOOLS', fingerprint: 'f1', suggestedHeading: 'looksUp', suggestionSource: 'server' },
          { serverId: old.id, name: 'COMPOSIO_MULTI_EXECUTE_TOOL', fingerprint: 'f2', heading: 'looksUp', movedById: sara, confirmedById: sara, confirmedAt: new Date() },
        ],
      });
      // A reader that does not know App actions (today's bot server) sees the grant as it was, and nothing is judged per action
      const plain = await readServerTools(saraBrick, old.id);
      expect(plain.kind).toBe('tools');
      expect(plain.tools.map((tool) => tool.name).sort()).toEqual(['COMPOSIO_MULTI_EXECUTE_TOOL', 'COMPOSIO_SEARCH_TOOLS']);
      expect(await actionJudgeFor(saraBrick, connectionId)).toBeNull();
      expect(adapter.actions).not.toHaveBeenCalled();
      asSara();
      const plainGet = await (await getTools(request(`/api/bots/${saraBrick}/mcp-servers/${old.id}/tools`), params({ id: saraBrick, serverId: old.id }))).json();
      expect(plainGet.kind).toBe('tools');
      const [one, two, three] = await Promise.all([readServerTools(saraBrick, old.id, { appActions: true }), readServerTools(saraBrick, old.id, { appActions: true }), ensureAppActionTools(old.id)]);
      expect(three).toEqual(expect.any(Boolean));
      expect(one.tools.map((tool) => tool.name).sort()).toEqual(two.tools.map((tool) => tool.name).sort());
      // Brought over once: every reader sees the actions from now on
      const again = await readServerTools(saraBrick, old.id);
      expect(again.kind).toBe('appActions');
      expect(again.tools).toHaveLength(GMAIL_LIKE().length);
      expect(again.tools.some((tool) => tool.name.startsWith('COMPOSIO_'))).toBe(false);
      expect(again.tools.every((tool) => tool.movedBy === null && tool.state === 'confirmed')).toBe(true);
      expect(again.settings).toEqual({ looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'rightAway', deletesOrSends: 'off' });
      // A read with nothing new changes nothing
      expect((await readServerTools(saraBrick, old.id)).policyRevision).toBe(again.policyRevision);
      expect(await ensureAppActionTools(old.id)).toBe(false);
      expect(adapter.actions).toHaveBeenCalledTimes(1);
      expect((await prisma.botMcpTool.findFirstOrThrow({ where: { serverId: old.id, name: `${U}_FETCH_EMAILS` } })).fingerprint).toBe(actionFingerprint(KEY, `${U}_FETCH_EMAILS`));
    });

    it('never lets the bot server’s list of the link’s meta tools replace the actions', async () => {
      const { serverId } = await granted();
      const before = await readServerTools(saraBrick, serverId);
      const saved = await syncCatalog(saraBrick, serverId, { tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', fingerprint: 'x', suggestedHeading: 'looksUp', suggestionSource: 'server' }] });
      expect(saved).toMatchObject({ added: [], changed: [], removed: [], policyRevision: before.policyRevision });
      expect((await readServerTools(saraBrick, serverId)).tools.map((tool) => tool.name).sort()).toEqual(before.tools.map((tool) => tool.name).sort());
    });

    it('keeps the first 500 actions as rows, says the list is cut, and judges any other from the App’s list', async () => {
      const many = () => Array.from({ length: 520 }, (_, i) => action(`LOOK_${String(i).padStart(3, '0')}`, ['readOnlyHint']));
      const { serverId, connectionId } = await granted(many);
      const body = await readServerTools(saraBrick, serverId);
      expect(body.tools).toHaveLength(500);
      expect(body).toMatchObject({ truncated: true, totalSeen: 520 });
      expect(body.tools.some((tool) => tool.name === `${U}_LOOK_510`)).toBe(false);
      const judge = await actionJudgeFor(saraBrick, connectionId);
      expect(judge!.judge(`${U}_LOOK_510`)).toMatchObject({ heading: 'looksUp', setting: 'rightAway', title: 'Look 510' });
      // Never refused for being missing: a slug no list has is judged by its name, else as Deletes or sends out
      expect(judge!.judge(`${U}_SEND_IT`)).toMatchObject({ heading: 'deletesOrSends', setting: 'asksFirst' });
      expect(judge!.judge(`${U}_SOMETHING`)).toMatchObject({ heading: 'deletesOrSends', setting: 'asksFirst' });
    });

    it('reads the list again once it is a day old: new actions come, gone ones go, and a person’s own choice stays', async () => {
      let list = GMAIL_LIKE();
      const { adapter, serverId, connectionId } = await granted(() => list);
      expect((await patch(serverId, await toolId(serverId, 'FETCH_EMAILS'), { setting: 'asksFirst' })).status).toBe(200);
      expect((await patch(serverId, await toolId(serverId, 'DELETE_MESSAGE'), { setting: 'off' })).status).toBe(200);
      list = [...list.filter((entry) => !entry.slug.endsWith('_LIST_LABELS') && !entry.slug.endsWith('_DELETE_MESSAGE')), action('ARCHIVE', ['updateHint'])];
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
      await readServerTools(saraBrick, serverId);
      // The old list was used while the new one was read in the background
      await refreshAppActions(KEY);
      const body = await readServerTools(saraBrick, serverId);
      expect(adapter.actions.mock.calls.length).toBeGreaterThanOrEqual(2);
      const names = body.tools.map((tool) => tool.name);
      expect(names).toContain(`${U}_ARCHIVE`);
      expect(names).not.toContain(`${U}_LIST_LABELS`);
      expect(body.tools.find((tool) => tool.name === `${U}_FETCH_EMAILS`)?.setting).toBe('asksFirst');
      // An action the list no longer has keeps the person's choice (it may come back): still Off
      expect(body.tools.find((tool) => tool.name === `${U}_DELETE_MESSAGE`)).toMatchObject({ setting: 'off', heading: 'deletesOrSends' });
      const judge = await actionJudgeFor(saraBrick, connectionId);
      expect(judge!.judge(`${U}_DELETE_MESSAGE`).setting).toBe('off');
      // Nothing new: the next reads change nothing and stay cheap
      expect(await ensureAppActionTools(serverId)).toBe(false);
    });

    it('leaves a list as it was when the provider cannot be asked', async () => {
      let fail = false;
      const { adapter, serverId } = await granted();
      adapter.actions.mockImplementation(async () => {
        if (fail) throw new Error('down');
        return GMAIL_LIKE();
      });
      fail = true;
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: new Date(Date.now() - 25 * 60 * 60_000) } });
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(await prisma.appAction.count({ where: { toolkit: KEY } })).toBe(GMAIL_LIKE().length);
      expect((await readServerTools(saraBrick, serverId)).tools).toHaveLength(GMAIL_LIKE().length);
      // The provider is not asked again on every read while the failure is waited out
      fail = false;
      const calls = adapter.actions.mock.calls.length;
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(adapter.actions.mock.calls.length).toBe(calls);
      // Nor does a grant's first read wait for a list while a failed read is waited out (nothing would come)
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: null } });
      const started = Date.now();
      await ensureAppActions(KEY, 3_000);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(adapter.actions.mock.calls.length).toBe(calls);
      // Also in the last minutes of the wait (90 s left), which must never be taken for another reader's claim and waited out for the full 3 s
      await prisma.$executeRaw`UPDATE app_action_catalogs SET claimed_until = claimed_until - interval '210 seconds', retry_after = retry_after - interval '210 seconds' WHERE toolkit = ${KEY}`;
      const late = Date.now();
      await ensureAppActions(KEY, 3_000);
      expect(Date.now() - late).toBeLessThan(1_000);
      expect(adapter.actions.mock.calls.length).toBe(calls);
      // Once waited out, the next reader reads it
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { retryAfter: null, claimedUntil: null } });
      expect(await refreshAppActions(KEY)).toBe(true);
    });

    it('does not believe an empty or much shorter list: the actions and the choices made for them stay', async () => {
      let list = Array.from({ length: 12 }, (_, i) => action(`LOOK_${i}`, ['readOnlyHint']));
      const { serverId } = await granted(() => list);
      list = [];
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: null } });
      expect(await refreshAppActions(KEY)).toBe(false);
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { retryAfter: null } });
      list = list.concat(action('LOOK_0', ['readOnlyHint']));
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(await prisma.appAction.count({ where: { toolkit: KEY } })).toBe(12);
      expect((await readServerTools(saraBrick, serverId)).tools).toHaveLength(12);
      // When the provider keeps answering the shorter list for hours, the App really lost those actions: it is taken
      const since = (await prisma.appActionCatalog.findUniqueOrThrow({ where: { toolkit: KEY } })).shrunkSince;
      expect(since).not.toBeNull();
      // Six hours on but only the third read: one read after a long quiet gap is not enough on its own
      expect((await prisma.appActionCatalog.findUniqueOrThrow({ where: { toolkit: KEY } })).shrunkReads).toBe(2);
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { retryAfter: null, shrunkReads: 0, shrunkSince: new Date(Date.now() - SHRINK_BELIEVED_AFTER_MS - 60_000) } });
      expect(await refreshAppActions(KEY)).toBe(false);
      expect(await prisma.appAction.count({ where: { toolkit: KEY } })).toBe(12);
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { retryAfter: null } });
      expect(await refreshAppActions(KEY)).toBe(false);
      // Six hours and three reads in a row: taken
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { retryAfter: null } });
      expect(await refreshAppActions(KEY)).toBe(true);
      expect(await prisma.appAction.count({ where: { toolkit: KEY } })).toBe(1);
      expect(await prisma.appActionCatalog.findUniqueOrThrow({ where: { toolkit: KEY } })).toMatchObject({ shrunkSince: null, shrunkReads: 0 });
      expect((await readServerTools(saraBrick, serverId)).tools.map((tool) => tool.name)).toEqual([`${U}_LOOK_0`]);
    });

    it('keeps an action the provider calls old, after the others', async () => {
      const { serverId } = await granted(() => [{ ...action('OLD_FETCH', ['readOnlyHint']), deprecated: true }, ...GMAIL_LIKE()]);
      const kept = await prisma.appAction.findMany({ where: { toolkit: KEY }, orderBy: { position: 'asc' }, select: { slug: true } });
      expect(kept[kept.length - 1].slug).toBe(`${U}_OLD_FETCH`);
      expect((await readServerTools(saraBrick, serverId)).tools.map((tool) => tool.name)).toContain(`${U}_OLD_FETCH`);
    });
  });

  describe('an action’s own choice', () => {
    it('is the owner’s to set, moves the revision, and follows the heading again when cleared', async () => {
      const { serverId } = await granted();
      const send = await toolId(serverId, 'SEND_EMAIL');
      const before = await toolsOf(serverId);
      const set = await patch(serverId, send, { setting: 'off' });
      expect(set.status).toBe(200);
      const after = await set.json();
      expect(after.policyRevision).toBe(before.policyRevision + 1);
      expect(after.tools.find((tool: { id: string }) => tool.id === send).setting).toBe('off');
      // The same choice again changes nothing
      expect((await (await patch(serverId, send, { setting: 'off' })).json()).policyRevision).toBe(after.policyRevision);
      const cleared = await (await patch(serverId, send, { setting: null })).json();
      expect(cleared.tools.find((tool: { id: string }) => tool.id === send).setting).toBeNull();
      expect(cleared.policyRevision).toBe(after.policyRevision + 1);
      // Someone else's Brick does not exist for them
      asOmar();
      expect((await patchTool(request('/x', { method: 'PATCH', body: { setting: 'rightAway' } }), params({ id: saraBrick, serverId, toolId: send }))).status).toBe(404);
      asSara();
      expect((await patch(serverId, send, { setting: 'sometimes' })).status).toBe(400);
      expect((await patch(serverId, 'nope', { setting: 'off' })).status).toBe(404);
    });

    it('lets the bot server’s list wait while the grant is being brought over, and reads a grant’s kind and rows from one moment', async () => {
      const adapter = fake();
      setAdapterForTests(adapter);
      const connectionId = await readyMadeConnection();
      const old = await prisma.botMcpServer.create({ data: { botId: saraBrick, connectionId, name: 'Gmail', serverUrl: '', authType: 'none' } });
      // The bot server sends the list the grant already has: nothing on the grant's row would change, so only holding the grant makes it wait
      await prisma.botMcpTool.create({ data: { serverId: old.id, name: 'COMPOSIO_SEARCH_TOOLS', fingerprint: 'f', suggestedHeading: 'looksUp', suggestionSource: 'server' } });
      let release!: () => void;
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holding = prisma.$transaction(
        async (tx) => {
          await lockGrant(tx, old.id);
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 10_000 },
      );
      await isLocked;
      let done = false;
      const put = syncCatalog(saraBrick, old.id, { tools: [{ name: 'COMPOSIO_SEARCH_TOOLS', fingerprint: 'f', suggestedHeading: 'looksUp', suggestionSource: 'server' }] }).then((result) => {
        done = true;
        return result;
      });
      try {
        await sleep(300);
        expect(done).toBe(false);
      } finally {
        release();
        await holding;
        await put;
      }
      // Both at once end the same way whichever goes first: the App's actions, and nothing of the link's meta tools
      await Promise.all([
        syncCatalog(saraBrick, old.id, { tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', fingerprint: 'g', suggestedHeading: 'looksUp', suggestionSource: 'server' }] }),
        readServerTools(saraBrick, old.id, { appActions: true }),
      ]);
      await readServerTools(saraBrick, old.id, { appActions: true });
      const spy = jest.spyOn(prisma, '$transaction');
      try {
        const body = await readServerTools(saraBrick, old.id);
        expect(body.kind).toBe('appActions');
        expect(body.tools.some((tool) => tool.name.startsWith('COMPOSIO_'))).toBe(false);
        expect(spy).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
      } finally {
        spy.mockRestore();
      }
    });

    it('never brings a grant over from a choice: a refused one leaves the grant exactly as it was', async () => {
      const adapter = fake();
      setAdapterForTests(adapter);
      const connectionId = await readyMadeConnection();
      const old = await prisma.botMcpServer.create({ data: { botId: saraBrick, connectionId, name: 'Gmail', serverUrl: '', authType: 'none' } });
      const meta = await prisma.botMcpTool.create({ data: { serverId: old.id, name: 'COMPOSIO_MULTI_EXECUTE_TOOL', fingerprint: 'f2', heading: 'looksUp', confirmedAt: new Date() } });
      expect(await refreshAppActions(KEY)).toBe(true);
      expect((await patch(old.id, 'nope', { setting: 'off' })).status).toBe(409);
      expect((await patch(old.id, meta.id, { setting: 'off' })).status).toBe(409);
      const after = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: old.id }, select: { appActionsVersion: true, policyRevision: true, tools: { select: { name: true, setting: true } } } });
      expect(after).toMatchObject({ appActionsVersion: null, policyRevision: old.policyRevision, tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', setting: null }] });
    });

    it('keeps a person’s choice when the App spells an action another way: one row, under the new spelling', async () => {
      let list = GMAIL_LIKE();
      const { serverId, connectionId } = await granted(() => list);
      expect((await patch(serverId, await toolId(serverId, 'DELETE_MESSAGE'), { setting: 'off' })).status).toBe(200);
      list = list.map((entry) => (entry.slug === `${U}_DELETE_MESSAGE` ? { ...entry, slug: `${U}_DELETE-MESSAGE` } : entry));
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: null } });
      expect(await refreshAppActions(KEY)).toBe(true);
      const rows = (await readServerTools(saraBrick, serverId)).tools.filter((tool) => tool.name.replace('-', '_') === `${U}_DELETE_MESSAGE`);
      expect(rows).toEqual([expect.objectContaining({ name: `${U}_DELETE-MESSAGE`, setting: 'off', heading: 'deletesOrSends' })]);
      const judge = await actionJudgeFor(saraBrick, connectionId);
      expect(judge!.judge(`${U}_DELETE-MESSAGE`).setting).toBe('off');
      expect(judge!.judge(`${U}_delete_message`.toLowerCase()).setting).toBe('off');
    });

    it('takes an action the App lists under two spellings as one, and two rows for one action never lose the stricter choice', async () => {
      const { serverId, connectionId } = await granted(() => [...GMAIL_LIKE(), { ...action('DELETE_MESSAGE', ['readOnlyHint']), slug: `${U}_DELETE-MESSAGE` }]);
      const rows = (await readServerTools(saraBrick, serverId)).tools.filter((tool) => tool.name.replace('-', '_') === `${U}_DELETE_MESSAGE`);
      // The first spelling in the App's order names it, under the stricter heading of the two
      expect(rows).toEqual([expect.objectContaining({ name: `${U}_DELETE_MESSAGE`, heading: 'deletesOrSends' })]);
      // A second row for the same action (made before this was one row): the person's Off is on it, not on the row the App's spelling names
      await prisma.botMcpTool.create({ data: { serverId, name: `${U}_delete-message`, fingerprint: 'x', heading: 'looksUp', suggestedHeading: 'looksUp', suggestionSource: 'builtIn', confirmedAt: new Date(), setting: 'off' } });
      const versionNow = (await catalogRow()).version;
      const rowsOf = async (key: string) =>
        (await prisma.botMcpTool.findMany({ where: { serverId }, select: { name: true, setting: true } })).filter((tool) => tool.name.toUpperCase().replace(/-/g, '_') === key);
      // Judged at once by the strictest of the two, and made one row with the person's Off, with nothing new in the App's list
      const judge = await actionJudgeFor(saraBrick, connectionId);
      for (const spelling of [`${U}_DELETE_MESSAGE`, `${U}_DELETE-MESSAGE`, `${U}_delete-message`]) expect(judge!.judge(spelling).setting).toBe('off');
      expect(await rowsOf(`${U}_DELETE_MESSAGE`)).toEqual([{ name: `${U}_DELETE_MESSAGE`, setting: 'off' }]);
      // The same for an action the App's list no longer has, found when the Brick's tools are read: one row, the stricter choice kept
      await prisma.botMcpTool.createMany({
        data: [
          { serverId, name: `${U}_GONE_ONE`, fingerprint: 'g1', heading: 'looksUp', confirmedAt: new Date(), setting: 'rightAway' },
          { serverId, name: `${U}_gone-one`, fingerprint: 'g2', heading: 'looksUp', confirmedAt: new Date(), setting: 'off' },
        ],
      });
      const gone = (await readServerTools(saraBrick, serverId)).tools.filter((tool) => tool.name.toUpperCase().replace('-', '_') === `${U}_GONE_ONE`);
      expect(gone).toEqual([expect.objectContaining({ setting: 'off' })]);
      expect((await catalogRow()).version).toBe(versionNow);
      // And when the App's list changes, the sync does the same
      await prisma.botMcpTool.create({ data: { serverId, name: `${U}_fetch-emails`, fingerprint: 'f9', heading: 'looksUp', confirmedAt: new Date(), setting: 'asksFirst' } });
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { version: { increment: 1 } } });
      expect(await ensureAppActionTools(serverId)).toBe(true);
      expect(await rowsOf(`${U}_FETCH_EMAILS`)).toEqual([{ name: `${U}_FETCH_EMAILS`, setting: 'asksFirst' }]);
    });

    it('judges two rows for one action by the stricter choice even when they cannot be made one yet', async () => {
      const { serverId, connectionId } = await granted();
      await patch(serverId, await toolId(serverId, 'DELETE_MESSAGE'), { setting: 'off' });
      // A laxer second row for the same action, read after the person's Off
      await prisma.botMcpTool.create({ data: { serverId, name: `${U}_delete-message`, fingerprint: 'x', heading: 'looksUp', confirmedAt: new Date(), setting: 'rightAway' } });
      // The sync that would make them one row cannot run now (its transaction gives up): the judge still holds the Off
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async () => false) as never);
      try {
        const judge = await actionJudgeFor(saraBrick, connectionId);
        expect(spy).toHaveBeenCalledTimes(1);
        for (const spelling of [`${U}_DELETE_MESSAGE`, `${U}_delete-message`]) expect(judge!.judge(spelling)).toMatchObject({ setting: 'off', heading: 'deletesOrSends' });
      } finally {
        spy.mockRestore();
      }
      expect((await prisma.botMcpTool.findMany({ where: { serverId } })).filter((tool) => tool.name.toUpperCase().replace(/-/g, '_') === `${U}_DELETE_MESSAGE`)).toHaveLength(2);
    });

    it('never moves an App’s action to another heading, and has nothing to confirm', async () => {
      const { serverId } = await granted();
      const send = await toolId(serverId, 'SEND_EMAIL');
      const moved = await patch(serverId, send, { heading: 'looksUp' });
      expect(moved.status).toBe(409);
      expect((await prisma.botMcpTool.findUniqueOrThrow({ where: { id: send } })).heading).toBe('deletesOrSends');
      const before = await readServerTools(saraBrick, serverId);
      asSara();
      const confirmed = await confirmTools(request('/x', { method: 'POST', body: {} }), params({ id: saraBrick, serverId }));
      expect(confirmed.status).toBe(200);
      expect((await confirmed.json()).policyRevision).toBe(before.policyRevision);
    });

    it('is refused on an App that is not a ready-made one, which keeps its tools as they are', async () => {
      setAdapterForTests(fake());
      const linked = await createConnection(sara, { name: 'Mine', serverUrl: `https://mine.example/${tag}/mcp`, authType: 'none', authConfig: undefined, source: 'link' });
      const grant = await grantToBrick(sara, linked.id, saraBrick);
      const row = await prisma.botMcpTool.create({ data: { serverId: grant!.id, name: 'my_tool', fingerprint: 'f', heading: 'looksUp', confirmedAt: new Date() } });
      const body = await readServerTools(saraBrick, grant!.id);
      expect(body.kind).toBe('tools');
      expect(body.tools.map((tool) => tool.name)).toEqual(['my_tool']);
      asSara();
      expect((await patch(grant!.id, row.id, { setting: 'off' })).status).toBe(409);
    });

    it('leaves GitHub as agreed: its own kind of grant, changes and sends right away', async () => {
      setAdapterForTests(fake());
      const github = await createConnection(sara, { name: 'GitHub', serverUrl: 'https://api.github.com', authType: 'none', authConfig: undefined, source: 'github' });
      const grant = await grantToBrick(sara, github.id, saraBrick);
      const body = await readServerTools(saraBrick, grant!.id);
      expect(body.kind).toBe('tools');
      expect(body.settings).toMatchObject({ changesThings: 'rightAway', deletesOrSends: 'rightAway' });
    });
  });

  describe('the sorter', () => {
    it('gives the bot server what nothing sorted yet and takes its picks, never looser than the rules allow', async () => {
      const { serverId } = await granted(() => [...GMAIL_LIKE(), action('MAKE_THING', [])]);
      expect((await getUnsorted(request('/api/app-actions/unsorted'))).status).toBe(401);
      const unsorted = await (await getUnsorted(request('/api/app-actions/unsorted?limit=60', { token: SERVICE_TOKEN }))).json();
      const mine = unsorted.actions.filter((entry: { toolkit: string }) => entry.toolkit === KEY);
      expect(mine.map((entry: { slug: string }) => entry.slug).sort()).toEqual([`${U}_MAKE_THING`, `${U}_MYSTERY`]);
      expect(mine[0]).toEqual({ toolkit: KEY, slug: expect.any(String), title: expect.any(String), description: expect.any(String) });
      const before = await readServerTools(saraBrick, serverId);
      const put = await putUnsorted(
        request('/api/app-actions/unsorted', {
          method: 'PUT',
          token: SERVICE_TOKEN,
          body: { actions: [{ toolkit: KEY, slug: `${U}_MYSTERY`, heading: 'looksUp' }, { toolkit: KEY, slug: `${U}_MAKE_THING`, heading: 'makesNew' }, { toolkit: KEY, slug: `${U}_SEND_EMAIL`, heading: 'looksUp' }] },
        }),
      );
      expect(await put.json()).toEqual({ sorted: 2 });
      const after = await readServerTools(saraBrick, serverId);
      const headingOf = (name: string) => after.tools.find((tool) => tool.name === `${U}_${name}`)?.heading;
      expect(headingOf('MYSTERY')).toBe('looksUp');
      // Makes new things only for what Universe knows stays private
      expect(headingOf('MAKE_THING')).toBe('changesThings');
      // Sorted by its name: the sorter's pick is not taken
      expect(headingOf('SEND_EMAIL')).toBe('deletesOrSends');
      expect(after.policyRevision).toBeGreaterThan(before.policyRevision);
      // A later read of the list keeps the sorter's answer while the provider still gives no tag
      await prisma.appActionCatalog.update({ where: { toolkit: KEY }, data: { refreshedAt: null } });
      await refreshAppActions(KEY);
      expect((await prisma.appAction.findFirstOrThrow({ where: { toolkit: KEY, slug: `${U}_MYSTERY` } })).heading).toBe('looksUp');
      expect((await putUnsorted(request('/x', { method: 'PUT', token: SERVICE_TOKEN, body: { actions: [{ toolkit: KEY, slug: 'x', heading: 'maybe' }] } }))).status).toBe(400);
    });

    it('hands out unsorted actions without waiting on a sorter answer being saved for some of them', async () => {
      await granted(() => [...GMAIL_LIKE(), action('MAKE_THING', [])]);
      let release!: () => void;
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // The sorter's answer for MYSTERY is being saved right now
      const saving = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1 AS one FROM "app_actions" WHERE "toolkit" = ${KEY} AND "slug" = ${`${U}_MYSTERY`} FOR UPDATE`;
          locked();
          await new Promise<void>((resolve) => (release = resolve));
        },
        { timeout: 10_000 },
      );
      await isLocked;
      const timer = setTimeout(() => release(), 2_000);
      try {
        const started = Date.now();
        const handed = (await unsortedActions(60)).filter((entry) => entry.toolkit === KEY).map((entry) => entry.slug);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(handed).toEqual([`${U}_MAKE_THING`]);
      } finally {
        clearTimeout(timer);
        release();
        await saving;
      }
    });

    it('saves the sorter’s picks together with the version that makes grants follow them, or neither', async () => {
      await granted();
      const version = (await catalogRow()).version;
      const real = prisma.$transaction.bind(prisma) as (fn: (tx: object) => Promise<unknown>, options?: object) => Promise<unknown>;
      // The version cannot be written this time
      const spy = jest.spyOn(prisma, '$transaction').mockImplementationOnce(((fn: (tx: object) => Promise<unknown>, options?: object) =>
        real(
          (tx) =>
            fn(
              new Proxy(tx, {
                get: (target, key) => {
                  if (key === 'appActionCatalog') return { updateMany: async () => Promise.reject(new Error('down')) };
                  const value = Reflect.get(target, key);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            ),
          options,
        )) as never);
      try {
        await expect(saveSorterPicks([{ toolkit: KEY, slug: `${U}_MYSTERY`, heading: 'looksUp' }])).rejects.toThrow('down');
      } finally {
        spy.mockRestore();
      }
      expect(await prisma.appAction.findFirstOrThrow({ where: { toolkit: KEY, slug: `${U}_MYSTERY` } })).toMatchObject({ source: 'fallback', heading: 'deletesOrSends' });
      expect((await catalogRow()).version).toBe(version);
      // Asked again, the pick lands with its version
      expect(await saveSorterPicks([{ toolkit: KEY, slug: `${U}_MYSTERY`, heading: 'looksUp' }])).toBe(1);
      expect((await catalogRow()).version).toBe(version + 1);
    });
  });

  describe('the App’s link', () => {
    const link = (serverId: string, message: Record<string, unknown>, callId?: string) =>
      linkApp(request('/api/ready-made/link', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, message, ...(callId ? { callId } : {}) } }));
    const batch = (...slugs: string[]) => ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: slugs.map((slug) => ({ tool_slug: `${U}_${slug}`, arguments: {} })) } } });

    it('runs nothing of a batch that holds an action that is Off, counts nothing, and says which', async () => {
      const { adapter, serverId } = await granted();
      expect((await patch(serverId, await toolId(serverId, 'DELETE_MESSAGE'), { setting: 'off' })).status).toBe(200);
      const response = await link(serverId, batch('FETCH_EMAILS', 'DELETE_MESSAGE'), `call-${randomUUID()}`);
      expect(response.status).toBe(200);
      const answer = JSON.parse((await response.json()).body);
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content[0].text).toContain('Delete message is off for Nudge in Gmail. Nothing in this request was done.');
      expect(adapter.callLink).not.toHaveBeenCalled();
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
      // A whole heading set to Off holds the same way, and a batch with nothing Off goes through
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { deleteSendSetting: 'off' } });
      const sent = JSON.parse((await (await link(serverId, batch('SEND_EMAIL'), `call-${randomUUID()}`)).json()).body);
      expect(sent.result.content[0].text).toContain('Send email is off');
      expect((await link(serverId, batch('FETCH_EMAILS', 'ADD_LABEL_TO_EMAIL'), `call-${randomUUID()}`)).status).toBe(200);
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
    });

    it('takes Off actions out of what the App lists and looks up, and leaves the rest as it came', async () => {
      const { adapter, serverId } = await granted();
      await patch(serverId, await toolId(serverId, 'DELETE_MESSAGE'), { setting: 'off' });
      const found = { results: [{ primary_tool_slugs: [`${U}_FETCH_EMAILS`, `${U}_DELETE_MESSAGE`, `${U}_delete_message`.toLowerCase()] }], tool_schemas: { [`${U}_DELETE_MESSAGE`]: {}, [`${U}_SEND_EMAIL`]: {} } };
      adapter.callLink.mockImplementation(async ({ message }) => ({
        status: 200,
        contentType: 'application/json',
        sessionId: 'mcp-1',
        body: JSON.stringify(
          message.method === 'tools/list'
            ? { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'COMPOSIO_SEARCH_TOOLS' }, { name: `${U}_DELETE_MESSAGE` }] } }
            : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(found) }] } },
        ),
      }));
      const search = await link(serverId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_SEARCH_TOOLS', arguments: { queries: ['clean my inbox'] } } }, `call-${randomUUID()}`);
      const text = JSON.parse(JSON.parse((await search.json()).body).result.content[0].text);
      expect(text).toEqual({ results: [{ primary_tool_slugs: [`${U}_FETCH_EMAILS`] }], tool_schemas: { [`${U}_SEND_EMAIL`]: {} } });
      const listed = JSON.parse((await (await link(serverId, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).body);
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).not.toContain(`${U}_DELETE_MESSAGE`);
    });

    it('judges a batch it cannot read, and any other tool of the link, as an action the list does not have', async () => {
      const { adapter, serverId } = await granted();
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { deleteSendSetting: 'off' } });
      const odd = [
        { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: 'all of them' } },
        { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ slug: `${U}_FETCH_EMAILS` }] } },
        { name: 'COMPOSIO_SOMETHING_NEW', arguments: {} },
      ];
      for (const params of odd) {
        const answer = JSON.parse((await (await link(serverId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params }, `call-${randomUUID()}`)).json()).body);
        expect(answer.result.isError).toBe(true);
        expect(answer.result.content[0].text).toContain('Nothing in this request was done.');
      }
      expect(adapter.callLink).not.toHaveBeenCalled();
      // The link's search still runs: it runs no action
      expect((await link(serverId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'COMPOSIO_SEARCH_TOOLS', arguments: {} } }, `call-${randomUUID()}`)).status).toBe(200);
      expect(adapter.callLink).toHaveBeenCalledTimes(1);
    });

    it('refuses a single use of an action that is Off and asks nothing of the App', async () => {
      const { adapter, serverId } = await granted();
      await patch(serverId, await toolId(serverId, 'SEND_EMAIL'), { setting: 'off' });
      const used = await useApp(request('/api/ready-made/use', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, tool: `${U}_SEND_EMAIL`, arguments: {}, callId: `call-${randomUUID()}` } }));
      const body = await used.json();
      expect(JSON.stringify(body)).toContain('Send email is off for Nudge in Gmail');
      // Nor does a single use ever reach the provider's own sandbox
      const sandbox = await useApp(request('/api/ready-made/use', { method: 'POST', token: SERVICE_TOKEN, body: { botId: saraBrick, serverId, requesterKey: `sara-${tag}`, tool: 'COMPOSIO_REMOTE_WORKBENCH', arguments: {}, callId: `call-${randomUUID()}` } }));
      expect(JSON.stringify(await sandbox.json())).toContain('does not run code itself');
      expect(adapter.use).not.toHaveBeenCalled();
      expect(await prisma.meterEvent.count({ where: { personId: sara, kind: 'app_use' } })).toBe(0);
    });
  });
});

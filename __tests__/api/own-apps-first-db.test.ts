/**
 * A person's own copy of an App comes first (Khalid, 26 Nov 2026): their own App on their Brick is sorted and confirmed by Universe with
 * no review, the bot server is told which ready-made App gives way to their own copy, and Instant neither offers nor runs an App they have
 * their own copy of. Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { createConnection, grantToBrick } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';
import { moveTool, readServerTools, syncCatalog } from '@/lib/mcp-tool-policy';
import { brickApps } from '@/lib/instant/asker';
import { GET as listServers } from '@/app/api/bots/[id]/mcp-servers/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const tag = randomUUID().replace(/-/g, '').slice(0, 8);
const ADMIN = `admin-${tag}`;
const envBefore = { admin: process.env.ADMIN_API_TOKEN, key: process.env.ENCRYPTION_KEY };

let sara = '';
let saraBrick = '';

run('a person’s own copy of an App comes first, in a real database', () => {
  beforeAll(async () => {
    process.env.ADMIN_API_TOKEN = ADMIN;
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    sara = (await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'sara' } })).id;
    saraBrick = (await createBrick({ ownerId: sara, name: 'Nudge' })).id;
  });
  afterEach(async () => {
    await prisma.appConnection.deleteMany({ where: { ownerId: sara } });
  });
  afterAll(async () => {
    if (envBefore.admin === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = envBefore.admin;
    if (envBefore.key === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = envBefore.key;
    await prisma.user.deleteMany({ where: { id: sara } });
    await prisma.$disconnect();
  });

  /** Sara's own App added by its link, given to her Brick. */
  async function ownApp(name = 'Exa', serverUrl = 'https://mcp.exa.ai/mcp') {
    const connection = await createConnection(sara, { name, serverUrl, authType: 'none', authConfig: undefined, source: 'link' });
    const grant = await grantToBrick(sara, connection.id, saraBrick);
    return grant!.id;
  }

  /** Sara's ready-made copy of an App, given to her Brick (the rows only: no provider is asked). */
  async function readyMade(toolkit = 'exa', name = 'Exa') {
    const connection = await prisma.appConnection.create({ data: { ownerId: sara, name, serverUrl: `https://ready.example/${tag}/${toolkit}`, source: 'ready_made', providerToolkit: toolkit, providerAccountId: `ca_${toolkit}`, providerConfirmedAt: new Date() } });
    const grant = await prisma.botMcpServer.create({ data: { botId: saraBrick, name, serverUrl: '', authType: 'none', connectionId: connection.id } });
    return grant.id;
  }

  const tool = (name: string, fingerprint: string, suggestedHeading?: 'looksUp' | 'makesNew' | 'changesThings' | 'deletesOrSends', suggestionSource: 'server' | 'description' = 'server') =>
    suggestedHeading ? { name, fingerprint, suggestedHeading, suggestionSource } : { name, fingerprint };

  describe('their own App’s tools are sorted and confirmed by Universe', () => {
    it('confirms every tool the bot server reads, by the rules of #1042: the name first, then the suggestion, and nothing suggested yet is the strictest', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, {
        tools: [tool('web_search_exa', 'f1', 'looksUp'), tool('send_report', 'f2', 'looksUp', 'description'), tool('make_image', 'f3', 'makesNew', 'description'), tool('crawl', 'f4')],
      });
      expect(synced.state).toBe('confirmed');
      const byName = Object.fromEntries(synced.tools.map((entry) => [entry.name, entry]));
      expect(byName.web_search_exa).toMatchObject({ heading: 'looksUp', state: 'confirmed', confirmedBy: { name: null } });
      expect(byName.send_report.heading).toBe('deletesOrSends');
      expect(byName.make_image.heading).toBe('changesThings');
      expect(byName.crawl.heading).toBe('deletesOrSends');
      // The heading settings a new grant starts with: a search runs right away
      expect(synced.settings).toEqual({ looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' });
    });

    it('sorts a tool again when its suggestion comes later, and a tool that changed like a new one, with the policy revision moved each time', async () => {
      const serverId = await ownApp();
      const first = await syncCatalog(saraBrick, serverId, { tools: [tool('crawl', 'f1')] });
      expect(first.tools[0]).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed' });
      const later = await syncCatalog(saraBrick, serverId, { tools: [tool('crawl', 'f1', 'looksUp')] });
      expect(later.tools[0]).toMatchObject({ heading: 'looksUp', state: 'confirmed' });
      expect(later.policyRevision).toBeGreaterThan(first.policyRevision);
      const changed = await syncCatalog(saraBrick, serverId, { tools: [tool('crawl', 'f2', 'changesThings')] });
      expect(changed.tools[0]).toMatchObject({ heading: 'changesThings', state: 'confirmed' });
      expect(changed.policyRevision).toBeGreaterThan(later.policyRevision);
    });

    it('never touches what a person decided: a tool they moved keeps their heading through later reads', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('crawl', 'f1', 'looksUp')] });
      await moveTool(saraBrick, serverId, synced.tools[0].id, 'changesThings', sara);
      const again = await syncCatalog(saraBrick, serverId, { tools: [tool('crawl', 'f1', 'deletesOrSends')] });
      expect(again.tools[0]).toMatchObject({ heading: 'changesThings', state: 'confirmed', movedBy: { name: 'sara' } });
    });

    it('brings a grant whose tools were waiting before this up to date when it is read', async () => {
      const serverId = await ownApp();
      await prisma.botMcpTool.create({ data: { serverId, name: 'web_search_exa', fingerprint: 'f1', suggestedHeading: 'looksUp', suggestionSource: 'server' } });
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { legacyText: true } });
      const read = await readServerTools(saraBrick, serverId);
      expect(read.state).toBe('confirmed');
      expect(read.tools[0]).toMatchObject({ heading: 'looksUp', state: 'confirmed' });
      // Read again with nothing new: nothing is written
      expect((await readServerTools(saraBrick, serverId)).policyRevision).toBe(read.policyRevision);
    });

    it('leaves a ready-made App’s tools as they were: only the person’s own App is confirmed by Universe', async () => {
      const serverId = await readyMade();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('COMPOSIO_SEARCH_TOOLS', 'f1', 'looksUp')] });
      expect(synced.tools[0].state).toBe('notConfirmedYet');
    });
  });

  describe('the bot server is told which ready-made App gives way to the person’s own copy', () => {
    const list = async () => {
      const response = await listServers(new NextRequest(`http://localhost/api/bots/${saraBrick}/mcp-servers`, { headers: { authorization: `Bearer ${ADMIN}` } }), { params: Promise.resolve({ id: saraBrick }) });
      expect(response.status).toBe(200);
      return (await response.json()) as { id: string; ownCopyServerId: string | null }[];
    };

    it('names the own copy on the ready-made row while it is switched on, and nothing once it is off', async () => {
      const ready = await readyMade('exa', 'Exa');
      const other = await readyMade('gmail', 'Gmail');
      const own = await ownApp('My search', 'https://mcp.exa.ai/mcp');
      const rows = await list();
      expect(rows.find((row) => row.id === ready)?.ownCopyServerId).toBe(own);
      expect(rows.find((row) => row.id === other)?.ownCopyServerId).toBeNull();
      expect(rows.find((row) => row.id === own)?.ownCopyServerId).toBeNull();
      await prisma.botMcpServer.update({ where: { id: own }, data: { enabled: false } });
      expect((await list()).find((row) => row.id === ready)?.ownCopyServerId).toBeNull();
    });
  });

  describe('Instant', () => {
    it('neither offers nor runs an App the Brick has the person’s own copy of, switched on', async () => {
      await readyMade('exa', 'Exa');
      await readyMade('tavily', 'Tavily');
      expect([...(await brickApps(saraBrick))].sort()).toEqual(['exa', 'tavily']);
      const own = await ownApp('Exa', 'https://example.org/my-exa');
      expect([...(await brickApps(saraBrick))]).toEqual(['tavily']);
      await prisma.botMcpServer.update({ where: { id: own }, data: { enabled: false } });
      expect([...(await brickApps(saraBrick))].sort()).toEqual(['exa', 'tavily']);
    });
  });
});

/**
 * A person's own copy of an App comes first (Khalid, 26 Nov 2026): their own App on their Brick is sorted and confirmed by Universe with
 * no review, the bot server is told which ready-made App gives way to their own copy, and Instant neither offers nor runs an App they have
 * their own copy of. Against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));

import { prisma } from '@/lib/db';
import { checkAppUse, createConnection, grantToBrick } from '@/lib/app-connections';
import { createBrick } from '@/lib/brick-create';
import { moveTool, readServerTools, saveServerSettings, syncCatalog } from '@/lib/mcp-tool-policy';
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
      const read = await readServerTools(saraBrick, serverId);
      expect(read.state).toBe('confirmed');
      expect(read.tools[0]).toMatchObject({ heading: 'looksUp', state: 'confirmed' });
      // Read again with nothing new: nothing is written
      expect((await readServerTools(saraBrick, serverId)).policyRevision).toBe(read.policyRevision);
    });

    it('leaves a server that still works in text as it was: nothing is confirmed under the person', async () => {
      const serverId = await ownApp();
      await prisma.botMcpTool.create({ data: { serverId, name: 'send_report', fingerprint: 'f1', suggestedHeading: 'looksUp', suggestionSource: 'server' } });
      await prisma.botMcpServer.update({ where: { id: serverId }, data: { legacyText: true } });
      const read = await readServerTools(saraBrick, serverId);
      expect(read.state).toBe('notCheckedYet');
      expect(read.tools[0].state).toBe('notConfirmedYet');
    });

    it('keeps a moved tool’s heading when the tool changes, never looser than the rule for its new version', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f1', 'looksUp'), tool('notes', 'g1', 'looksUp')] });
      const byName = Object.fromEntries(synced.tools.map((entry) => [entry.name, entry.id]));
      await moveTool(saraBrick, serverId, byName.query, 'deletesOrSends', sara);
      await moveTool(saraBrick, serverId, byName.notes, 'makesNew', sara);
      const changed = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'looksUp'), tool('notes', 'g2', 'changesThings')] });
      const after = Object.fromEntries(changed.tools.map((entry) => [entry.name, entry]));
      expect(after.query).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed', movedBy: { name: 'sara' } });
      expect(after.notes).toMatchObject({ heading: 'changesThings', state: 'confirmed', movedBy: { name: 'sara' } });
    });

    it('puts a moved tool that changed with no suggestion yet under the strictest heading, and brings the person’s heading back when the suggestion comes', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f1', 'looksUp'), tool('notes', 'g1', 'looksUp'), tool('sendNote', 'h1', 'looksUp')] });
      const byName = Object.fromEntries(synced.tools.map((entry) => [entry.name, entry.id]));
      await moveTool(saraBrick, serverId, byName.query, 'makesNew', sara);
      await moveTool(saraBrick, serverId, byName.notes, 'makesNew', sara);
      await moveTool(saraBrick, serverId, byName.sendNote, 'makesNew', sara);
      const revisionOf = async () => (await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } })).policyRevision;
      // Changed, and the bot server has no suggestion for the new version yet: nothing is known of it, so it waits under the strictest heading
      const changed = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2'), tool('notes', 'g2'), tool('sendNote', 'h2')] });
      let after = Object.fromEntries(changed.tools.map((entry) => [entry.name, entry]));
      for (const name of ['query', 'notes', 'sendNote']) expect(after[name]).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed', movedBy: { name: 'sara' } });
      const revision = await revisionOf();
      // The suggestions come later on the same version: the person's own heading comes back where the rule allows it, never looser
      const later = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'looksUp'), tool('notes', 'g2', 'changesThings'), tool('sendNote', 'h2', 'looksUp')] });
      after = Object.fromEntries(later.tools.map((entry) => [entry.name, entry]));
      expect(after.query).toMatchObject({ heading: 'makesNew', state: 'confirmed', movedBy: { name: 'sara' } });
      expect(after.notes).toMatchObject({ heading: 'changesThings', state: 'confirmed', movedBy: { name: 'sara' } });
      // A send by its name stays one, whatever was suggested
      expect(after.sendNote).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed', movedBy: { name: 'sara' } });
      expect(await revisionOf()).toBeGreaterThan(revision);
      // A stricter suggestion and then a looser one again: the person's heading comes back each time, it is never worn down
      await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'deletesOrSends'), tool('notes', 'g2', 'changesThings'), tool('sendNote', 'h2', 'looksUp')] });
      const back = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'looksUp'), tool('notes', 'g2', 'changesThings'), tool('sendNote', 'h2', 'looksUp')] });
      expect(back.tools.find((entry) => entry.name === 'query')).toMatchObject({ heading: 'makesNew', movedBy: { name: 'sara' } });
      // Reading the same list again writes nothing
      const settled = await revisionOf();
      await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'looksUp'), tool('notes', 'g2', 'changesThings'), tool('sendNote', 'h2', 'looksUp')] });
      expect(await revisionOf()).toBe(settled);
      // A move after that is the person's again: confirmed by them, and later suggestions no longer touch it
      await moveTool(saraBrick, serverId, byName.query, 'changesThings', sara);
      const mine = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'deletesOrSends'), tool('notes', 'g2', 'changesThings'), tool('sendNote', 'h2', 'looksUp')] });
      expect(mine.tools.find((entry) => entry.name === 'query')).toMatchObject({ heading: 'changesThings', confirmedBy: { name: 'sara' }, movedBy: { name: 'sara' } });
    });

    it('keeps a tool the person moved under a heading set Off off, whatever Universe’s rule for its new version or a later suggestion says', async () => {
      const serverId = await ownApp();
      await saveServerSettings(saraBrick, serverId, { changesThings: 'off' });
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f1', 'looksUp'), tool('postNote', 'g1', 'looksUp'), tool('sendNote', 'h1', 'looksUp')] });
      const byName = Object.fromEntries(synced.tools.map((entry) => [entry.name, entry.id]));
      for (const id of Object.values(byName)) await moveTool(saraBrick, serverId, id, 'changesThings', sara);
      // Changed: no suggestion yet, a stricter suggestion, and a send by its name. Each would be Deletes or sends out (Asks first), but Off is stricter
      const changed = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2'), tool('postNote', 'g2', 'deletesOrSends'), tool('sendNote', 'h2', 'looksUp')] });
      for (const entry of changed.tools) expect(entry).toMatchObject({ heading: 'changesThings', state: 'confirmed', movedBy: { name: 'sara' } });
      // A suggestion that comes later on the same version keeps it off too
      const later = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'deletesOrSends'), tool('postNote', 'g2', 'deletesOrSends'), tool('sendNote', 'h2', 'looksUp')] });
      for (const entry of later.tools) expect(entry).toMatchObject({ heading: 'changesThings', state: 'confirmed', movedBy: { name: 'sara' } });
      // Deletes or sends out set Right away does not loosen it: Off stays the stricter
      await saveServerSettings(saraBrick, serverId, { deletesOrSends: 'rightAway' });
      let rows = await prisma.botMcpTool.findMany({ where: { serverId } });
      expect(rows.map((row) => row.heading)).toEqual(['changesThings', 'changesThings', 'changesThings']);
      // Once the person turns Changes things back on (Asks first), the tie goes to the stricter heading; set Right away, Universe's rule (Asks first) wins
      await saveServerSettings(saraBrick, serverId, { changesThings: 'asksFirst', deletesOrSends: 'asksFirst' });
      rows = await prisma.botMcpTool.findMany({ where: { serverId }, orderBy: { name: 'asc' } });
      expect(rows.map((row) => [row.name, row.heading, row.personHeading])).toEqual([
        ['postNote', 'deletesOrSends', 'changesThings'],
        ['query', 'deletesOrSends', 'changesThings'],
        ['sendNote', 'deletesOrSends', 'changesThings'],
      ]);
      await saveServerSettings(saraBrick, serverId, { changesThings: 'rightAway' });
      rows = await prisma.botMcpTool.findMany({ where: { serverId } });
      expect(rows.every((row) => row.heading === 'deletesOrSends' && row.movedById === sara && row.confirmedById === null)).toBe(true);
    });

    it('starts again from the person’s own heading when a kept tool changes again, and a move to where it sits now makes it theirs', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f1', 'looksUp'), tool('notes', 'g1', 'looksUp')] });
      const byName = Object.fromEntries(synced.tools.map((entry) => [entry.name, entry.id]));
      await moveTool(saraBrick, serverId, byName.query, 'makesNew', sara);
      await moveTool(saraBrick, serverId, byName.notes, 'makesNew', sara);
      await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'deletesOrSends'), tool('notes', 'g2')] });
      const third = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f3', 'looksUp'), tool('notes', 'g2')] });
      // The second change starts from what the person chose, not from the stricter heading the first one put it under
      expect(third.tools.find((entry) => entry.name === 'query')).toMatchObject({ heading: 'makesNew', movedBy: { name: 'sara' } });
      expect((await prisma.botMcpTool.findUniqueOrThrow({ where: { id: byName.query } })).personHeading).toBe('makesNew');
      // The person keeps the strict heading the changed tool waits under: that is their choice now, and a later suggestion does not undo it
      const notes = third.tools.find((entry) => entry.name === 'notes')!;
      expect(notes).toMatchObject({ heading: 'deletesOrSends', movedBy: { name: 'sara' } });
      expect((await prisma.botMcpTool.findUniqueOrThrow({ where: { id: byName.notes } })).confirmedById).toBeNull();
      await moveTool(saraBrick, serverId, byName.notes, 'deletesOrSends', sara);
      const after = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f3', 'looksUp'), tool('notes', 'g2', 'looksUp')] });
      expect(after.tools.find((entry) => entry.name === 'notes')).toMatchObject({ heading: 'deletesOrSends', confirmedBy: { name: 'sara' }, movedBy: { name: 'sara' } });
      // That choice is what a later change starts from: a looser rule for the next version never takes it back
      const next = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f3', 'looksUp'), tool('notes', 'g3', 'looksUp')] });
      expect(next.tools.find((entry) => entry.name === 'notes')).toMatchObject({ heading: 'deletesOrSends', movedBy: { name: 'sara' } });
      expect((await prisma.botMcpTool.findUniqueOrThrow({ where: { id: byName.notes } })).personHeading).toBe('deletesOrSends');
    });

    it('records a move to the heading Universe already sorted a tool under, and later suggestions no longer move it', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('notes', 'g1')] });
      expect(synced.tools[0]).toMatchObject({ heading: 'deletesOrSends', movedBy: null });
      await moveTool(saraBrick, serverId, synced.tools[0].id, 'deletesOrSends', sara);
      const later = await syncCatalog(saraBrick, serverId, { tools: [tool('notes', 'g1', 'looksUp')] });
      expect(later.tools[0]).toMatchObject({ heading: 'deletesOrSends', confirmedBy: { name: 'sara' }, movedBy: { name: 'sara' } });
    });

    it('changes nothing on a move to the same heading of a tool confirmed by nobody on an App Universe does not sort', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('notes', 'g1', 'looksUp')] });
      // Not the person's own App any more (Universe's GitHub): a tool confirmed by nobody there is like a key App's tested operation
      const grant = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } });
      await prisma.appConnection.update({ where: { id: grant.connectionId! }, data: { source: 'github' } });
      const before = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } });
      await moveTool(saraBrick, serverId, synced.tools[0].id, 'looksUp', sara);
      expect((await prisma.botMcpServer.findUniqueOrThrow({ where: { id: serverId } })).policyRevision).toBe(before.policyRevision);
      expect(await prisma.botMcpTool.findUniqueOrThrow({ where: { id: synced.tools[0].id } })).toMatchObject({ heading: 'looksUp', movedById: null, confirmedById: null });
    });

    it('keeps a heading a person only confirmed (from before Universe sorted own Apps) when the tool changes, never looser', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f1', 'looksUp')] });
      // As a person's confirm left it: confirmed by them, never moved
      await prisma.botMcpTool.update({ where: { id: synced.tools[0].id }, data: { heading: 'deletesOrSends', confirmedById: sara, movedById: null } });
      const changed = await syncCatalog(saraBrick, serverId, { tools: [tool('query', 'f2', 'looksUp')] });
      expect(changed.tools[0]).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed', movedBy: { name: 'sara' } });
      expect((await prisma.botMcpTool.findUniqueOrThrow({ where: { id: synced.tools[0].id } })).personHeading).toBe('deletesOrSends');
    });

    it('removes a tool the server dropped from a cut list unless a person decided on it', async () => {
      const serverId = await ownApp();
      const synced = await syncCatalog(saraBrick, serverId, { tools: [tool('a', 'f1', 'looksUp'), tool('b', 'f2', 'looksUp'), tool('c', 'f3', 'looksUp')] });
      await moveTool(saraBrick, serverId, synced.tools.find((entry) => entry.name === 'b')!.id, 'changesThings', sara);
      const cut = await syncCatalog(saraBrick, serverId, { tools: [tool('c', 'f3', 'looksUp')], truncated: true });
      expect(cut.tools.map((entry) => entry.name).sort()).toEqual(['b', 'c']);
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

    it('never names an own copy that does not work: the ready-made App stays usable', async () => {
      const ready = await readyMade('exa', 'Exa');
      // An own Exa that signs in on the App's site and is not signed in
      const connection = await createConnection(sara, { name: 'Exa', serverUrl: 'https://mcp.exa.ai/mcp', authType: 'oauth', authConfig: undefined, source: 'link' });
      await grantToBrick(sara, connection.id, saraBrick);
      expect((await list()).find((row) => row.id === ready)?.ownCopyServerId).toBeNull();
      expect(await checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-1` })).toMatchObject({ allowed: true });
    });

    it('never lets an own link App the bot server saw fail hide the ready-made one: a refused key, or a server that did not answer', async () => {
      const ready = await readyMade('exa', 'Exa');
      // An own Exa added by its link with a key in it: connected whatever its key does, so only what the bot server saw tells it is broken
      const own = await ownApp('My search', 'https://mcp.exa.ai/mcp');
      const grant = await prisma.botMcpServer.findUniqueOrThrow({ where: { id: own } });
      expect((await list()).find((row) => row.id === ready)?.ownCopyServerId).toBe(own);
      const cases: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
        ['the key is refused (on the App)', () => prisma.appConnection.update({ where: { id: grant.connectionId! }, data: { signInLostAt: new Date(), signInLostStatus: 401 } }), () => prisma.appConnection.update({ where: { id: grant.connectionId! }, data: { signInLostAt: null, signInLostStatus: null } })],
        ['the server does not answer (on the App)', () => prisma.appConnection.update({ where: { id: grant.connectionId! }, data: { noAnswerAt: new Date() } }), () => prisma.appConnection.update({ where: { id: grant.connectionId! }, data: { noAnswerAt: null } })],
        ['the key is refused (on the grant)', () => prisma.botMcpServer.update({ where: { id: own }, data: { signInLostAt: new Date(), signInLostStatus: 403 } }), () => prisma.botMcpServer.update({ where: { id: own }, data: { signInLostAt: null, signInLostStatus: null } })],
        ['the server does not answer (on the grant)', () => prisma.botMcpServer.update({ where: { id: own }, data: { noAnswerAt: new Date() } }), () => prisma.botMcpServer.update({ where: { id: own }, data: { noAnswerAt: null } })],
      ];
      let call = 0;
      for (const [why, broken, mended] of cases) {
        await broken();
        expect({ why, ownCopy: (await list()).find((row) => row.id === ready)?.ownCopyServerId }).toEqual({ why, ownCopy: null });
        expect({ why, use: await checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-broken-${call++}` }) }).toMatchObject({ why, use: { allowed: true } });
        expect({ why, instant: [...(await brickApps(saraBrick))] }).toEqual({ why, instant: ['exa'] });
        await mended();
        expect((await list()).find((row) => row.id === ready)?.ownCopyServerId).toBe(own);
      }
    });

    it('refuses a use of the ready-made copy while the own copy is on, whatever the bot server asks', async () => {
      const ready = await readyMade('exa', 'Exa');
      expect(await checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-2` })).toMatchObject({ allowed: true });
      const own = await ownApp('My search', 'https://mcp.exa.ai/mcp');
      expect(await checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-3` })).toMatchObject({ allowed: false, reason: 'off' });
      await prisma.botMcpServer.update({ where: { id: own }, data: { enabled: false } });
      expect(await checkAppUse(saraBrick, ready, { forOwner: true, callId: `c-${tag}-4` })).toMatchObject({ allowed: true });
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

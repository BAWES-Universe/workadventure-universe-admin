/**
 * Sharing a Brick as a template (game #2008, Brick 17) against a real database: the look first, the secret check, the
 * versions that never change, "Share your latest changes", "Stop sharing", and what a template never carries. Runs only
 * with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/brick-templates-share-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick } from '@/lib/brick-delete';
import { GET as getTemplate, PUT as putTemplate, DELETE as deleteTemplate } from '@/app/api/bricks/[id]/template/route';
import { POST as postLook } from '@/app/api/bricks/[id]/template/look/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const session = getSessionUser as jest.Mock;

type Person = { id: string; email: string };
let sara: Person, omar: Person, guest: Person;
let brickId = '';
let roomBotId = '';
let universeId = '';

const as = (user: Person | null) => session.mockResolvedValue(user ? { id: user.id, email: user.email, name: 'x', isSuperAdmin: false } : null);
const ids = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const look = async (id: string, choices: Record<string, unknown> = {}) => postLook(call('POST', `/api/bricks/${id}/template/look`, choices), ids(id));
const share = async (id: string, choices: Record<string, unknown> = {}) => {
  const read = await (await look(id, choices)).json();
  return putTemplate(call('PUT', `/api/bricks/${id}/template`, { ...choices, token: read.look.token }), ids(id));
};
const group = async (id: string) => (await (await getTemplate(call('GET', `/api/bricks/${id}/template`), ids(id))).json()).template;
const templateRow = (id: string) => prisma.brickTemplate.findUnique({ where: { botId: id }, include: { versions: { orderBy: { number: 'asc' } } } });
const itemFor = (botId: string, ownerId: string, data: Record<string, unknown>) =>
  prisma.brickItem.create({ data: { ownerId, botId, kind: 'reminder', words: 'Send me a recipe', cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, timeZone: 'Asia/Kuwait', ...data } as never });

run('sharing a Brick as a template, in a real database', () => {
  beforeAll(async () => {
    const person = async (name: string, isGuest = false): Promise<Person> => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name, isGuest } });
      return { id: user.id, email: user.email! };
    };
    sara = await person('sara');
    omar = await person('omar');
    guest = await person('guest', true);
    brickId = (await createBrick({ ownerId: sara.id, name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', hello: 'Send me the first recipe' })).id;
    const universe = await prisma.universe.create({ data: { slug: `tpl-${tag}`, name: 'tpl place', ownerId: sara.id } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    roomBotId = (await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: sara.id, behaviorConfig: {} } })).id;
  });

  afterAll(async () => {
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id, guest.id] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.brickTemplate.deleteMany({ where: { botId: brickId } });
    await prisma.brickItem.deleteMany({ where: { botId: brickId } });
    await prisma.botMcpServer.deleteMany({ where: { botId: brickId } });
    await prisma.appConnection.deleteMany({ where: { ownerId: sara.id } });
    await prisma.brickComputer.deleteMany({ where: { botId: brickId } });
    await prisma.bot.update({ where: { id: brickId }, data: { name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', hello: 'Send me the first recipe', deletedAt: null, goneAt: null, enabledBeforeDelete: null, enabled: true } });
    as(sara);
  });

  describe('the look', () => {
    it('shows exactly what would be shared, what never goes, and writes nothing', async () => {
      const response = await look(brickId);
      expect(response.status).toBe(200);
      const { look: read } = await response.json();
      expect(read).toMatchObject({
        name: 'Recipe Brick',
        description: 'Keeps the family recipes',
        look: 'brick-red',
        instructions: 'You keep my family recipes. Send me one when I ask.',
        firstThing: 'Send me the first recipe',
        needs: [],
        routines: [],
        audience: 'everyone',
        findings: [],
        blocked: false,
      });
      expect(read.neverCarried).toEqual(['memory', 'chats', 'history', 'apps', 'keys', 'signIns', 'grants', 'recipients', 'goalsAndTasks', 'files', 'computer']);
      expect(read.token).toEqual(expect.any(String));
      expect(await templateRow(brickId)).toBeNull();
    });

    it('can leave out its look and set its own first thing to try', async () => {
      const { look: read } = await (await look(brickId, { leaveOutLook: true, firstThing: 'Tell me which recipe you want' })).json();
      expect(read).toMatchObject({ look: null, firstThing: 'Tell me which recipe you want' });
      const none = await (await look(brickId, { firstThing: '' })).json();
      expect(none.look.firstThing).toBeNull();
    });

    it('says what people will need from what the Brick uses, never from the request, and never carries a link or a sign-in', async () => {
      const connection = await prisma.appConnection.create({ data: { ownerId: sara.id, name: 'Gmail', serverUrl: 'https://mcp.secret.example.test/gmail', authType: 'oauth', authConfig: 'encrypted-secret', source: 'listed', catalogKey: 'gmail' } });
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: connection.serverUrl, connectionId: connection.id } });
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'My Recipes Server', serverUrl: 'https://recipes.example.test/mcp', authType: 'bearer', authConfig: 'encrypted-token' } });
      await prisma.brickComputer.create({ data: { botId: brickId, enabled: true } });

      const response = await look(brickId, { optionalNeeds: ['computer'] });
      const body = await response.text();
      const { look: read } = JSON.parse(body);
      expect(read.needs).toEqual([
        { kind: 'app', key: 'gmail', label: 'Gmail', required: true },
        { kind: 'app', key: 'link:my recipes server', label: 'My Recipes Server', required: true },
        { kind: 'computer', key: 'computer', label: 'A computer', required: false },
      ]);
      expect(body).not.toContain('secret.example.test');
      expect(body).not.toContain('recipes.example.test');
      expect(body).not.toContain('encrypted');
    });

    it('offers only routines that come back by themselves and are the maker’s own: not a goal, a one-off, a check a goal set or someone else’s', async () => {
      const daily = await itemFor(brickId, sara.id, { kind: 'schedule', words: 'Every morning send me one recipe' });
      const every = await itemFor(brickId, sara.id, { kind: 'watch', words: 'Tell me when a new recipe is added', condition: 'a new recipe appears', cadence: { type: 'every', minutes: 60 } });
      await itemFor(brickId, sara.id, { kind: 'reminder', words: 'Once', cadence: { type: 'once', at: '2026-12-01T10:00:00.000Z' } });
      const goal = await itemFor(brickId, sara.id, { kind: 'goal', words: 'Cook everything', outcome: 'All cooked', cadence: { type: 'none' } });
      await itemFor(brickId, sara.id, { kind: 'reminder', words: 'A check', parentId: goal.id, setBy: 'brick' });
      await itemFor(brickId, sara.id, { kind: 'reminder', words: 'Done one', state: 'done' });

      const state = await group(brickId);
      expect(state.routineChoices.map((choice: { id: string }) => choice.id)).toEqual([daily.id, every.id]);
      expect(state.routineChoices[0]).toMatchObject({ kind: 'schedule', words: 'Every morning send me one recipe', cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] } });

      const chosen = await look(brickId, { routines: [every.id] });
      expect((await chosen.json()).look.routines).toEqual([{ kind: 'watch', words: 'Tell me when a new recipe is added', condition: 'a new recipe appears', cadence: { type: 'every', minutes: 60 } }]);
      const wrong = await look(brickId, { routines: [goal.id] });
      expect(wrong.status).toBe(422);
      expect((await wrong.json()).code).toBe('routine_gone');
    });

    it('finds a secret in the instructions, the first thing and a routine, and blocks sharing; a phone number only warns', async () => {
      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'Use the key sk-proj-abcdefghijklmnopqrstuvwxyz123456 for the recipes API. Call +965 5555 1234.' } });
      const item = await itemFor(brickId, sara.id, { kind: 'schedule', words: 'Log in with password: Summer2026!x and fetch a recipe' });
      const { look: read } = await (await look(brickId, { routines: [item.id] })).json();
      expect(read.blocked).toBe(true);
      expect(read.findings).toEqual([
        { kind: 'secret', where: 'instructions', what: 'an AI or API key', sample: 'sk-pro…' },
        { kind: 'detail', where: 'instructions', what: 'a phone number', sample: '+965 5…' },
        { kind: 'secret', where: 'routine 1', what: 'a password or key written out', sample: 'passwo…' },
      ]);
      const refused = await share(brickId, { routines: [item.id] });
      expect(refused.status).toBe(422);
      expect((await refused.json()).code).toBe('secret');
      expect(await templateRow(brickId)).toBeNull();
    });
  });

  describe('sharing', () => {
    it('shares what was read as version 1, for everyone, with the maker’s state on the Brick’s page', async () => {
      const before = await group(brickId);
      expect(before).toMatchObject({ shared: false, stopped: false, version: null, madeFrom: 0, hasChanges: false, latest: null });

      const response = await share(brickId);
      expect(response.status).toBe(200);
      const { template } = await response.json();
      expect(template).toMatchObject({ shared: true, stopped: false, audience: 'everyone', version: 1, madeFrom: 0, hasChanges: false });
      const row = await templateRow(brickId);
      expect(row).toMatchObject({ makerId: sara.id, audience: 'everyone', currentVersion: 1, stoppedAt: null, pickedAt: null });
      expect(row!.versions).toHaveLength(1);
      expect(row!.versions[0]).toMatchObject({ number: 1, name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', firstThing: 'Send me the first recipe', needs: [], routines: [] });
    });

    it('shares nothing unless the token is the look just read: a changed Brick gets 409 and the new look', async () => {
      const read = await (await look(brickId)).json();
      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'A different prompt that was never read' } });
      const response = await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, { token: read.look.token }), ids(brickId));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.code).toBe('changed');
      expect(body.look.instructions).toBe('A different prompt that was never read');
      expect(await templateRow(brickId)).toBeNull();

      const wrongChoice = await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, { token: read.look.token, audience: 'link' }), ids(brickId));
      expect(wrongChoice.status).toBe(409);
      expect((await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, {}), ids(brickId))).status).toBe(400);
      expect((await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, { token: 'x', owner: sara.id }), ids(brickId))).status).toBe(400);
    });

    it('takes the needs and routines the maker chose, and nothing the Brick keeps to itself', async () => {
      const connection = await prisma.appConnection.create({ data: { ownerId: sara.id, name: 'Gmail', serverUrl: 'https://mcp.example.test/gmail', authType: 'oauth', source: 'listed', catalogKey: 'gmail' } });
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: connection.serverUrl, connectionId: connection.id } });
      const item = await itemFor(brickId, sara.id, { kind: 'schedule', words: 'Every morning send me one recipe' });
      await prisma.botsMemory.create({ data: { botId: brickId, userId: sara.id, content: 'Her mum’s lentil soup is the best', memoryType: 'user' } as never }).catch(() => undefined);

      const response = await share(brickId, { routines: [item.id], optionalNeeds: [], audience: 'link' });
      expect(response.status).toBe(200);
      const row = await templateRow(brickId);
      expect(row!.audience).toBe('link');
      expect(row!.versions[0].needs).toEqual([{ kind: 'app', key: 'gmail', label: 'Gmail', required: true }]);
      expect(row!.versions[0].routines).toEqual([{ kind: 'schedule', words: 'Every morning send me one recipe', condition: null, cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] } }]);
      // What is shared is the versions: nothing in them points at the maker's own rows, links, sign-ins or memory
      const shared = JSON.stringify(row!.versions);
      expect(shared).not.toContain('mcp.example.test');
      expect(shared).not.toContain('lentil');
      expect(shared).not.toContain(item.id);
      expect(shared).not.toContain(connection.id);
      expect(shared).not.toContain(sara.id);
    });

    it('makes no new version when nothing changed (a double tap), and the next version when something did', async () => {
      await share(brickId);
      await share(brickId);
      expect((await templateRow(brickId))!.versions).toHaveLength(1);

      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'You keep my family recipes. Always ask which one first.' } });
      const changed = await group(brickId);
      expect(changed).toMatchObject({ version: 1, hasChanges: true });
      expect(changed.latest.instructions).toBe('You keep my family recipes. Always ask which one first.');

      const second = await share(brickId);
      expect((await second.json()).template).toMatchObject({ version: 2, hasChanges: false });
      const row = await templateRow(brickId);
      expect(row!.versions.map((version) => version.number)).toEqual([1, 2]);
      // A shared version never changes: version 1 still says what it said
      expect(row!.versions[0].chatInstructions).toBe('You keep my family recipes. Send me one when I ask.');
      expect(row!.versions[1].chatInstructions).toBe('You keep my family recipes. Always ask which one first.');
    });

    it('changing the Brick after it was shared never changes what was shared', async () => {
      await share(brickId);
      await prisma.bot.update({ where: { id: brickId }, data: { name: 'Renamed', chatInstructions: null, characterTextureId: 'brick-blue' } });
      const row = await templateRow(brickId);
      expect(row!.versions[0]).toMatchObject({ name: 'Recipe Brick', chatInstructions: 'You keep my family recipes. Send me one when I ask.', characterTextureId: 'brick-red' });
    });

    it('a new version, or a template no longer for everyone, waits to be picked again', async () => {
      await share(brickId);
      await prisma.brickTemplate.update({ where: { botId: brickId }, data: { pickedAt: new Date(), pickedById: omar.id } });
      await share(brickId);
      expect((await templateRow(brickId))!.pickedAt).not.toBeNull();

      await prisma.bot.update({ where: { id: brickId }, data: { description: 'Keeps the family recipes, new' } });
      await share(brickId);
      expect((await templateRow(brickId))!.pickedAt).toBeNull();

      await prisma.brickTemplate.update({ where: { botId: brickId }, data: { pickedAt: new Date(), pickedById: omar.id } });
      await share(brickId, { audience: 'link' });
      expect(await templateRow(brickId)).toMatchObject({ audience: 'link', pickedAt: null, pickedById: null });
    });

    it('counts the Bricks made from it that still exist, and only counts', async () => {
      await share(brickId);
      const row = (await templateRow(brickId))!;
      const made = await Promise.all([omar, sara].map(async (owner, index) => {
        const brick = await createBrick({ ownerId: owner.id, name: `Made ${index}` });
        await prisma.brickTemplateUse.create({ data: { botId: brick.id, templateId: row.id, versionNumber: 1, makerId: sara.id, makerName: 'sara', templateName: 'Recipe Brick' } });
        return brick;
      }));
      const body = await (await getTemplate(call('GET', `/api/bricks/${brickId}/template`), ids(brickId))).text();
      expect(JSON.parse(body).template.madeFrom).toBe(2);
      expect(body).not.toContain(omar.id);
      expect(body).not.toContain(made[0].id);

      await deleteBrick(made[0].id, omar.id);
      expect((await group(brickId)).madeFrom).toBe(1);
      await prisma.bot.deleteMany({ where: { id: { in: made.map((brick) => brick.id) } } });
    });
  });

  describe('stop sharing', () => {
    it('stops new Bricks, touches no Brick, and sharing again with nothing changed brings the same version back', async () => {
      await share(brickId);
      const row = (await templateRow(brickId))!;
      const made = await createBrick({ ownerId: omar.id, name: 'Made' });
      await prisma.brickTemplateUse.create({ data: { botId: made.id, templateId: row.id, versionNumber: 1, makerId: sara.id, makerName: 'sara', templateName: 'Recipe Brick' } });
      await prisma.brickTemplate.update({ where: { botId: brickId }, data: { pickedAt: new Date(), pickedById: omar.id } });

      const response = await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      expect(response.status).toBe(200);
      expect((await response.json()).template).toMatchObject({ shared: false, stopped: true, version: 1, madeFrom: 1 });
      expect(await templateRow(brickId)).toMatchObject({ stoppedAt: expect.any(Date), pickedAt: null });
      expect(await prisma.bot.count({ where: { id: { in: [brickId, made.id] }, deletedAt: null } })).toBe(2);
      expect(await prisma.brickTemplateUse.count({ where: { botId: made.id } })).toBe(1);
      // Asked twice, the same answer
      expect((await (await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId))).json()).template).toMatchObject({ stopped: true });

      const again = await share(brickId);
      expect((await again.json()).template).toMatchObject({ shared: true, stopped: false, version: 1 });
      expect((await templateRow(brickId))!.versions).toHaveLength(1);
      await prisma.bot.delete({ where: { id: made.id } });
    });

    it('is 404 for a Brick that was never shared', async () => {
      expect((await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId))).status).toBe(404);
    });
  });

  describe('who may', () => {
    it('is the owner’s alone: another person, a room bot, a super admin’s own view and a Brick that waits deleted get "not found"', async () => {
      as(omar);
      expect((await getTemplate(call('GET', `/api/bricks/${brickId}/template`), ids(brickId))).status).toBe(404);
      expect((await look(brickId)).status).toBe(404);
      expect((await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, { token: 'x' }), ids(brickId))).status).toBe(404);
      expect((await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId))).status).toBe(404);

      as(sara);
      expect((await look(roomBotId)).status).toBe(404);
      expect((await getTemplate(call('GET', `/api/bricks/${roomBotId}/template`), ids(roomBotId))).status).toBe(404);

      await share(brickId);
      await deleteBrick(brickId, sara.id);
      expect((await getTemplate(call('GET', `/api/bricks/${brickId}/template`), ids(brickId))).status).toBe(404);
      expect((await look(brickId)).status).toBe(404);
    });

    it('needs a signed-in account: 401 without one, 403 for a guest', async () => {
      as(null);
      expect((await getTemplate(call('GET', `/api/bricks/${brickId}/template`), ids(brickId))).status).toBe(401);
      as(guest);
      expect((await look(brickId)).status).toBe(403);
    });

    it('goes with its Brick when the Brick is gone for good', async () => {
      const brick = await createBrick({ ownerId: sara.id, name: 'Short lived', chatInstructions: 'Be short.' });
      await share(brick.id);
      expect(await prisma.brickTemplate.count({ where: { botId: brick.id } })).toBe(1);
      await prisma.bot.delete({ where: { id: brick.id } });
      expect(await prisma.brickTemplate.count({ where: { botId: brick.id } })).toBe(0);
    });
  });
});

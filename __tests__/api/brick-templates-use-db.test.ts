/**
 * Starting a Brick from a template, finding templates, "Setup required", routines that arrive switched off, and taking a
 * template's update (game #2008, Brick 17) against a real database. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a
 * migrated throwaway database:
 *
 *   ROLES_DB_TEST=yes DATABASE_URL=postgres://... npx jest --runInBand __tests__/api/brick-templates-use-db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { createBrick } from '@/lib/brick-create';
import { deleteBrick } from '@/lib/brick-delete';
import { saveServerLimits } from '@/lib/bot-limits';
import { changeItem, claimDueRuns } from '@/lib/brick-items';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { PUT as putTemplate, DELETE as deleteTemplate } from '@/app/api/bricks/[id]/template/route';
import { POST as postLook } from '@/app/api/bricks/[id]/template/look/route';
import { GET as listTemplates } from '@/app/api/brick-templates/route';
import { GET as getPreview } from '@/app/api/brick-templates/[id]/route';
import { POST as postUse } from '@/app/api/brick-templates/[id]/use/route';
import { PUT as putStar, DELETE as deleteStar } from '@/app/api/brick-templates/[id]/star/route';
import { GET as forBrick } from '@/app/api/brick-templates/for-brick/[botId]/route';
import { GET as getMadeFrom } from '@/app/api/bricks/[id]/made-from/route';
import { POST as postUpdate } from '@/app/api/bricks/[id]/made-from/update/route';
import { PUT as putPick, DELETE as deletePick } from '@/app/api/admin/brick-templates/[id]/pick/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;

const tag = randomUUID().slice(0, 8);
const session = getSessionUser as jest.Mock;
const superAdminsBefore = process.env.SUPER_ADMINS;

type Person = { id: string; email: string };
let sara: Person, omar: Person, lina: Person, guest: Person;
let brickId = '';
let keyId = '';

const as = (user: Person | null) => session.mockResolvedValue(user ? { id: user.id, email: user.email, name: 'x', isSuperAdmin: false } : null);
const ids = (id: string) => ({ params: Promise.resolve({ id }) });
const call = (method: string, url: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (response: Response) => response.json();

/** Sara shares her Brick with these choices, as the maker does: read the look, then share what was read. */
const share = async (choices: Record<string, unknown> = {}) => {
  as(sara);
  const read = await json(await postLook(call('POST', `/api/bricks/${brickId}/template/look`, choices), ids(brickId)));
  const shared = await putTemplate(call('PUT', `/api/bricks/${brickId}/template`, { ...choices, token: read.look.token }), ids(brickId));
  expect(shared.status).toBe(200);
  return (await prisma.brickTemplate.findUniqueOrThrow({ where: { botId: brickId } })).id;
};
const preview = async (templateId: string) => getPreview(call('GET', `/api/brick-templates/${templateId}`), ids(templateId));
const makeFrom = async (templateId: string, body?: unknown) => postUse(call('POST', `/api/brick-templates/${templateId}/use`, body), ids(templateId));
const madeFrom = async (id: string) => getMadeFrom(call('GET', `/api/bricks/${id}/made-from`), ids(id));
const lists = async () => json(await listTemplates(call('GET', '/api/brick-templates')));
const keepZone = (person: Person) => prisma.userPreference.upsert({ where: { userId_key: { userId: person.id, key: 'timeZone' } }, create: { userId: person.id, key: 'timeZone', value: 'Asia/Kuwait' }, update: { value: 'Asia/Kuwait' } });
const connectGmail = (person: Person) =>
  prisma.appConnection.create({ data: { ownerId: person.id, name: 'Gmail', serverUrl: `https://mcp.example.test/${tag}/${person.id}`, authType: 'oauth', source: 'ready_made', providerToolkit: 'gmail', providerConfirmedAt: new Date() } });
const routine = (botId: string, ownerId: string, data: Record<string, unknown> = {}) =>
  prisma.brickItem.create({ data: { ownerId, botId, kind: 'schedule', words: 'Every morning send me one recipe', cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, timeZone: 'Europe/London', ...data } as never });
const brickRow = (id: string) => prisma.bot.findUniqueOrThrow({ where: { id } });
const made: string[] = [];
const remember = async (response: Response) => {
  const body = await json(response);
  if (body.brick?.id) made.push(body.brick.id);
  return body;
};

run('Brick templates: using one, finding one, taking an update, in a real database', () => {
  beforeAll(async () => {
    process.env.SUPER_ADMINS = `team-${tag}@example.test`;
    const person = async (name: string, isGuest = false): Promise<Person> => {
      const user = await prisma.user.create({ data: { uuid: `${name}-${tag}`, email: `${name}-${tag}@example.test`, name: name === 'sara' ? 'Sara A.' : name, isGuest } });
      return { id: user.id, email: user.email! };
    };
    sara = await person('sara');
    omar = await person('omar');
    lina = await person('lina');
    guest = await person('guest', true);
    keyId = `key-${tag}`;
    await prisma.botsAiProvider.create({ data: { providerId: keyId, name: 'Sara key', type: 'openai', enabled: true, ownerId: sara.id, model: 'key-model' } });
    brickId = (await createBrick({ ownerId: sara.id, name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', hello: 'Send me the first recipe' })).id;
  });

  afterAll(async () => {
    await prisma.bot.deleteMany({ where: { id: { in: made } } });
    await prisma.botsAiProvider.deleteMany({ where: { providerId: keyId } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, omar.id, lina.id, guest.id] } } });
    if (superAdminsBefore === undefined) delete process.env.SUPER_ADMINS;
    else process.env.SUPER_ADMINS = superAdminsBefore;
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.bot.deleteMany({ where: { id: { in: made } } });
    made.length = 0;
    await prisma.brickTemplate.deleteMany({ where: { botId: brickId } });
    await prisma.brickItem.deleteMany({ where: { botId: brickId } });
    await prisma.botMcpServer.deleteMany({ where: { botId: brickId } });
    await prisma.brickComputer.deleteMany({ where: { botId: brickId } });
    await prisma.botsMemory.deleteMany({ where: { botId: brickId } });
    await prisma.botsConversation.deleteMany({ where: { botId: brickId } });
    await prisma.appConnection.deleteMany({ where: { ownerId: { in: [sara.id, omar.id, lina.id] } } });
    await prisma.userPreference.deleteMany({ where: { userId: { in: [sara.id, omar.id, lina.id] }, key: 'timeZone' } });
    await prisma.bot.update({ where: { id: brickId }, data: { name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', hello: 'Send me the first recipe', aiProviderRef: UNIVERSE_AI_REF, deletedAt: null, goneAt: null, enabledBeforeDelete: null, enabled: true } });
    as(sara);
  });

  describe('the look before creating', () => {
    it('says what the new Brick starts with, what stays with the original, who made it, and what it still needs for this person', async () => {
      const gmail = await connectGmail(sara);
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: gmail.serverUrl, connectionId: gmail.id } });
      await prisma.brickComputer.create({ data: { botId: brickId, enabled: true } });
      const routineItem = await routine(brickId, sara.id);
      const id = await share({ optionalNeeds: ['computer'], routines: [routineItem.id] });

      as(omar);
      const response = await preview(id);
      expect(response.status).toBe(200);
      const text = await response.text();
      const { template } = JSON.parse(text);
      expect(template).toMatchObject({
        id,
        brickId,
        name: 'Recipe Brick',
        description: 'Keeps the family recipes',
        look: 'brick-red',
        instructions: 'You keep my family recipes. Send me one when I ask.',
        firstThing: 'Send me the first recipe',
        maker: { name: 'Sara A.' },
        version: 1,
        starred: false,
        mine: false,
        setupRequired: true,
        needs: [
          { kind: 'app', key: 'gmail', label: 'Gmail', required: true, ready: false },
          { kind: 'computer', key: 'computer', label: 'A computer', required: false, ready: false },
        ],
        routines: [{ kind: 'schedule', words: 'Every morning send me one recipe', condition: null, cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] } }],
      });
      expect(template.staysWithOriginal).toEqual(['memory', 'chats', 'history', 'apps', 'keys', 'signIns', 'grants', 'recipients', 'goalsAndTasks', 'files', 'computer']);
      // Never her email, her link, how many were made from it, or her internal ids
      expect(text).not.toContain(sara.email);
      expect(text).not.toContain(sara.id);
      expect(text).not.toContain('mcp.example.test');
      expect(text).not.toContain('madeFrom');

      await connectGmail(omar);
      const ready = (await json(await preview(id))).template;
      expect(ready.setupRequired).toBe(false);
      expect(ready.needs.map((need: { key: string; ready: boolean }) => [need.key, need.ready])).toEqual([['gmail', true], ['computer', false]]);
    });

    it('says "Setup required" only for what the main job lacks: an optional need alone does not', async () => {
      await prisma.brickComputer.create({ data: { botId: brickId, enabled: true } });
      const id = await share({ optionalNeeds: ['computer'] });
      as(omar);
      expect((await json(await preview(id))).template.setupRequired).toBe(false);
      const required = await share({ optionalNeeds: [] });
      expect(required).toBe(id);
      expect((await json(await preview(id))).template.setupRequired).toBe(true);
    });

    it('opens for anyone signed in with the id (a shared link too), and is "not found" when it stopped, or its Brick waits deleted; a guest and nobody get 403 and 401', async () => {
      const id = await share({ audience: 'link' });
      as(omar);
      expect((await preview(id)).status).toBe(200);
      as(guest);
      expect((await preview(id)).status).toBe(403);
      as(null);
      expect((await preview(id)).status).toBe(401);

      as(sara);
      await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      as(omar);
      expect((await preview(id)).status).toBe(404);
      expect((await makeFrom(id)).status).toBe(404);

      as(sara);
      await share();
      await deleteBrick(brickId, sara.id);
      as(omar);
      expect((await preview(id)).status).toBe(404);
      expect((await makeFrom(id)).status).toBe(404);
      expect((await preview('no-such-template')).status).toBe(404);
    });
  });

  describe('creating a Brick from a template', () => {
    it('makes a new individual with the shared look, line, instructions and first thing, and copies nothing the template never carries', async () => {
      const gmail = await connectGmail(sara);
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: gmail.serverUrl, connectionId: gmail.id } });
      await prisma.brickComputer.create({ data: { botId: brickId, enabled: true } });
      await prisma.botsMemory.create({ data: { botId: brickId, userUuid: `sara-${tag}`, userId: sara.id, isGuest: false, memories: [{ text: 'Her mum’s lentil soup is the best' }] } });
      await prisma.botFile.create({ data: { botId: brickId, number: 1, ownerId: sara.id, source: 'person', kind: 'document', name: 'secret-recipe.pdf', chatKind: 'dm', chatRef: 'x', participants: [sara.id] } as never }).catch(() => undefined);
      await prisma.brickItem.create({ data: { ownerId: sara.id, botId: brickId, kind: 'goal', words: 'Cook everything', outcome: 'All cooked', cadence: { type: 'none' }, timeZone: 'Asia/Kuwait', waitingFor: 'the weekend' } });
      await prisma.bot.update({ where: { id: brickId }, data: { aiProviderRef: keyId, voiceEnabled: true, privateBot: true, companionTextureId: 'pet' } });
      const id = await share();

      as(omar);
      const response = await makeFrom(id);
      expect(response.status).toBe(201);
      const body = await remember(response);
      expect(body.brick).toMatchObject({ name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', hello: 'Send me the first recipe', enabled: true, isDefault: false });
      expect(body.madeFrom).toEqual({ templateName: 'Recipe Brick', maker: { name: 'Sara A.' }, version: 1, shared: true });
      expect(body.setup.setupRequired).toBe(true);
      expect(body.routines).toEqual({ added: 0, leftOut: 0 });

      const row = await brickRow(body.brick.id);
      expect(row).toMatchObject({ ownerId: omar.id, roomId: null, createdById: omar.id, chatInstructions: 'You keep my family recipes. Send me one when I ask.', aiProviderRef: UNIVERSE_AI_REF, voiceEnabled: false, privateBot: false, companionTextureId: null, enabled: true });
      expect(row.id).not.toBe(brickId);
      // Nothing of the original came with it
      const fresh = { botId: row.id };
      expect(await prisma.botMcpServer.count({ where: fresh })).toBe(0);
      expect(await prisma.brickComputer.count({ where: fresh })).toBe(0);
      expect(await prisma.botsMemory.count({ where: fresh })).toBe(0);
      expect(await prisma.botFile.count({ where: fresh })).toBe(0);
      expect(await prisma.brickItem.count({ where: fresh })).toBe(0);
      expect(await prisma.botActionGrant.count({ where: fresh })).toBe(0);
      expect(await prisma.brickTemplateUse.findUnique({ where: { botId: row.id } })).toMatchObject({ templateId: id, versionNumber: 1, makerId: sara.id, makerName: 'Sara A.', templateName: 'Recipe Brick' });
      // The original is as it was
      expect(await brickRow(brickId)).toMatchObject({ aiProviderRef: keyId, voiceEnabled: true, privateBot: true });
      expect(await prisma.botMcpServer.count({ where: { botId: brickId } })).toBe(1);
    });

    it('refuses a body that is not JSON before anything is made, and still takes no body at all', async () => {
      const id = await share();
      as(omar);
      const before = await prisma.bot.count({ where: { ownerId: omar.id } });
      const broken = new NextRequest(`http://localhost/api/brick-templates/${id}/use`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name": ' });
      expect((await postUse(broken, ids(id))).status).toBe(400);
      expect(await prisma.bot.count({ where: { ownerId: omar.id } })).toBe(before);
      const bare = new NextRequest(`http://localhost/api/brick-templates/${id}/use`, { method: 'POST' });
      const made = await postUse(bare, ids(id));
      expect(made.status).toBe(201);
      await remember(made);
    });

    it('takes its own name when asked, and the next colour its owner has not used when the maker left the look out; each time is a new Brick', async () => {
      const id = await share({ leaveOutLook: true });
      as(omar);
      const first = await remember(await makeFrom(id, { name: 'Mum’s recipes' }));
      const second = await remember(await makeFrom(id));
      expect(first.brick).toMatchObject({ name: 'Mum’s recipes', characterTextureId: 'brick-orange' });
      expect(second.brick).toMatchObject({ name: 'Recipe Brick', characterTextureId: 'brick-red' });
      expect(first.brick.id).not.toBe(second.brick.id);
      expect((await makeFrom(id, { name: '' })).status).toBe(400);
      expect((await makeFrom(id, { owner: sara.id })).status).toBe(400);
    });

    it('starts from the version the template is at now, and counts for the maker without saying who', async () => {
      const id = await share();
      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'Always ask which one first.' } });
      await share();
      as(omar);
      const body = await remember(await makeFrom(id));
      expect(body.madeFrom.version).toBe(2);
      expect((await prisma.bot.findUniqueOrThrow({ where: { id: body.brick.id } })).chatInstructions).toBe('Always ask which one first.');
      as(sara);
      const group = await json(await (await import('@/app/api/bricks/[id]/template/route')).GET(call('GET', `/api/bricks/${brickId}/template`), ids(brickId)));
      expect(group.template.madeFrom).toBe(1);
    });
  });

  describe('routines that arrive switched off', () => {
    it('come paused by the template with nothing due, and make zero runs until the owner sets them up and turns them on', async () => {
      const item = await routine(brickId, sara.id);
      const id = await share({ routines: [item.id] });
      as(omar);
      const body = await remember(await makeFrom(id));
      expect(body.routines).toEqual({ added: 1, leftOut: 0 });
      expect(body.setup.routinesOff).toBe(1);
      const own = await prisma.brickItem.findMany({ where: { botId: body.brick.id } });
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ ownerId: omar.id, kind: 'schedule', state: 'paused', pausedBy: 'template', nextDueAt: null, words: 'Every morning send me one recipe' });
      // The maker's own routine is untouched
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ state: 'on', ownerId: sara.id });

      // Zero runs, even long after its time
      const later = new Date(Date.now() + 30 * 24 * 3_600_000);
      const claimed = await claimDueRuns(later, 500);
      expect(claimed.filter((run) => run.brickId === body.brick.id)).toEqual([]);
      expect(await prisma.brickItemRun.count({ where: { itemId: own[0].id } })).toBe(0);
    });

    it('turn on only with the owner’s time zone kept and what the template needs there; they run on the owner’s clock, not the maker’s', async () => {
      const gmail = await connectGmail(sara);
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: gmail.serverUrl, connectionId: gmail.id } });
      const item = await routine(brickId, sara.id);
      const id = await share({ routines: [item.id] });
      as(omar);
      const body = await remember(await makeFrom(id));
      const botId = body.brick.id;
      const itemId = (await prisma.brickItem.findFirstOrThrow({ where: { botId } })).id;
      const resume = () => changeItem(botId, itemId, { userId: omar.email, action: 'resume' });

      const noZone = await resume();
      expect(noZone).toMatchObject({ ok: false, status: 422, code: 'needs_time_zone' });
      await keepZone(omar);
      const noGmail = await resume();
      expect(noGmail).toMatchObject({ ok: false, status: 409, code: 'needs_setup', error: 'Set up Gmail first' });
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'paused', pausedBy: 'template' });

      const own = await connectGmail(omar);
      await prisma.botMcpServer.create({ data: { botId, name: 'Gmail', serverUrl: own.serverUrl, connectionId: own.id } });
      const on = await resume();
      expect(on.ok).toBe(true);
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'on', pausedBy: null, timeZone: 'Asia/Kuwait', nextDueAt: expect.any(Date) });
    });

    it('keep a time zone the owner set on the routine itself; only the placeholder is replaced by their kept zone', async () => {
      const item = await routine(brickId, sara.id);
      const id = await share({ routines: [item.id] });
      as(omar);
      const body = await remember(await makeFrom(id));
      const botId = body.brick.id;
      const itemId = (await prisma.brickItem.findFirstOrThrow({ where: { botId } })).id;
      await keepZone(omar);
      const changed = await changeItem(botId, itemId, { userId: omar.email, action: 'change', change: { timeZone: 'Asia/Dubai' } });
      expect(changed.ok).toBe(true);
      expect((await changeItem(botId, itemId, { userId: omar.email, action: 'resume' })).ok).toBe(true);
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'on', timeZone: 'Asia/Dubai' });
    });

    it('keep UTC when the owner chose UTC for the routine, even with another zone kept; only a routine nobody gave a zone is set to theirs', async () => {
      const item = await routine(brickId, sara.id);
      const id = await share({ routines: [item.id] });
      as(omar);
      const body = await remember(await makeFrom(id));
      const botId = body.brick.id;
      const itemId = (await prisma.brickItem.findFirstOrThrow({ where: { botId } })).id;
      await keepZone(omar);
      expect((await changeItem(botId, itemId, { userId: omar.email, action: 'change', change: { timeZone: 'UTC' } })).ok).toBe(true);
      expect((await changeItem(botId, itemId, { userId: omar.email, action: 'resume' })).ok).toBe(true);
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'on', timeZone: 'UTC' });
    });

    it('Done is not a way around the gate: a routine marked done while still off cannot be reopened or snoozed on until it is set up', async () => {
      const gmail = await connectGmail(sara);
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: gmail.serverUrl, connectionId: gmail.id } });
      const item = await routine(brickId, sara.id);
      const id = await share({ routines: [item.id] });
      as(omar);
      const body = await remember(await makeFrom(id));
      const botId = body.brick.id;
      const itemId = (await prisma.brickItem.findFirstOrThrow({ where: { botId } })).id;
      const act = (action: 'resume' | 'done' | 'reopen' | 'snooze') => changeItem(botId, itemId, { userId: omar.email, action });

      expect((await act('done')).ok).toBe(true);
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'done', pausedBy: 'template', nextDueAt: null });
      expect(await act('reopen')).toMatchObject({ ok: false, status: 422, code: 'needs_time_zone' });
      await keepZone(omar);
      expect(await act('reopen')).toMatchObject({ ok: false, status: 409, code: 'needs_setup' });
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'done', nextDueAt: null });
      const later = new Date(Date.now() + 30 * 24 * 3_600_000);
      expect((await claimDueRuns(later, 500)).filter((run) => run.brickId === botId)).toEqual([]);
      expect(await prisma.brickItemRun.count({ where: { itemId } })).toBe(0);

      const own = await connectGmail(omar);
      await prisma.botMcpServer.create({ data: { botId, name: 'Gmail', serverUrl: own.serverUrl, connectionId: own.id } });
      expect((await act('reopen')).ok).toBe(true);
      expect(await prisma.brickItem.findUniqueOrThrow({ where: { id: itemId } })).toMatchObject({ state: 'on', pausedBy: null, timeZone: 'Asia/Kuwait', nextDueAt: expect.any(Date) });
    });

    it('leave out a routine that repeats more often than the shortest-wait setting is now, even if it was fine when the maker set it', async () => {
      const often = await routine(brickId, sara.id, { cadence: { type: 'every', minutes: 30 }, words: 'Every half hour check the oven' });
      const id = await share({ routines: [often.id] });
      try {
        await saveServerLimits({ bricks: { shortestRepeat: 120 } }, sara.id);
        as(omar);
        const body = await remember(await makeFrom(id));
        expect(body.routines).toEqual({ added: 0, leftOut: 1 });
        expect(await prisma.brickItem.count({ where: { botId: body.brick.id } })).toBe(0);
      } finally {
        await saveServerLimits({ bricks: { shortestRepeat: 30 } }, sara.id);
      }
    });

    it('leave out what does not fit under the goals and tasks setting, and say how many', async () => {
      const first = await routine(brickId, sara.id);
      const second = await routine(brickId, sara.id, { words: 'Every evening send me a menu' });
      const id = await share({ routines: [first.id, second.id] });
      try {
        await saveServerLimits({ bricks: { itemsPerPerson: 1 } }, sara.id);
        as(omar);
        const body = await remember(await makeFrom(id));
        expect(body.routines).toEqual({ added: 1, leftOut: 1 });
      } finally {
        await saveServerLimits({ bricks: { itemsPerPerson: 20 } }, sara.id);
      }
    });
  });

  describe('Star and the three short lists', () => {
    it('keeps a template for later, lists it first, and takes it off; starring twice is one star', async () => {
      const id = await share();
      as(omar);
      expect((await putStar(call('PUT', `/api/brick-templates/${id}/star`), ids(id))).status).toBe(200);
      expect((await putStar(call('PUT', `/api/brick-templates/${id}/star`), ids(id))).status).toBe(200);
      expect(await prisma.brickTemplateStar.count({ where: { userId: omar.id } })).toBe(1);
      const shown = await lists();
      expect(shown.starred.map((card: { id: string; starred: boolean }) => [card.id, card.starred])).toEqual([[id, true]]);
      expect(shown.picks).toEqual([]);
      expect(shown.met).toEqual([]);
      expect((await json(await preview(id))).template.starred).toBe(true);
      // Only they see their stars
      as(lina);
      expect((await lists()).starred).toEqual([]);

      as(omar);
      await deleteStar(call('DELETE', `/api/brick-templates/${id}/star`), ids(id));
      expect((await lists()).starred).toEqual([]);
      expect((await putStar(call('PUT', '/api/brick-templates/nothing/star'), ids('nothing'))).status).toBe(404);
    });

    it('lists only what the viewer may open: a template that stopped, or whose Brick waits deleted, leaves their Starred list, and comes back with the same star', async () => {
      const id = await share({ audience: 'link' });
      as(omar);
      await putStar(call('PUT', `/api/brick-templates/${id}/star`), ids(id));
      expect((await lists()).starred).toHaveLength(1);
      as(sara);
      await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      as(omar);
      expect((await lists()).starred).toEqual([]);
      as(sara);
      await share({ audience: 'link' });
      as(omar);
      expect((await lists()).starred).toHaveLength(1);
      as(sara);
      await deleteBrick(brickId, sara.id);
      as(omar);
      expect((await lists()).starred).toEqual([]);
    });

    it('lists picks picked by Universe, only those shared with everyone, and only a super admin can pick', async () => {
      const id = await share();
      as(omar);
      const refused = await putPick(call('PUT', `/api/admin/brick-templates/${id}/pick`), ids(id));
      expect(refused.status).toBe(403);
      expect((await lists()).picks).toEqual([]);

      session.mockResolvedValue({ id: lina.id, email: `team-${tag}@example.test`, name: 'team', isSuperAdmin: true });
      expect((await putPick(call('PUT', `/api/admin/brick-templates/${id}/pick`), ids(id))).status).toBe(200);
      as(omar);
      expect((await lists()).picks.map((card: { id: string }) => card.id)).toEqual([id]);

      // A new version waits to be picked again
      as(sara);
      await prisma.bot.update({ where: { id: brickId }, data: { description: 'New line' } });
      await share();
      as(omar);
      expect((await lists()).picks).toEqual([]);

      // A template shared by link only cannot be picked, and is on no list but a Starred one
      as(sara);
      await share({ audience: 'link' });
      session.mockResolvedValue({ id: lina.id, email: `team-${tag}@example.test`, name: 'team', isSuperAdmin: true });
      expect((await putPick(call('PUT', `/api/admin/brick-templates/${id}/pick`), ids(id))).status).toBe(409);
      expect((await deletePick(call('DELETE', `/api/admin/brick-templates/${id}/pick`), ids(id))).status).toBe(200);
      as(omar);
      const shown = await lists();
      expect([shown.picks, shown.met]).toEqual([[], []]);
    });

    it('lists Bricks the person has met (talked with) that share one for everyone, never their own and never by link only', async () => {
      const id = await share();
      as(omar);
      expect((await lists()).met).toEqual([]);
      await prisma.botsConversation.create({ data: { botId: brickId, userId: omar.id, isGuest: false, messages: [], startedAt: new Date(), endedAt: new Date(), messageCount: 2 } });
      expect((await lists()).met.map((card: { id: string }) => card.id)).toEqual([id]);
      // Someone who never talked with it does not see it
      as(lina);
      expect((await lists()).met).toEqual([]);
      // Their own is not "met"
      await prisma.botsConversation.create({ data: { botId: brickId, userId: sara.id, isGuest: false, messages: [], startedAt: new Date(), endedAt: new Date(), messageCount: 2 } });
      as(sara);
      expect((await lists()).met).toEqual([]);
      // Shared by link only: not listed even for someone who met it
      await share({ audience: 'link' });
      as(omar);
      expect((await lists()).met).toEqual([]);
    });

    it('shows each list as long as the Limits setting says', async () => {
      const second = await createBrick({ ownerId: sara.id, name: 'Second', chatInstructions: 'Be short.' });
      made.push(second.id);
      const one = await share();
      const shareOther = async () => {
        const read = await json(await postLook(call('POST', `/api/bricks/${second.id}/template/look`, {}), ids(second.id)));
        await putTemplate(call('PUT', `/api/bricks/${second.id}/template`, { token: read.look.token }), ids(second.id));
        return (await prisma.brickTemplate.findUniqueOrThrow({ where: { botId: second.id } })).id;
      };
      const two = await shareOther();
      as(omar);
      await putStar(call('PUT', `/api/brick-templates/${one}/star`), ids(one));
      await putStar(call('PUT', `/api/brick-templates/${two}/star`), ids(two));
      try {
        await saveServerLimits({ bricks: { templateList: 1 } }, sara.id);
        const shown = await lists();
        expect(shown.starred.map((card: { id: string }) => card.id)).toEqual([two]);
      } finally {
        await saveServerLimits({ bricks: { templateList: 10 } }, sara.id);
      }
      expect((await lists()).starred).toHaveLength(2);
    });
  });

  describe('the card of a Brick someone meets', () => {
    it('has the template when it is shared with everyone, and none when it is shared by link only, stopped, or never shared', async () => {
      const card = async (viewer: Person) => {
        as(viewer);
        return (await json(await forBrick(call('GET', `/api/brick-templates/for-brick/${brickId}`), { params: Promise.resolve({ botId: brickId }) }))).template;
      };
      expect(await card(omar)).toBeNull();
      const id = await share();
      expect(await card(omar)).toMatchObject({ id, brickId, name: 'Recipe Brick', maker: { name: 'Sara A.' }, mine: false });
      expect(await card(sara)).toMatchObject({ id, mine: true });
      as(sara);
      await share({ audience: 'link' });
      expect(await card(omar)).toBeNull();
      await share({ audience: 'everyone' });
      await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      expect(await card(omar)).toBeNull();
    });
  });

  describe('a Brick made from a template', () => {
    it('says whose template it came from and what it still needs, to its owner only, and keeps the maker’s name when the template goes', async () => {
      const gmail = await connectGmail(sara);
      await prisma.botMcpServer.create({ data: { botId: brickId, name: 'Gmail', serverUrl: gmail.serverUrl, connectionId: gmail.id } });
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      const view = await json(await madeFrom(botId));
      expect(view.madeFrom).toEqual({ templateName: 'Recipe Brick', maker: { name: 'Sara A.' }, version: 1, shared: true });
      expect(view.setup).toMatchObject({ setupRequired: true, routinesOff: 0, needs: [{ key: 'gmail', required: true, ready: false }] });
      expect(view.update).toBeNull();

      // Set up, and it is ready
      const own = await connectGmail(omar);
      await prisma.botMcpServer.create({ data: { botId, name: 'Gmail', serverUrl: own.serverUrl, connectionId: own.id } });
      expect((await json(await madeFrom(botId))).setup).toMatchObject({ setupRequired: false, needs: [{ key: 'gmail', ready: true }] });

      // Only its owner, and only a Brick made from a template
      as(lina);
      expect((await madeFrom(botId)).status).toBe(404);
      as(omar);
      expect((await madeFrom(brickId)).status).toBe(404);

      // The template stops, then goes for good: the Brick and the maker's name stay
      as(sara);
      await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      as(omar);
      expect((await json(await madeFrom(botId))).madeFrom).toMatchObject({ shared: false, maker: { name: 'Sara A.' } });
      await prisma.bot.delete({ where: { id: brickId } });
      const gone = await json(await madeFrom(botId));
      expect(gone.madeFrom).toMatchObject({ templateName: 'Recipe Brick', maker: { name: 'Sara A.' }, shared: false });
      expect(gone.setup.needs).toEqual([]);
      brickId = (await createBrick({ ownerId: sara.id, name: 'Recipe Brick', description: 'Keeps the family recipes', characterTextureId: 'brick-red', chatInstructions: 'You keep my family recipes. Send me one when I ask.', hello: 'Send me the first recipe' })).id;
    });
  });

  describe('a template update', () => {
    const newVersion = async () => {
      as(sara);
      const item = await routine(brickId, sara.id, { words: 'Every evening send me a menu' });
      await prisma.bot.update({ where: { id: brickId }, data: { chatInstructions: 'Always ask which one first.', description: 'Keeps the family recipes, and menus', hello: 'Which recipe today?' } });
      await share({ routines: [item.id] });
    };

    it('never reaches a Brick by itself: it is offered as a change to review, with what the Brick has and what the template says', async () => {
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      await prisma.bot.update({ where: { id: botId }, data: { description: 'Mum’s recipes' } });
      await newVersion();

      as(omar);
      const row = await brickRow(botId);
      expect(row).toMatchObject({ chatInstructions: 'You keep my family recipes. Send me one when I ask.', description: 'Mum’s recipes', hello: 'Send me the first recipe' });
      const view = await json(await madeFrom(botId));
      expect(view.update.version).toBe(2);
      expect(view.update.changes).toEqual([
        { field: 'description', mine: 'Mum’s recipes', theirs: 'Keeps the family recipes, and menus' },
        { field: 'instructions', mine: 'You keep my family recipes. Send me one when I ask.', theirs: 'Always ask which one first.' },
        { field: 'firstThing', mine: 'Send me the first recipe', theirs: 'Which recipe today?' },
        { field: 'routines', mine: null, theirs: [{ kind: 'schedule', words: 'Every evening send me a menu', condition: null, cadence: { type: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] } }] },
      ]);
      expect(view.madeFrom.version).toBe(1);
    });

    it('applies only the parts the owner takes, brings routines switched off, and then the offer is closed', async () => {
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      await newVersion();
      as(omar);
      const taken = await postUpdate(call('POST', `/api/bricks/${botId}/made-from/update`, { version: 2, take: ['instructions', 'routines'] }), ids(botId));
      expect(taken.status).toBe(200);
      const body = await json(taken);
      expect(body.routines).toEqual({ added: 1, leftOut: 0 });
      expect(body.madeFrom.version).toBe(2);
      expect(body.update).toBeNull();
      expect(await brickRow(botId)).toMatchObject({ chatInstructions: 'Always ask which one first.', description: 'Keeps the family recipes', hello: 'Send me the first recipe' });
      expect(await prisma.brickItem.findMany({ where: { botId }, select: { state: true, pausedBy: true, nextDueAt: true, words: true } })).toEqual([{ state: 'paused', pausedBy: 'template', nextDueAt: null, words: 'Every evening send me a menu' }]);
      // Taken once: it is not offered again, and nothing is added twice
      expect((await postUpdate(call('POST', `/api/bricks/${botId}/made-from/update`, { version: 2, take: ['routines'] }), ids(botId))).status).toBe(409);
      expect(await prisma.brickItem.count({ where: { botId } })).toBe(1);
    });

    it('taking none keeps the Brick as it is and closes the offer for that version', async () => {
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      await newVersion();
      as(omar);
      const before = await brickRow(botId);
      const kept = await postUpdate(call('POST', `/api/bricks/${botId}/made-from/update`, { version: 2, take: [] }), ids(botId));
      expect(kept.status).toBe(200);
      expect((await json(kept)).update).toBeNull();
      const after = await brickRow(botId);
      expect([after.chatInstructions, after.description, after.hello]).toEqual([before.chatInstructions, before.description, before.hello]);
      expect((await prisma.brickTemplateUse.findUniqueOrThrow({ where: { botId } })).versionNumber).toBe(2);
    });

    it('refuses a version that is not the latest, a part that is not in the update, and anyone but the owner', async () => {
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      await newVersion();
      as(omar);
      const take = (body: unknown, who: Person = omar) => {
        as(who);
        return postUpdate(call('POST', `/api/bricks/${botId}/made-from/update`, body), ids(botId));
      };
      const stale = await take({ version: 1, take: ['instructions'] });
      expect(stale.status).toBe(409);
      expect((await json(stale)).code).toBe('changed');
      expect((await take({ version: 2, take: ['look'] })).status).toBe(422);
      expect((await take({ version: 2, take: ['everything'] })).status).toBe(400);
      expect((await take({ version: 2, take: ['instructions'] }, lina)).status).toBe(404);
      expect((await brickRow(botId)).chatInstructions).toBe('You keep my family recipes. Send me one when I ask.');
    });

    it('is not offered when the template stopped being shared: every Brick stays as it is', async () => {
      const id = await share();
      as(omar);
      const botId = (await remember(await makeFrom(id))).brick.id;
      await newVersion();
      as(sara);
      await deleteTemplate(call('DELETE', `/api/bricks/${brickId}/template`), ids(brickId));
      as(omar);
      expect((await json(await madeFrom(botId))).update).toBeNull();
      expect((await postUpdate(call('POST', `/api/bricks/${botId}/made-from/update`, { version: 2, take: ['instructions'] }), ids(botId))).status).toBe(409);
      expect(await prisma.bot.count({ where: { id: botId, deletedAt: null } })).toBe(1);
    });
  });
});

/**
 * "Ask for more" and "Give more" for speech and Apps (billing consensus v2, P5), against a real database: the one entitlement shown, asked for
 * only when it is used up, extended only for that person and for a while, and never a platform budget, another payer's rules or a provider's
 * limit. Runs only with ROLES_DB_TEST=yes and a DATABASE_URL to a migrated THROWAWAY database.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

jest.mock('@/lib/service-tokens', () => ({ requireServiceToken: jest.fn() }));
jest.mock('@/lib/auth-session', () => ({ getSessionUser: jest.fn(async () => null) }));
jest.mock('@/lib/super-admin', () => ({ isSuperAdmin: jest.fn((email: string | null) => email === 'admin@example.test') }));

import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { saveMeterSettings } from '@/lib/meter';
import { memberUsage } from '@/lib/meter-usage';
import { checkVoiceAllowance } from '@/lib/voice-allowance';
import { runningExtra } from '@/lib/meter-grants';
import { POST as askPost } from '@/app/api/me/usage/ask-for-more/route';
import { GET as personGet, PATCH as personPatch, POST as personPost } from '@/app/api/admin/users/[id]/extra-usage/route';

const run = process.env.ROLES_DB_TEST === 'yes' ? describe : describe.skip;
const session = getSessionUser as jest.Mock;
const tag = randomUUID().slice(0, 8);
const KEYS = ['meter'];
const saved: Record<string, { value: unknown } | null> = {};
let sara = { id: '', uuid: '' };
let botId = '';
let universeId = '';
let adminId = '';

const body = (method: string, url: string, json: unknown) => new NextRequest(`http://localhost:3333${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });
const get = (url: string) => new NextRequest(`http://localhost:3333${url}`);
const ctx = () => ({ params: Promise.resolve({ id: sara.id }) });
const asSara = () => session.mockResolvedValue({ id: sara.id, email: `sara-${tag}@example.test` });
const asAdmin = () => session.mockResolvedValue({ id: adminId, email: 'admin@example.test' });
const ask = (category: string) => askPost(body('POST', '/api/me/usage/ask-for-more', { category }));
const endsAt = (days = 5) => new Date(Date.now() + days * 86_400_000).toISOString();
const give = (json: Record<string, unknown>) => personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: randomUUID(), amount: 'double', endsAt: endsAt(), settlement: 'gift', ...json }), ctx());

/** Seconds of speech Universe AI paid for, for Sara, this month. */
const spoke = (seconds: number) =>
  prisma.meterEvent.create({
    data: { eventId: `speech:gm:${tag}:${randomUUID()}`, kind: 'speech', pool: 'chat', occurredAt: new Date(), personKey: `person:${sara.id}`, personId: sara.id, payerKind: 'universe', quantity: BigInt(seconds), unit: 'second', costMicros: BigInt(10), basis: 'estimated' },
  });
/** Money of connected Apps Sara's Brick used on Universe's money this month. */
const usedApp = (micros: number) =>
  prisma.meterEvent.create({
    data: { eventId: `app:gm:${tag}:${randomUUID()}`, kind: 'app_use', pool: 'chat', route: 'app', occurredAt: new Date(), personKey: `person:${sara.id}`, personId: sara.id, botId, payerKind: 'universe', quantity: BigInt(1), unit: 'use', costMicros: BigInt(micros), basis: 'estimated' },
  });

run('Ask for more and Give more for speech and Apps, in a real database', () => {
  beforeAll(async () => {
    for (const key of KEYS) saved[key] = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
    const user = await prisma.user.create({ data: { uuid: `sara-${tag}`, email: `sara-${tag}@example.test`, name: 'Sara' } });
    sara = { id: user.id, uuid: user.uuid };
    adminId = (await prisma.user.create({ data: { uuid: `admin-${tag}`, email: `admin-${tag}@example.test`, name: 'Admin' } })).id;
    const universe = await prisma.universe.create({ data: { slug: `gm-${tag}`, name: 'Give more', ownerId: sara.id } });
    universeId = universe.id;
    const world = await prisma.world.create({ data: { universeId, slug: 'hq', name: 'HQ' } });
    const room = await prisma.room.create({ data: { worldId: world.id, slug: 'lobby', name: 'Lobby' } });
    botId = (await prisma.bot.create({ data: { roomId: room.id, name: 'Nora', createdById: sara.id } })).id;
  });
  beforeEach(async () => {
    session.mockResolvedValue(null);
    await prisma.meterEvent.deleteMany({ where: { personId: sara.id } });
    await prisma.meterRequest.deleteMany({ where: { personId: sara.id } });
    await prisma.meterEntitlementGrant.deleteMany({ where: { personId: sara.id } });
    await prisma.voiceReplyUse.deleteMany({ where: { botId } });
    // Speech: 100 seconds a person, a wide budget; Apps: 1,000 millionths a person, a wide budget
    await saveMeterSettings({ speechBudgetMicros: 1_000_000_000, speechMemberCeilingSeconds: 100, appUseCeilingMicros: 1_000_000_000, appUseMemberCeilingMicros: 1_000 }, adminId);
  });
  afterAll(async () => {
    await prisma.meterEvent.deleteMany({ where: { personId: sara.id } });
    await prisma.meterRequest.deleteMany({ where: { personId: sara.id } });
    await prisma.meterEntitlementGrant.deleteMany({ where: { personId: sara.id } });
    await prisma.voiceReplyUse.deleteMany({ where: { botId } });
    for (const key of KEYS) {
      const before = saved[key];
      if (before) await prisma.appSetting.upsert({ where: { key }, create: { key, value: before.value as never }, update: { value: before.value as never } });
      else await prisma.appSetting.deleteMany({ where: { key } });
    }
    await prisma.universe.deleteMany({ where: { id: universeId } });
    await prisma.user.deleteMany({ where: { id: { in: [sara.id, adminId] } } });
    await prisma.$disconnect();
  });

  describe('speech', () => {
    it('shows no speech line until there is something to say, then plain words and no number', async () => {
      expect((await memberUsage(sara.id)).speech).toBeUndefined();
      await spoke(30);
      const line = (await memberUsage(sara.id)).speech!;
      expect(line).toMatchObject({ scope: 'speech', words: 'plenty', canAskForMore: false, asked: false, extra: null });
      expect(JSON.stringify(line)).not.toMatch(/ceiling|used|100/);
    });

    it('offers "Ask for more" only when their own speech allowance is used up, and records it once', async () => {
      asSara();
      await spoke(60);
      expect((await ask('speech')).status).toBe(409);
      await spoke(40);
      expect((await memberUsage(sara.id)).speech).toMatchObject({ words: 'out', canAskForMore: true });
      const first = await ask('speech');
      expect(first.status).toBe(201);
      expect((await ask('speech')).status).toBe(200);
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, what: 'speech', answeredAt: null } })).toBe(1);
      expect((await memberUsage(sara.id)).speech).toMatchObject({ asked: true });
      // It is not for computer time: that stays a different ask
      expect((await ask('computer')).status).toBe(409);
      expect((await ask('nonsense')).status).toBe(400);
    });

    it('is refused for a stranger and for anyone who is not a super admin', async () => {
      expect((await personPost(body('POST', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: 'k', amount: 'double', endsAt: endsAt(), settlement: 'gift', scope: 'speech' }), ctx())).status).toBe(403);
      asSara();
      expect((await personGet(get(`/api/admin/users/${sara.id}/extra-usage`), ctx())).status).toBe(403);
    });

    it('is given by a super admin for a while: the preview names what it extends and never overrides, the ask is answered, and speech carries on', async () => {
      await spoke(100);
      asSara();
      await ask('speech');
      expect(await checkVoiceAllowance(botId, { userId: sara.uuid, isGuest: false, turnId: randomUUID(), contract: 2 })).toMatchObject({ allowed: false, stoppedBy: 'person' });

      asAdmin();
      const given = await give({ scope: 'speech', amount: 'double' });
      expect(given.status).toBe(201);
      const answer = await given.json();
      expect(answer.preview).toMatchObject({
        scope: 'speech',
        extends: expect.stringContaining('speech allowance'),
        never: expect.arrayContaining([expect.stringContaining('Speech budget'), expect.stringContaining('another payer'), expect.stringContaining('voice company')]),
        multiplier: 2,
        noLimit: false,
        endsAt: expect.any(String),
      });
      // The ask is answered, and what they have is plain words again
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, what: 'speech', answeredAt: null } })).toBe(0);
      expect((await memberUsage(sara.id)).speech).toMatchObject({ canAskForMore: false, words: 'half', extra: { multiplier: 2, noLimit: false, until: expect.any(String) } });
      expect(await checkVoiceAllowance(botId, { userId: sara.uuid, isGuest: false, turnId: randomUUID(), contract: 2 })).toMatchObject({ allowed: true });
      // Twice the allowance, not more: 200 seconds, and the next reply that would pass them is turned down as "person" again
      await spoke(100);
      expect(await checkVoiceAllowance(botId, { userId: sara.uuid, isGuest: false, turnId: randomUUID(), contract: 2 })).toMatchObject({ allowed: false, stoppedBy: 'person' });
    });

    it('never lifts the platform’s Speech budget, nor chat and computer extra usage, whatever it gives a person', async () => {
      asAdmin();
      expect((await give({ scope: 'speech', amount: 'none' })).status).toBe(201);
      // No limit on their own allowance, with the platform budget at nothing: the budget still stops it
      await saveMeterSettings({ speechBudgetMicros: 0 }, adminId);
      expect(await checkVoiceAllowance(botId, { userId: sara.uuid, isGuest: false, turnId: randomUUID(), contract: 2 })).toMatchObject({ allowed: false, stoppedBy: 'budget' });
      // And the other extra usage (chat, computer) is not running because of it
      expect(await runningExtra(sara.id, new Date())).toBeNull();
    });

    it('gives once under its key (a replay is the same grant), refuses the key reused for other figures, and ends it now', async () => {
      asAdmin();
      const key = randomUUID();
      const first = await give({ scope: 'speech', grantKey: key });
      const again = await give({ scope: 'speech', grantKey: key });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect((await again.json()).recorded).toBe(false);
      expect(await prisma.meterEntitlementGrant.count({ where: { personId: sara.id } })).toBe(1);
      expect((await give({ scope: 'speech', grantKey: key, amount: 'five' })).status).toBe(409);
      const read = await (await personGet(get(`/api/admin/users/${sara.id}/extra-usage`), ctx())).json();
      expect(read.entitlements.speech.grants).toEqual([expect.objectContaining({ grantKey: `${sara.id}:${key}`, running: true, scope: 'speech' })]);
      expect(read.entitlements.speech.preview).toMatchObject({ scope: 'speech', never: expect.any(Array) });
      expect(read.entitlements.apps.preview).toMatchObject({ scope: 'apps' });

      const ended = await personPatch(body('PATCH', `/api/admin/users/${sara.id}/extra-usage`, { grantKey: `${sara.id}:${key}`, action: 'end' }), ctx());
      expect(ended.status).toBe(200);
      expect((await ended.json()).entitlements.speech.grants[0].running).toBe(false);
    });

    it('refuses a scope it does not know, an end date in the past, and an amount that is not one of the three', async () => {
      asAdmin();
      expect((await give({ scope: 'chat' })).status).toBe(400);
      expect((await give({ scope: 'speech', endsAt: new Date(Date.now() - 1_000).toISOString() })).status).toBe(400);
      expect((await give({ scope: 'speech', amount: 'lots' })).status).toBe(400);
    });
  });

  describe('Apps', () => {
    it('answers an ask for Apps when their own monthly allowance for connected Apps is used up, and only then', async () => {
      asSara();
      await usedApp(400);
      expect((await ask('apps')).status).toBe(409);
      await usedApp(600);
      expect((await memberUsage(sara.id)).appUse).toMatchObject({ scope: 'apps', words: 'out', canAskForMore: true });
      expect((await ask('apps')).status).toBe(201);

      asAdmin();
      const given = await give({ scope: 'apps', amount: 'five' });
      expect(given.status).toBe(201);
      expect((await given.json()).preview).toMatchObject({ scope: 'apps', extends: expect.stringContaining('connected Apps'), never: expect.arrayContaining([expect.stringContaining('Apps budget')]), multiplier: 5 });
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, what: 'apps', answeredAt: null } })).toBe(0);
      expect((await memberUsage(sara.id)).appUse).toMatchObject({ canAskForMore: false, extra: { multiplier: 5 } });
    });

    it('keeps a grant of one scope from answering or lifting the other', async () => {
      await spoke(100);
      await usedApp(1_000);
      asSara();
      await ask('speech');
      await ask('apps');
      asAdmin();
      await give({ scope: 'apps' });
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, what: 'speech', answeredAt: null } })).toBe(1);
      expect(await prisma.meterRequest.count({ where: { personId: sara.id, what: 'apps', answeredAt: null } })).toBe(0);
      expect((await memberUsage(sara.id)).speech).toMatchObject({ words: 'out', extra: null });
    });
  });
});

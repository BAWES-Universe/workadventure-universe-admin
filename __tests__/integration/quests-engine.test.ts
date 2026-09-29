/**
 * The quest ledger against a real database (`npm run test:integration`, DATABASE_URL set and migrated; nothing else
 * running). Every guarantee of Quests & Orbit 3A: a retry, two tabs and a reconnect never duplicate an application or
 * a reward; one event advances two eligible quests exactly once each; a producer cannot name an objective; no
 * cross-scope read; a quest whose target is gone pauses and keeps its progress; hiding or disabling a prerequisite
 * does not satisfy it; deleting an account leaves nothing readable of it and is logged.
 */
import { prisma } from '@/lib/db';
import {
  acceptQuest,
  addQuestVersion,
  createQuestDefinition,
  deleteActorQuestData,
  ensureWelcomeChapter,
  isQuestEngineError,
  myQuests,
  publishQuestVersion,
  recordObservation,
  removeFromLog,
  stopFollowing,
  subjectTokenFor,
  trackQuest,
  updateQuestVersion,
  type VersionSpec,
} from '@/lib/quests/engine';

jest.setTimeout(60_000);

const RUN = `${Date.now().toString(36)}-${process.pid}`;
const ids = {
  alice: `quest-test-alice-${RUN}`,
  bob: `quest-test-bob-${RUN}`,
  owner: `quest-test-owner-${RUN}`,
};

let universeId: string;
let worldId: string;
let roomA: string;
let roomB: string;
let hostBot: string;
let alice: string;
let bob: string;

async function observe(actorId: string, eventId: string, action: string, extra: Partial<Parameters<typeof recordObservation>[1]> = {}) {
  return recordObservation(prisma, {
    source: 'CLIENT',
    sourceId: 'game',
    eventId: `${RUN}:${eventId}`,
    actorId,
    action,
    roomId: roomA,
    occurredAt: new Date(),
    ...extra,
  });
}

async function publish(key: string, spec: VersionSpec, scope: { scopeType: 'PLATFORM' | 'UNIVERSE' | 'WORLD' | 'ROOM'; scopeId?: string } = { scopeType: 'PLATFORM' }) {
  const definition = await createQuestDefinition(prisma, { scopeType: scope.scopeType, scopeId: scope.scopeId ?? null, key });
  const version = await addQuestVersion(prisma, definition.id, spec);
  await publishQuestVersion(prisma, version.id, ids.owner);
  return definition;
}

const stateQuest = (action: string, badge: string, target?: VersionSpec['objectives'][number]['target']): VersionSpec => ({
  objectives: [{ key: 'do', action, aggregation: 'STATE', target }],
  rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: badge }],
});

beforeAll(async () => {
  const owner = await prisma.user.create({ data: { uuid: ids.owner, name: 'Owner' } });
  alice = (await prisma.user.create({ data: { uuid: ids.alice, name: 'Alice' } })).id;
  bob = (await prisma.user.create({ data: { uuid: ids.bob, name: 'Bob' } })).id;
  const universe = await prisma.universe.create({ data: { slug: `quest-test-${RUN}`, name: 'Quest test', ownerId: owner.id } });
  universeId = universe.id;
  const world = await prisma.world.create({ data: { universeId, slug: 'w', name: 'World' } });
  worldId = world.id;
  roomA = (await prisma.room.create({ data: { worldId, slug: 'a', name: 'Room A' } })).id;
  roomB = (await prisma.room.create({ data: { worldId, slug: 'b', name: 'Room B' } })).id;
  hostBot = (await prisma.bot.create({ data: { roomId: roomA, name: 'Nova' } })).id;
});

afterAll(async () => {
  // Rows keyed to this run only; the users cascade to everything the ledger holds about them.
  await prisma.questDefinition.deleteMany({ where: { key: { startsWith: `t-${RUN}` } } });
  await prisma.questHostBinding.deleteMany({ where: { scopeId: { in: [roomA, roomB, worldId, universeId] } } });
  await prisma.questAuditLog.deleteMany({ where: { OR: [{ subjectToken: { in: [alice, bob, subjectTokenFor(alice), subjectTokenFor(bob)] } }, { byToken: ids.owner }] } });
  await prisma.universe.deleteMany({ where: { id: universeId } });
  await prisma.user.deleteMany({ where: { uuid: { in: Object.values(ids) } } });
  await prisma.$disconnect();
});

describe('the observation inbox', () => {
  it('a retry, two tabs and a reconnect never duplicate an application or a reward', async () => {
    const quest = await publish(`t-${RUN}-retry`, stateQuest('retry-action', 'retry-badge'));
    const accepted = await acceptQuest(prisma, { actorId: alice, definitionId: quest.id, roomId: roomA });
    expect(accepted.status).toBe('ACCEPTED');

    // Two tabs: the same event, five times at once.
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => observe(alice, 'retry-1', 'retry-action')));
    const first = results.find((result) => !result.reused);
    expect(first).toBeDefined();
    expect(results.filter((result) => result.reused)).toHaveLength(4);
    for (const result of results) {
      expect(result.observationId).toBe(first!.observationId);
      expect(result.applications).toEqual([expect.objectContaining({ questKey: quest.key, objectiveKey: 'do', outcome: 'COMPLETED', count: 1 })]);
      expect(result.completed).toEqual([accepted.id]);
    }

    // A retry after the fact, and a reconnect that replays the whole event, find the same answer.
    const retry = await observe(alice, 'retry-1', 'retry-action');
    expect(retry.reused).toBe(true);
    expect(retry.applications).toHaveLength(1);

    expect(await prisma.questObservation.count({ where: { actorId: alice, action: 'retry-action' } })).toBe(1);
    expect(await prisma.questObservationApplication.count({ where: { actorId: alice, attemptId: (await prisma.questProgress.findUniqueOrThrow({ where: { id: accepted.id } })).attemptId } })).toBe(1);
    expect(await prisma.questRewardGrant.findMany({ where: { actorId: alice, badgeId: 'retry-badge' } })).toHaveLength(1);

    // A second, different event for a completed quest applies to nothing and grants nothing more.
    const after = await observe(alice, 'retry-2', 'retry-action');
    expect(after.reused).toBe(false);
    expect(after.applications).toEqual([]);
    expect(await prisma.questRewardGrant.count({ where: { actorId: alice, badgeId: 'retry-badge' } })).toBe(1);
  });

  it('one event advances two eligible quests exactly once each', async () => {
    const one = await publish(`t-${RUN}-twin-1`, stateQuest('twin-action', 'twin-1'));
    const two = await publish(`t-${RUN}-twin-2`, {
      objectives: [{ key: 'count', action: 'twin-action', aggregation: 'EVENT_COUNT', threshold: 2 }],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'twin-2' }],
    });
    await acceptQuest(prisma, { actorId: alice, definitionId: one.id, roomId: roomA });
    await acceptQuest(prisma, { actorId: alice, definitionId: two.id, roomId: roomA });

    const result = await observe(alice, 'twin-1', 'twin-action');
    expect(result.applications.map((application) => [application.questKey, application.outcome, application.count]).sort()).toEqual([
      [one.key, 'COMPLETED', 1],
      [two.key, 'ADVANCED', 1],
    ]);
    const again = await observe(alice, 'twin-1', 'twin-action');
    expect(again.reused).toBe(true);
    expect(again.applications).toHaveLength(2);

    const second = await observe(alice, 'twin-2', 'twin-action');
    expect(second.applications).toEqual([expect.objectContaining({ questKey: two.key, outcome: 'COMPLETED', count: 2 })]);
    expect(await prisma.questRewardGrant.count({ where: { actorId: alice, badgeId: { in: ['twin-1', 'twin-2'] } } })).toBe(2);
  });

  it('a unique-entity set credits each entity once, and a counter stays in bounds', async () => {
    const quest = await publish(`t-${RUN}-set`, {
      objectives: [
        { key: 'people', action: 'set-action', aggregation: 'UNIQUE_SET', threshold: 2 },
        { key: 'minutes', action: 'set-time', aggregation: 'DURATION', threshold: 90 },
      ],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'set-badge' }],
    });
    await acceptQuest(prisma, { actorId: alice, definitionId: quest.id, roomId: roomA });
    expect((await observe(alice, 'set-1', 'set-action', { subject: 'p1' })).applications[0]).toMatchObject({ outcome: 'ADVANCED', count: 1 });
    expect((await observe(alice, 'set-2', 'set-action', { subject: 'p1' })).applications[0]).toMatchObject({ outcome: 'DUPLICATE', count: 1 });
    expect((await observe(alice, 'set-3', 'set-action')).applications[0]).toMatchObject({ outcome: 'OUT_OF_BOUNDS', count: 1 });
    expect((await observe(alice, 'set-4', 'set-action', { subject: 'p2' })).applications[0]).toMatchObject({ outcome: 'SATISFIED', count: 2 });

    expect((await observe(alice, 'set-5', 'set-time', { evidence: { seconds: 60 * 60 * 24 } })).applications[0]).toMatchObject({ outcome: 'OUT_OF_BOUNDS', count: 0 });
    expect((await observe(alice, 'set-6', 'set-time', { evidence: { seconds: 60 } })).applications[0]).toMatchObject({ outcome: 'ADVANCED', count: 60 });
    expect((await observe(alice, 'set-7', 'set-time', { evidence: { seconds: 3600 } })).applications[0]).toMatchObject({ outcome: 'COMPLETED', count: 90 });
  });

  it('client evidence cannot advance an objective that asks for the server, and a grant is withheld and logged', async () => {
    const quest = await publish(`t-${RUN}-evidence`, {
      objectives: [
        { key: 'weak', action: 'ev-weak', aggregation: 'STATE', evidence: 'CLIENT' },
        { key: 'strong', action: 'ev-strong', aggregation: 'STATE', evidence: 'SERVER', requiredForCompletion: false },
      ],
      rewards: [
        { key: 'stamp', kind: 'BADGE', badgeId: 'ev-badge', evidence: 'CLIENT' },
        { key: 'points', kind: 'POINTS', value: 500, evidence: 'SERVER' },
      ],
    });
    await acceptQuest(prisma, { actorId: alice, definitionId: quest.id, roomId: roomA });
    expect((await observe(alice, 'ev-1', 'ev-strong')).applications[0]).toMatchObject({ outcome: 'EVIDENCE_TOO_WEAK', count: 0 });
    const done = await observe(alice, 'ev-2', 'ev-weak');
    expect(done.applications[0]).toMatchObject({ outcome: 'COMPLETED' });
    const grants = await prisma.questRewardGrant.findMany({ where: { actorId: alice, versionId: done.applications[0] && (await prisma.questProgress.findUniqueOrThrow({ where: { id: done.applications[0].progressId } })).versionId } });
    expect(grants.map((grant) => grant.kind)).toEqual(['BADGE']);
    expect(await prisma.questAuditLog.count({ where: { action: 'withhold', subjectToken: alice, reason: 'withheld-evidence' } })).toBe(1);
    expect(await prisma.questAuditLog.count({ where: { action: 'grant', subjectToken: alice, source: 'CLIENT' } })).toBeGreaterThan(0);
  });

  it('records an observation without an actor claim from another account', async () => {
    await observe(alice, 'mine-1', 'retry-action');
    await expect(observe(bob, 'mine-1', 'retry-action')).rejects.toMatchObject({ code: 'invalid-observation' });
    expect(await prisma.questObservation.count({ where: { actorId: bob } })).toBe(0);
  });
});

describe('scope', () => {
  it('a room quest is neither accepted nor advanced from another room, and nobody reads across actors', async () => {
    const quest = await publish(`t-${RUN}-room`, stateQuest('room-action', 'room-badge'), { scopeType: 'ROOM', scopeId: roomA });
    await expect(acceptQuest(prisma, { actorId: alice, definitionId: quest.id, roomId: roomB })).rejects.toMatchObject({ code: 'out-of-scope' });
    await expect(acceptQuest(prisma, { actorId: alice, key: quest.key, roomId: roomB })).rejects.toMatchObject({ code: 'not-found' });
    const accepted = await acceptQuest(prisma, { actorId: alice, key: quest.key, roomId: roomA });

    const elsewhere = await observe(alice, 'room-1', 'room-action', { roomId: roomB });
    expect(elsewhere.applications).toEqual([]);
    const here = await observe(alice, 'room-2', 'room-action', { roomId: roomA });
    expect(here.applications).toEqual([expect.objectContaining({ progressId: accepted.id, outcome: 'COMPLETED' })]);

    const bobsLog = await myQuests(prisma, bob, roomA);
    expect(bobsLog.quests.find((row) => row.key === quest.key)).toBeUndefined();
    expect(bobsLog.badges).toEqual([]);
    await expect(stopFollowing(prisma, bob, accepted.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(removeFromLog(prisma, bob, accepted.id)).rejects.toMatchObject({ code: 'not-found' });
    await expect(trackQuest(prisma, { actorId: bob, progressId: accepted.id, revision: 0 })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a published version never changes; a new one takes over for new acceptances', async () => {
    const quest = await publish(`t-${RUN}-immutable`, stateQuest('imm-action', 'imm-badge'));
    const published = await prisma.questVersion.findFirstOrThrow({ where: { definitionId: quest.id, status: 'PUBLISHED' } });
    await expect(updateQuestVersion(prisma, published.id, stateQuest('other', 'imm-badge'))).rejects.toMatchObject({ code: 'version-immutable' });

    const draft = await addQuestVersion(prisma, quest.id, stateQuest('imm-action-2', 'imm-badge'));
    await publishQuestVersion(prisma, draft.id, ids.owner);
    expect((await prisma.questVersion.findUniqueOrThrow({ where: { id: published.id } })).status).toBe('RETIRED');
    const accepted = await acceptQuest(prisma, { actorId: bob, definitionId: quest.id, roomId: roomA });
    expect(accepted.version).toBe(2);
  });
});

describe('a quest whose target is gone', () => {
  it('pauses with a reason, keeps its progress, resumes when the host is back, and is never satisfied by hiding the host', async () => {
    const quest = await publish(`t-${RUN}-host`, {
      objectives: [
        { key: 'warm-up', action: 'host-warm', aggregation: 'STATE' },
        { key: 'greet', action: 'host-greet', aggregation: 'STATE', target: { kind: 'role', role: 'host' } },
      ],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'host-badge' }],
    });
    // Nobody is bound as the host here: the quest pauses on acceptance, with its reason.
    const accepted = await acceptQuest(prisma, { actorId: alice, definitionId: quest.id, roomId: roomA });
    expect(accepted).toMatchObject({ status: 'PAUSED', pauseReason: 'no-eligible-target' });

    // A paused quest does not advance; its earlier progress is kept.
    expect((await observe(alice, 'host-0', 'host-warm')).applications).toEqual([]);

    // The room's owner binds a bot as its host: the next observation resumes and applies.
    await prisma.questHostBinding.create({ data: { scopeType: 'ROOM', scopeId: roomA, hostKind: 'bot', hostId: hostBot } });
    const warm = await observe(alice, 'host-1', 'host-warm');
    expect(warm.applications).toEqual([expect.objectContaining({ objectiveKey: 'warm-up', outcome: 'SATISFIED' })]);
    expect((await prisma.questProgress.findUniqueOrThrow({ where: { id: accepted.id } })).status).toBe('ACCEPTED');

    // Greeting someone who is not the host does not count.
    expect((await observe(alice, 'host-2', 'host-greet', { subject: 'bot-someone-else' })).applications).toEqual([]);

    // The host bot is disabled: the quest pauses again, and the greet objective stays open (hiding never satisfies).
    await prisma.bot.update({ where: { id: hostBot }, data: { enabled: false } });
    const paused = await observe(alice, 'host-3', 'host-greet', { subject: `bot-${hostBot}` });
    expect(paused.applications).toEqual([]);
    const row = await prisma.questProgress.findUniqueOrThrow({ where: { id: accepted.id }, include: { objectives: true } });
    expect(row).toMatchObject({ status: 'PAUSED', pauseReason: 'no-eligible-target' });
    expect(row.objectives.filter((objective) => objective.satisfiedAt !== null)).toHaveLength(1);
    expect(await prisma.questRewardGrant.count({ where: { actorId: alice, badgeId: 'host-badge' } })).toBe(0);

    // Back on: the greeting completes the quest, once.
    await prisma.bot.update({ where: { id: hostBot }, data: { enabled: true } });
    const done = await observe(alice, 'host-4', 'host-greet', { subject: `bot-${hostBot}` });
    expect(done.applications).toEqual([expect.objectContaining({ objectiveKey: 'greet', outcome: 'COMPLETED' })]);
    expect(await prisma.questRewardGrant.count({ where: { actorId: alice, badgeId: 'host-badge' } })).toBe(1);
  });

  it('an any-of group with one alternative left is not paused', async () => {
    const quest = await publish(`t-${RUN}-anyof`, {
      objectives: [
        { key: 'greet-host', action: 'any-greet', aggregation: 'STATE', target: { kind: 'role', role: 'host' }, anyOfGroup: 'greet' },
        { key: 'greet-anyone', action: 'any-greet', aggregation: 'STATE', anyOfGroup: 'greet' },
      ],
      rewards: [{ key: 'stamp', kind: 'BADGE', badgeId: 'any-badge' }],
    });
    const accepted = await acceptQuest(prisma, { actorId: bob, definitionId: quest.id, roomId: roomB });
    expect(accepted.status).toBe('ACCEPTED');
    const done = await recordObservation(prisma, {
      source: 'CLIENT',
      sourceId: 'game',
      eventId: `${RUN}:any-1`,
      actorId: bob,
      action: 'any-greet',
      subject: 'someone',
      roomId: roomB,
      occurredAt: new Date(),
    });
    expect(done.applications).toEqual([expect.objectContaining({ objectiveKey: 'greet-anyone', outcome: 'COMPLETED' })]);
  });
});

describe("a person's log", () => {
  it('tracks one quest with a revision two tabs cannot both win, stops, removes and comes back', async () => {
    const quest = await publish(`t-${RUN}-log`, stateQuest('log-action', 'log-badge'));
    const accepted = await acceptQuest(prisma, { actorId: bob, definitionId: quest.id, roomId: roomA });
    const before = await myQuests(prisma, bob, roomA);
    const tracked = await trackQuest(prisma, { actorId: bob, progressId: accepted.id, revision: before.tracked.revision });
    expect(tracked.progressId).toBe(accepted.id);
    await expect(trackQuest(prisma, { actorId: bob, progressId: null, revision: before.tracked.revision })).rejects.toMatchObject({
      code: 'stale-revision',
      details: { progressId: accepted.id, revision: tracked.revision },
    });

    const stopped = await stopFollowing(prisma, bob, accepted.id);
    expect(stopped.status).toBe('STOPPED');
    let log = await myQuests(prisma, bob, roomA);
    expect(log.tracked.progressId).toBeNull();
    expect(log.tracked.revision).toBe(tracked.revision + 1);
    expect(log.quests.find((row) => row.id === accepted.id)?.status).toBe('STOPPED');

    await removeFromLog(prisma, bob, accepted.id);
    log = await myQuests(prisma, bob, roomA);
    expect(log.quests.find((row) => row.id === accepted.id)).toBeUndefined();

    const again = await acceptQuest(prisma, { actorId: bob, definitionId: quest.id, roomId: roomA });
    expect(again.id).toBe(accepted.id);
    expect(again.status).toBe('ACCEPTED');
    log = await myQuests(prisma, bob, roomA);
    expect(log.quests.find((row) => row.id === accepted.id)?.status).toBe('ACCEPTED');
  });

  it('offers the Welcome chapter on any fresh database, once', async () => {
    await ensureWelcomeChapter(prisma);
    await ensureWelcomeChapter(prisma);
    const keys = await prisma.questDefinition.findMany({ where: { scopeType: 'PLATFORM', key: { startsWith: 'welcome.' } }, select: { key: true } });
    expect(keys.map((row) => row.key).sort()).toEqual(['welcome.build', 'welcome.explore', 'welcome.meet']);
    expect(await prisma.questVersion.count({ where: { definition: { scopeType: 'PLATFORM', key: 'welcome.meet' }, status: 'PUBLISHED' } })).toBe(1);
    const accepted = await acceptQuest(prisma, { actorId: bob, key: 'welcome.meet', roomId: roomA });
    const done = await observe(bob, 'welcome-1', 'hello-exchanged', { subject: `bot-${hostBot}` });
    expect(done.completed).toEqual([accepted.id]);
    expect((await myQuests(prisma, bob, roomA)).badges.map((badge) => badge.badgeId)).toContain('first-hello');
  });
});

describe('deleting an account', () => {
  it('leaves nothing readable, unlinks partners, keeps aggregates under a token and logs who did it', async () => {
    await prisma.questPartnerLink.create({ data: { actorId: alice, partnerId: 'partner-x', externalSubject: `ext-${RUN}` } });
    const grantsBefore = await prisma.questAuditLog.count({ where: { action: 'grant', subjectToken: alice } });
    expect(grantsBefore).toBeGreaterThan(0);

    const report = await deleteActorQuestData(prisma, { actorId: alice, byToken: ids.owner, scope: 'account' });
    expect(report.subjectToken).toMatch(/^deleted:[0-9a-f]{40}$/);
    expect(report.subjectToken).not.toContain(alice);
    expect(report.removed.progress).toBeGreaterThan(0);
    expect(report.removed.grants).toBeGreaterThan(0);

    const where = { where: { actorId: alice } };
    expect(
      await Promise.all([
        prisma.questAttempt.count(where),
        prisma.questProgress.count(where),
        prisma.questObservation.count(where),
        prisma.questObservationApplication.count(where),
        prisma.questRewardGrant.count(where),
        prisma.questGuidancePreference.count(where),
      ]),
    ).toEqual([0, 0, 0, 0, 0, 0]);
    expect(await prisma.questTrackedSelection.count({ where: { actorId: alice } })).toBe(0);
    const link = await prisma.questPartnerLink.findUniqueOrThrow({ where: { partnerId_externalSubject: { partnerId: 'partner-x', externalSubject: `ext-${RUN}` } } });
    expect(link.actorId).toBeNull();
    expect(link.unlinkedAt).not.toBeNull();
    await prisma.questPartnerLink.delete({ where: { id: link.id } });

    expect(await prisma.questAuditLog.count({ where: { subjectToken: alice } })).toBe(0);
    expect(await prisma.questAuditLog.count({ where: { action: 'grant', subjectToken: report.subjectToken } })).toBe(grantsBefore);
    const entry = await prisma.questAuditLog.findFirstOrThrow({ where: { action: 'delete-account', subjectToken: report.subjectToken } });
    expect(entry.byToken).toBe(ids.owner);
    expect(entry.reason).toBe('account');
    expect(entry.details).toMatchObject({ removed: report.removed });
    expect(isQuestEngineError(new Error('x'))).toBe(false);
  });
});

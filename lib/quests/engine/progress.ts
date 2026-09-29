import type { PrismaClient, QuestProgressStatus, QuestScopeType } from '@prisma/client';
import type { QuestDb } from './db';
import { QuestEngineError } from './errors';
import { progressInclude, reconcilePause, type LoadedProgress } from './ledger';
import { MAX_ACTIVE_PROGRESS_PER_ACTOR } from './limits';
import { attemptWindow } from './recurrence';
import { scopeApplies, scopeChainForRoom, scopesOf, type ScopeChain } from './scope';
import { parseTarget } from './targets';

/**
 * A person's own quests: accept, track one, stop following, remove from the log, "I know this", and read it all back.
 * Every call is scoped to one actor; nothing here reads another person's rows.
 */

export interface ProgressObjectiveView {
  key: string;
  action: string;
  aggregation: string;
  count: number;
  threshold: number;
  satisfied: boolean;
  required: boolean;
  target: ReturnType<typeof parseTarget>;
}

export interface ProgressView {
  id: string;
  questId: string;
  key: string;
  scope: { type: QuestScopeType; id: string | null };
  version: number;
  title: string | null;
  purpose: string | null;
  recurrence: string;
  status: QuestProgressStatus;
  pauseReason: string | null;
  acceptedAt: string;
  completedAt: string | null;
  attempt: { startsAt: string; endsAt: string | null };
  objectives: ProgressObjectiveView[];
}

export interface BadgeView {
  badgeId: string;
  questId: string;
  questKey: string;
  grantedAt: string;
}

export interface MyQuests {
  quests: ProgressView[];
  tracked: { progressId: string | null; revision: number };
  badges: BadgeView[];
  points: number;
  known: string[];
}

export function progressView(progress: LoadedProgress): ProgressView {
  return {
    id: progress.id,
    questId: progress.definitionId,
    key: progress.definition.key,
    scope: { type: progress.definition.scopeType, id: progress.definition.scopeId || null },
    version: progress.version.number,
    title: progress.version.title,
    purpose: progress.version.purpose,
    recurrence: progress.version.recurrence,
    status: progress.status,
    pauseReason: progress.pauseReason,
    acceptedAt: progress.acceptedAt.toISOString(),
    completedAt: progress.completedAt?.toISOString() ?? null,
    attempt: { startsAt: progress.attempt.startsAt.toISOString(), endsAt: progress.attempt.endsAt?.toISOString() ?? null },
    objectives: progress.version.objectives.map((objective) => {
      const row = progress.objectives.find((candidate) => candidate.objectiveId === objective.id);
      return {
        key: objective.key,
        action: objective.action,
        aggregation: objective.aggregation,
        count: row?.count ?? 0,
        threshold: objective.threshold,
        satisfied: row?.satisfiedAt !== null && row?.satisfiedAt !== undefined,
        required: objective.requiredForCompletion,
        target: parseTarget(objective.target),
      };
    }),
  };
}

/** A quest by key, the nearest scope first: a room's "welcome.meet" shadows the platform's. */
export async function findDefinitionByKey(db: QuestDb, key: string, chain: ScopeChain) {
  for (const scope of scopesOf(chain)) {
    const definition = await db.questDefinition.findUnique({
      where: { scopeType_scopeId_key: { scopeType: scope.scopeType, scopeId: scope.scopeId, key } },
    });
    if (definition) return definition;
  }
  return null;
}

export interface AcceptInput {
  actorId: string;
  /** The quest's id, or its key resolved from where the person is. */
  definitionId?: string;
  key?: string;
  roomId?: string | null;
}

/**
 * Accepts a quest for the attempt the current time falls in. A second acceptance of the same attempt returns it; a
 * stopped one is followed again with the progress it kept. A quest out of scope for this room is refused.
 */
export async function acceptQuest(prisma: PrismaClient, input: AcceptInput, now = new Date()): Promise<ProgressView> {
  return prisma.$transaction(async (tx) => {
    const chain = await scopeChainForRoom(tx, input.roomId);
    const definition = input.definitionId
      ? await tx.questDefinition.findUnique({ where: { id: input.definitionId } })
      : input.key
        ? await findDefinitionByKey(tx, input.key, chain)
        : null;
    if (!definition) throw new QuestEngineError('not-found', 'No such quest.');
    if (!scopeApplies(definition, chain)) throw new QuestEngineError('out-of-scope', 'This quest is not offered here.');
    if (definition.pausedAt) throw new QuestEngineError('paused', 'This quest is paused by its owner.');
    const version = await tx.questVersion.findFirst({ where: { definitionId: definition.id, status: 'PUBLISHED' }, select: { id: true, recurrence: true } });
    if (!version) throw new QuestEngineError('not-published', 'This quest is not published.');

    const window = attemptWindow(version.recurrence, now);
    const attempt = await tx.questAttempt.upsert({
      where: { versionId_actorId_startsAt: { versionId: version.id, actorId: input.actorId, startsAt: window.startsAt } },
      create: { versionId: version.id, actorId: input.actorId, startsAt: window.startsAt, endsAt: window.endsAt },
      update: {},
      select: { id: true },
    });
    let progress = await tx.questProgress.findUnique({ where: { attemptId: attempt.id }, include: progressInclude });
    if (progress) {
      if (progress.status === 'STOPPED') {
        await tx.questProgress.update({ where: { id: progress.id }, data: { status: 'ACCEPTED', hiddenAt: null, pauseReason: null } });
        progress.status = 'ACCEPTED';
        progress.hiddenAt = null;
      } else if (progress.hiddenAt) {
        await tx.questProgress.update({ where: { id: progress.id }, data: { hiddenAt: null } });
        progress.hiddenAt = null;
      }
    } else {
      const active = await tx.questProgress.count({ where: { actorId: input.actorId, status: { in: ['ACCEPTED', 'PAUSED'] } } });
      if (active >= MAX_ACTIVE_PROGRESS_PER_ACTOR) throw new QuestEngineError('too-many-quests', 'Too many quests in progress.');
      progress = await tx.questProgress.create({
        data: { definitionId: definition.id, versionId: version.id, attemptId: attempt.id, actorId: input.actorId, acceptedAt: now },
        include: progressInclude,
      });
    }
    await reconcilePause(tx, progress, chain, now);
    return progressView(progress);
  });
}

async function ownProgress(db: QuestDb, actorId: string, progressId: string) {
  const progress = await db.questProgress.findFirst({ where: { id: progressId, actorId }, include: progressInclude });
  if (!progress) throw new QuestEngineError('not-found', 'No such quest in your log.');
  return progress;
}

export interface TrackInput {
  actorId: string;
  /** Null: follow nothing. */
  progressId: string | null;
  /** The revision the caller last saw; a different one means another tab changed it first. */
  revision: number;
}

/** The one quest on the map, with a server revision so two tabs never fight over it. */
export async function trackQuest(prisma: PrismaClient, input: TrackInput): Promise<{ progressId: string | null; revision: number }> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.questTrackedSelection.findUnique({ where: { actorId: input.actorId } });
    const revision = current?.revision ?? 0;
    if (revision !== input.revision) {
      throw new QuestEngineError('stale-revision', 'Another tab changed what you follow.', { progressId: current?.progressId ?? null, revision });
    }
    if (input.progressId !== null) {
      const progress = await ownProgress(tx, input.actorId, input.progressId);
      if (progress.status !== 'ACCEPTED' && progress.status !== 'PAUSED') throw new QuestEngineError('not-accepted', 'Only a quest in progress can be followed.');
    }
    const saved = await tx.questTrackedSelection.upsert({
      where: { actorId: input.actorId },
      create: { actorId: input.actorId, progressId: input.progressId, revision: 1 },
      update: { progressId: input.progressId, revision: revision + 1 },
    });
    return { progressId: saved.progressId, revision: saved.revision };
  });
}

async function untrackIf(db: QuestDb, actorId: string, progressId: string) {
  const current = await db.questTrackedSelection.findUnique({ where: { actorId } });
  if (current?.progressId === progressId) {
    await db.questTrackedSelection.update({ where: { actorId }, data: { progressId: null, revision: current.revision + 1 } });
  }
}

/** Stops following a quest: it leaves the map and the active list, and keeps its progress for when it is accepted again. */
export async function stopFollowing(prisma: PrismaClient, actorId: string, progressId: string): Promise<ProgressView> {
  return prisma.$transaction(async (tx) => {
    const progress = await ownProgress(tx, actorId, progressId);
    if (progress.status === 'ACCEPTED' || progress.status === 'PAUSED') {
      await tx.questProgress.update({ where: { id: progress.id }, data: { status: 'STOPPED', pauseReason: null } });
      progress.status = 'STOPPED';
      progress.pauseReason = null;
    }
    await untrackIf(tx, actorId, progress.id);
    return progressView(progress);
  });
}

/** Removes a quest from the person's log. The record and its grants stay; accepting it again shows it again. */
export async function removeFromLog(prisma: PrismaClient, actorId: string, progressId: string, now = new Date()): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const progress = await ownProgress(tx, actorId, progressId);
    const data = progress.status === 'ACCEPTED' || progress.status === 'PAUSED' ? { hiddenAt: now, status: 'STOPPED' as const, pauseReason: null } : { hiddenAt: now };
    await tx.questProgress.update({ where: { id: progress.id }, data });
    await untrackIf(tx, actorId, progress.id);
  });
}

const CAPABILITY_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** "I know this": the capability is not taught again anywhere. */
export async function knowCapability(db: QuestDb, actorId: string, capabilityKey: string, state: 'KNOWN' | 'DISMISSED' = 'KNOWN') {
  if (!CAPABILITY_KEY.test(capabilityKey)) throw new QuestEngineError('invalid-spec', 'A capability key is lowercase letters, digits, dots and dashes.');
  return db.questGuidancePreference.upsert({
    where: { actorId_capabilityKey: { actorId, capabilityKey } },
    create: { actorId, capabilityKey, state },
    update: { state },
  });
}

/** Everything the person's log shows. Quests whose target went away are paused here too, so the log is never stale. */
export async function myQuests(db: QuestDb, actorId: string, roomId: string | null | undefined, now = new Date()): Promise<MyQuests> {
  const chain = await scopeChainForRoom(db, roomId);
  const [rows, tracked, grants, guidance] = await Promise.all([
    db.questProgress.findMany({ where: { actorId, hiddenAt: null }, include: progressInclude, orderBy: [{ acceptedAt: 'desc' }] }),
    db.questTrackedSelection.findUnique({ where: { actorId } }),
    db.questRewardGrant.findMany({
      where: { actorId, revokedAt: null },
      select: { kind: true, value: true, badgeId: true, grantedAt: true, version: { select: { definition: { select: { id: true, key: true } } } } },
      orderBy: { grantedAt: 'asc' },
    }),
    db.questGuidancePreference.findMany({ where: { actorId, state: 'KNOWN' }, select: { capabilityKey: true } }),
  ]);
  for (const progress of rows) {
    if (roomId && scopeApplies(progress.definition, chain)) await reconcilePause(db, progress, chain, now);
  }
  const trackedId = tracked?.progressId && rows.some((row) => row.id === tracked.progressId && (row.status === 'ACCEPTED' || row.status === 'PAUSED')) ? tracked.progressId : null;
  return {
    quests: rows.map(progressView),
    tracked: { progressId: trackedId, revision: tracked?.revision ?? 0 },
    badges: grants
      .filter((grant) => grant.kind === 'BADGE' && grant.badgeId)
      .map((grant) => ({ badgeId: grant.badgeId as string, questId: grant.version.definition.id, questKey: grant.version.definition.key, grantedAt: grant.grantedAt.toISOString() })),
    points: grants.filter((grant) => grant.kind === 'POINTS').reduce((sum, grant) => sum + grant.value, 0),
    known: guidance.map((row) => row.capabilityKey),
  };
}

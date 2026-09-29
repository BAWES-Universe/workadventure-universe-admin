import { Prisma, type PrismaClient, type QuestApplicationOutcome, type QuestEvidence } from '@prisma/client';
import { advance, evidenceStep, minimalEvidence, type ObservationEvidence } from './aggregation';
import type { QuestDb } from './db';
import { QuestEngineError } from './errors';
import {
  grantReward,
  openObjectives,
  progressInclude,
  questComplete,
  reconcilePause,
  type LoadedObjective,
  type LoadedProgress,
} from './ledger';
import {
  ACTION_PATTERN,
  EVENT_ID_PATTERN,
  MAX_OCCURRED_AT_SKEW_MS,
  MAX_SUBJECT_LENGTH,
  RATE_LIMIT_MAX_APPLICATIONS,
  RATE_LIMIT_WINDOW_MS,
  SOURCE_ID_PATTERN,
  evidenceCovers,
} from './limits';
import { inWindow } from './recurrence';
import { scopeChainForRoom, scopeWhere, type ScopeChain } from './scope';
import { parseTarget, resolveHost, targetMatches, type ResolvedHost } from './targets';

/**
 * The observation inbox. One call records an action once (unique per source and event id) and, in one transaction,
 * applies it to every eligible objective of every quest the actor has accepted, exactly once each, advancing progress
 * and granting rewards. A retry, a second tab or a reconnect that sends the same event again finds the observation
 * already applied and gets the same answer back.
 */

export interface ObservationInput {
  source: QuestEvidence;
  /** Which producer of that class: "game" for the client, a partner's id, a map script's id. */
  sourceId: string;
  /** The producer's own id for the event; the same id is the same event. */
  eventId: string;
  actorId: string;
  /** What happened, e.g. "hello-exchanged". Never an objective: the engine picks those. */
  action: string;
  subject?: string | null;
  roomId?: string | null;
  occurredAt: Date;
  evidence?: ObservationEvidence | null;
}

export interface ObservationApplied {
  progressId: string;
  questId: string;
  questKey: string;
  objectiveKey: string;
  outcome: QuestApplicationOutcome;
  count: number;
  threshold: number;
}

export interface ObservationResult {
  observationId: string;
  /** The event was already recorded: these are the applications of the first time it came. */
  reused: boolean;
  applications: ObservationApplied[];
  /** Quests this observation completed. */
  completed: string[];
}

export function validateObservationInput(input: ObservationInput, now: Date): void {
  if (!SOURCE_ID_PATTERN.test(input.sourceId)) throw new QuestEngineError('invalid-observation', 'A source id is letters, digits, dots and dashes.');
  if (!EVENT_ID_PATTERN.test(input.eventId)) throw new QuestEngineError('invalid-observation', 'An event id is letters, digits, dots, colons and dashes; up to 128.');
  if (!ACTION_PATTERN.test(input.action)) throw new QuestEngineError('invalid-observation', 'An action is lowercase letters, digits, dots and dashes.');
  if (input.subject != null && (typeof input.subject !== 'string' || !input.subject || input.subject.length > MAX_SUBJECT_LENGTH)) {
    throw new QuestEngineError('invalid-observation', `A subject is up to ${MAX_SUBJECT_LENGTH} characters.`);
  }
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new QuestEngineError('invalid-observation', 'occurredAt must be a time.');
  }
  if (Math.abs(input.occurredAt.getTime() - now.getTime()) > MAX_OCCURRED_AT_SKEW_MS) {
    throw new QuestEngineError('invalid-observation', 'occurredAt is too far from now.');
  }
}

interface Applying {
  progress: LoadedProgress;
  chain: ScopeChain;
  observation: { id: string; source: QuestEvidence; sourceId: string; subject: string | null; evidence: ObservationEvidence | null };
  now: Date;
  applications: ObservationApplied[];
  completed: string[];
}

async function recordApplication(
  db: QuestDb,
  { progress, observation, applications }: Applying,
  objective: LoadedObjective,
  outcome: QuestApplicationOutcome,
  count: number,
  entityKey: string | null = null,
) {
  await db.questObservationApplication.create({
    data: {
      observationId: observation.id,
      actorId: progress.actorId,
      versionId: progress.versionId,
      attemptId: progress.attemptId,
      objectiveId: objective.id,
      outcome,
      countAfter: count,
      entityKey,
    },
  });
  applications.push({
    progressId: progress.id,
    questId: progress.definitionId,
    questKey: progress.definition.key,
    objectiveKey: objective.key,
    outcome,
    count,
    threshold: objective.threshold,
  });
}

async function applyToObjective(db: QuestDb, applying: Applying, objective: LoadedObjective): Promise<boolean> {
  const { progress, observation, now } = applying;
  const row = progress.objectives.find((candidate) => candidate.objectiveId === objective.id);
  const count = row?.count ?? 0;

  if (!evidenceCovers(observation.source, objective.evidence)) {
    await recordApplication(db, applying, objective, 'EVIDENCE_TOO_WEAK', count);
    return false;
  }
  const step = evidenceStep(objective, observation.evidence);
  if (step === null) {
    await recordApplication(db, applying, objective, 'OUT_OF_BOUNDS', count);
    return false;
  }
  let entityKey: string | null = null;
  if (objective.aggregation === 'UNIQUE_SET') {
    entityKey = observation.subject;
    if (entityKey === null) {
      await recordApplication(db, applying, objective, 'OUT_OF_BOUNDS', count);
      return false;
    }
    const seen = await db.questObservationApplication.findFirst({
      where: { attemptId: progress.attemptId, objectiveId: objective.id, entityKey },
      select: { id: true },
    });
    if (seen) {
      await recordApplication(db, applying, objective, 'DUPLICATE', count);
      return false;
    }
  }

  const next = advance(objective, count, step);
  await db.questObjectiveProgress.upsert({
    where: { progressId_objectiveId: { progressId: progress.id, objectiveId: objective.id } },
    create: { progressId: progress.id, objectiveId: objective.id, count: next.count, satisfiedAt: next.satisfied ? now : null },
    update: { count: next.count, ...(next.satisfied ? { satisfiedAt: now } : {}) },
  });
  if (row) {
    row.count = next.count;
    if (next.satisfied) row.satisfiedAt = now;
  } else {
    progress.objectives.push({
      id: '',
      progressId: progress.id,
      objectiveId: objective.id,
      count: next.count,
      satisfiedAt: next.satisfied ? now : null,
      updatedAt: now,
    });
  }
  await recordApplication(db, applying, objective, next.satisfied ? 'SATISFIED' : 'ADVANCED', next.count, entityKey);

  if (next.satisfied && objective.creditTiming === 'IMMEDIATE') {
    for (const rule of progress.version.rewardRules.filter((candidate) => candidate.objectiveKey === objective.key)) {
      await grantReward(db, progress, rule, { observationId: observation.id, evidence: observation.source, sourceLabel: observation.sourceId, now });
    }
  }
  return next.satisfied;
}

async function applyToProgress(db: QuestDb, applying: Applying, action: string): Promise<void> {
  const { progress, chain, observation, now } = applying;
  const objectives = openObjectives(progress, action);
  if (!objectives.length) return;

  const since = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  const recent = await db.questObservationApplication.count({
    where: { actorId: progress.actorId, versionId: progress.versionId, createdAt: { gte: since }, observation: { source: observation.source } },
  });
  const limited = recent >= RATE_LIMIT_MAX_APPLICATIONS;

  let host: ResolvedHost | null | undefined;
  for (const objective of objectives) {
    const target = parseTarget(objective.target);
    if (target?.kind === 'role' && host === undefined) host = await resolveHost(db, chain, progress.definition.key);
    if (!targetMatches(target, observation.subject, host ?? null)) continue;
    if (limited) {
      const row = progress.objectives.find((candidate) => candidate.objectiveId === objective.id);
      await recordApplication(db, applying, objective, 'RATE_LIMITED', row?.count ?? 0);
      continue;
    }
    await applyToObjective(db, applying, objective);
  }

  if (progress.status !== 'COMPLETED' && questComplete(progress)) {
    await db.questProgress.update({ where: { id: progress.id }, data: { status: 'COMPLETED', completedAt: now, pauseReason: null } });
    progress.status = 'COMPLETED';
    applying.completed.push(progress.id);
    // The objective that finished the quest reads COMPLETED, in the answer and in the ledger a retry reads back.
    await db.questObservationApplication.updateMany({
      where: { observationId: observation.id, attemptId: progress.attemptId, outcome: 'SATISFIED' },
      data: { outcome: 'COMPLETED' },
    });
    for (const application of applying.applications) {
      if (application.progressId === progress.id && application.outcome === 'SATISFIED') application.outcome = 'COMPLETED';
    }
    const cause = { observationId: observation.id, evidence: observation.source, sourceLabel: observation.sourceId, now };
    for (const rule of progress.version.rewardRules) {
      if (rule.objectiveKey === null) {
        await grantReward(db, progress, rule, cause);
        continue;
      }
      const objective = progress.version.objectives.find((candidate) => candidate.key === rule.objectiveKey);
      if (objective?.creditTiming === 'ON_COMPLETION') await grantReward(db, progress, rule, cause);
    }
  }
}

function summarise(observationId: string, reused: boolean, rows: Array<{ outcome: QuestApplicationOutcome; countAfter: number; objective: { key: string; threshold: number }; attempt: { progress: { id: string; definitionId: string; definition: { key: string } } | null } }>): ObservationResult {
  const applications: ObservationApplied[] = [];
  const completed = new Set<string>();
  for (const row of rows) {
    const progress = row.attempt.progress;
    if (!progress) continue;
    applications.push({
      progressId: progress.id,
      questId: progress.definitionId,
      questKey: progress.definition.key,
      objectiveKey: row.objective.key,
      outcome: row.outcome,
      count: row.countAfter,
      threshold: row.objective.threshold,
    });
    if (row.outcome === 'COMPLETED') completed.add(progress.id);
  }
  return { observationId, reused, applications, completed: [...completed] };
}

const appliedInclude = {
  objective: { select: { key: true, threshold: true } },
  attempt: {
    select: {
      progress: {
        select: { id: true, definitionId: true, definition: { select: { key: true } } },
      },
    },
  },
} satisfies Prisma.QuestObservationApplicationInclude;

/**
 * Records the observation and applies it. Needs the root client: the insert runs on its own so a duplicate is found
 * without aborting a transaction, then the application runs inside one that holds the observation's row lock.
 */
export async function recordObservation(prisma: PrismaClient, input: ObservationInput, now = new Date()): Promise<ObservationResult> {
  validateObservationInput(input, now);
  const evidence = minimalEvidence(input.evidence);

  // Insert-or-find without raising: the unique (source, source id, event id) makes a retry find the first row.
  await prisma.questObservation.createMany({
    data: [
      {
        source: input.source,
        sourceId: input.sourceId,
        eventId: input.eventId,
        actorId: input.actorId,
        action: input.action,
        subject: input.subject ?? null,
        roomId: input.roomId ?? null,
        occurredAt: input.occurredAt,
        receivedAt: now,
        evidence: evidence ? { ...evidence } : undefined,
      },
    ],
    skipDuplicates: true,
  });
  const stored = await prisma.questObservation.findUnique({
    where: { source_sourceId_eventId: { source: input.source, sourceId: input.sourceId, eventId: input.eventId } },
    select: { id: true, actorId: true },
  });
  if (!stored) throw new QuestEngineError('invalid-observation', 'The observation could not be recorded.');
  // Someone else's event id is never applied to this actor, nor told about.
  if (stored.actorId !== input.actorId) throw new QuestEngineError('invalid-observation', 'This event id belongs to another account.');
  const observationId = stored.id;

  return prisma.$transaction(
    async (tx) => {
      // Serialises every retry of the same event behind the first; the first's insert already holds this lock.
      await tx.$queryRaw`SELECT id FROM quest_observations WHERE id = ${observationId} FOR UPDATE`;
      const observation = await tx.questObservation.findUniqueOrThrow({ where: { id: observationId } });
      if (observation.appliedAt !== null) {
        const rows = await tx.questObservationApplication.findMany({ where: { observationId }, include: appliedInclude, orderBy: { createdAt: 'asc' } });
        return summarise(observationId, true, rows);
      }
      // Recorded by an earlier call that failed before applying it: this call applies it now, as the first.

      const chain = await scopeChainForRoom(tx, observation.roomId);
      const candidates = await tx.questProgress.findMany({
        where: { actorId: observation.actorId, status: { in: ['ACCEPTED', 'PAUSED'] }, definition: { pausedAt: null, ...scopeWhere(chain) } },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const ids = candidates.map((candidate) => candidate.id);
      if (ids.length) {
        // Two different events for the same quest take its progress rows in the same order, so they never deadlock.
        await tx.$queryRaw`SELECT id FROM quest_progress WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      }
      const loaded = ids.length ? await tx.questProgress.findMany({ where: { id: { in: ids } }, include: progressInclude, orderBy: { id: 'asc' } }) : [];

      const applying: Applying = {
        progress: loaded[0],
        chain,
        observation: { id: observation.id, source: observation.source, sourceId: observation.sourceId, subject: observation.subject, evidence: minimalEvidence(observation.evidence) },
        now,
        applications: [],
        completed: [],
      };
      for (const progress of loaded) {
        if (!inWindow({ startsAt: progress.attempt.startsAt, endsAt: progress.attempt.endsAt }, observation.occurredAt)) continue;
        applying.progress = progress;
        const status = await reconcilePause(tx, progress, chain, now);
        if (status !== 'ACCEPTED') continue;
        await applyToProgress(tx, applying, observation.action);
        await reconcilePause(tx, progress, chain, now);
      }
      await tx.questObservation.update({ where: { id: observationId }, data: { appliedAt: now } });
      return { observationId, reused: false, applications: applying.applications, completed: applying.completed };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
  );
}

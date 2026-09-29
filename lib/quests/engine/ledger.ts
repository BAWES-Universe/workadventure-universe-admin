import type { Prisma, QuestEvidence } from '@prisma/client';
import type { QuestDb } from './db';
import { DAILY_GRANT_BUDGET_BY_EVIDENCE, evidenceCovers } from './limits';
import { parseTarget, resolveHost, targetAvailable, type ResolvedHost } from './targets';
import type { ScopeChain } from './scope';

/**
 * What observe.ts and progress.ts share: the shape of a loaded progress row, when a quest counts as complete, atomic
 * grants, and the pause rule for a quest whose target is gone.
 */

export const progressInclude = {
  definition: true,
  version: { include: { objectives: { orderBy: { order: 'asc' } }, rewardRules: true } },
  attempt: true,
  objectives: true,
} satisfies Prisma.QuestProgressInclude;

export type LoadedProgress = Prisma.QuestProgressGetPayload<{ include: typeof progressInclude }>;
export type LoadedObjective = LoadedProgress['version']['objectives'][number];

export function objectiveSatisfied(progress: LoadedProgress, objective: LoadedObjective): boolean {
  return progress.objectives.some((row) => row.objectiveId === objective.id && row.satisfiedAt !== null);
}

/**
 * An any-of group is met when any one of its members is (the same rule openObjectives uses to close the others), and
 * it is required when any member is. Every other required objective must be met itself. Publishing refuses a group
 * that mixes required and optional members, so the two readings never differ in practice.
 */
export function questComplete(progress: LoadedProgress): boolean {
  const groups = new Map<string, { required: boolean; met: boolean }>();
  for (const objective of progress.version.objectives) {
    const met = objectiveSatisfied(progress, objective);
    if (!objective.anyOfGroup) {
      if (objective.requiredForCompletion && !met) return false;
      continue;
    }
    const group = groups.get(objective.anyOfGroup) ?? { required: false, met: false };
    groups.set(objective.anyOfGroup, { required: group.required || objective.requiredForCompletion, met: group.met || met });
  }
  return [...groups.values()].every((group) => !group.required || group.met);
}

/** Objectives that are still open for this action: not satisfied, and not in a group another member already met. */
export function openObjectives(progress: LoadedProgress, action: string): LoadedObjective[] {
  const metGroups = new Set(
    progress.version.objectives.filter((objective) => objective.anyOfGroup && objectiveSatisfied(progress, objective)).map((objective) => objective.anyOfGroup as string),
  );
  return progress.version.objectives.filter(
    (objective) => objective.action === action && !objectiveSatisfied(progress, objective) && !(objective.anyOfGroup && metGroups.has(objective.anyOfGroup)),
  );
}

export interface GrantCause {
  observationId: string | null;
  evidence: QuestEvidence;
  sourceLabel: string;
  now: Date;
}

export type GrantOutcome = 'granted' | 'already' | 'withheld-evidence' | 'withheld-budget';

/**
 * Grants one rule once: unique per actor, attempt and rule, so a second call finds the first. Withheld, and logged,
 * when the cause's evidence is weaker than the rule asks or the actor's daily budget for that class is spent.
 */
export async function grantReward(
  db: QuestDb,
  progress: LoadedProgress,
  rule: LoadedProgress['version']['rewardRules'][number],
  cause: GrantCause,
): Promise<GrantOutcome> {
  const existing = await db.questRewardGrant.findUnique({
    where: { actorId_attemptId_ruleId: { actorId: progress.actorId, attemptId: progress.attemptId, ruleId: rule.id } },
    select: { id: true },
  });
  if (existing) return 'already';

  const withhold = async (reason: GrantOutcome): Promise<GrantOutcome> => {
    await db.questAuditLog.create({
      data: {
        action: 'withhold',
        subjectToken: progress.actorId,
        byToken: cause.sourceLabel,
        source: cause.evidence,
        ruleId: rule.id,
        versionId: progress.versionId,
        reason,
      },
    });
    return reason;
  };
  if (!evidenceCovers(cause.evidence, rule.evidence)) return withhold('withheld-evidence');

  const dayStart = new Date(Date.UTC(cause.now.getUTCFullYear(), cause.now.getUTCMonth(), cause.now.getUTCDate()));
  const spent = await db.questRewardGrant.aggregate({
    where: { actorId: progress.actorId, evidence: cause.evidence, grantedAt: { gte: dayStart }, revokedAt: null },
    _sum: { value: true },
  });
  if ((spent._sum.value ?? 0) + rule.value > DAILY_GRANT_BUDGET_BY_EVIDENCE[cause.evidence]) return withhold('withheld-budget');

  await db.questRewardGrant.create({
    data: {
      actorId: progress.actorId,
      attemptId: progress.attemptId,
      ruleId: rule.id,
      versionId: progress.versionId,
      observationId: cause.observationId,
      evidence: cause.evidence,
      kind: rule.kind,
      value: rule.value,
      badgeId: rule.badgeId,
      grantedAt: cause.now,
    },
  });
  await db.questAuditLog.create({
    data: {
      action: 'grant',
      subjectToken: progress.actorId,
      byToken: cause.sourceLabel,
      source: cause.evidence,
      ruleId: rule.id,
      versionId: progress.versionId,
      reason: rule.objectiveKey ? `objective ${rule.objectiveKey}` : 'quest completed',
      details: { kind: rule.kind, value: rule.value, badgeId: rule.badgeId, attemptId: progress.attemptId },
    },
  });
  return 'granted';
}

export async function revokeGrant(db: QuestDb, grantId: string, byToken: string, reason: string, now = new Date()) {
  const grant = await db.questRewardGrant.findUnique({ where: { id: grantId } });
  if (!grant || grant.revokedAt) return grant;
  const revoked = await db.questRewardGrant.update({ where: { id: grantId }, data: { revokedAt: now, revokeReason: reason } });
  await db.questAuditLog.create({
    data: {
      action: 'revoke',
      subjectToken: grant.actorId,
      byToken,
      source: grant.evidence,
      ruleId: grant.ruleId,
      versionId: grant.versionId,
      reason,
    },
  });
  return revoked;
}

export const PAUSE_NO_TARGET = 'no-eligible-target';

/**
 * A quest whose open required objective points at something that is gone (an unbound host, a deleted or disabled
 * bot), with no alternative in its group, pauses and keeps its progress. It resumes on its own when a target is back.
 * Hiding or disabling the target never satisfies the objective. Returns the status the row now has.
 */
export async function reconcilePause(db: QuestDb, progress: LoadedProgress, chain: ScopeChain, now = new Date()) {
  if (progress.status !== 'ACCEPTED' && progress.status !== 'PAUSED') return progress.status;
  let host: ResolvedHost | null | undefined;
  const hostFor = async () => (host === undefined ? (host = await resolveHost(db, chain, progress.definition.key)) : host);

  const groups = new Map<string, boolean>();
  let blocked = false;
  for (const objective of progress.version.objectives) {
    if (!objective.requiredForCompletion || objectiveSatisfied(progress, objective)) {
      if (objective.anyOfGroup && objectiveSatisfied(progress, objective)) groups.set(objective.anyOfGroup, true);
      continue;
    }
    const target = parseTarget(objective.target);
    const available = await targetAvailable(db, target, target?.kind === 'role' ? await hostFor() : null);
    if (objective.anyOfGroup) groups.set(objective.anyOfGroup, (groups.get(objective.anyOfGroup) ?? false) || available);
    else if (!available) blocked = true;
  }
  if ([...groups.values()].some((available) => !available)) blocked = true;

  const status = blocked ? 'PAUSED' : 'ACCEPTED';
  if (status !== progress.status) {
    await db.questProgress.update({
      where: { id: progress.id },
      data: { status, pauseReason: blocked ? PAUSE_NO_TARGET : null, updatedAt: now },
    });
    progress.status = status;
    progress.pauseReason = blocked ? PAUSE_NO_TARGET : null;
  }
  return status;
}

import { createHash } from 'crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Account deletion for the quest ledger: everything readable about the person goes; where an aggregate must survive
 * (the audit log), the person is replaced by a one-way token; partner links are unlinked; and the deletion itself is
 * logged with who did it, when and how far it reached.
 */

export interface DeletionInput {
  actorId: string;
  /** Who asked: the person's own id, an admin's id, or "system". */
  byToken: string;
  /** "account" when the whole account goes; "quests" when only the quest data is cleared. */
  scope: 'account' | 'quests';
}

export interface DeletionReport {
  subjectToken: string;
  removed: Record<string, number>;
}

/** A token for a deleted person: a salted one-way hash, never the id. The pepper is the server's; without one the id alone is hashed. */
export function subjectTokenFor(actorId: string): string {
  const pepper = process.env.QUEST_DELETION_PEPPER ?? '';
  return `deleted:${createHash('sha256').update(`${pepper}:${actorId}`).digest('hex').slice(0, 40)}`;
}

export async function deleteActorQuestData(prisma: PrismaClient, input: DeletionInput, now = new Date()): Promise<DeletionReport> {
  const subjectToken = subjectTokenFor(input.actorId);
  return prisma.$transaction(async (tx) => {
    const removed: Record<string, number> = {};
    const count = (name: string, result: { count: number }) => {
      removed[name] = result.count;
    };
    count('grants', await tx.questRewardGrant.deleteMany({ where: { actorId: input.actorId } }));
    count('applications', await tx.questObservationApplication.deleteMany({ where: { actorId: input.actorId } }));
    count('observations', await tx.questObservation.deleteMany({ where: { actorId: input.actorId } }));
    count('tracking', await tx.questTrackedSelection.deleteMany({ where: { actorId: input.actorId } }));
    count('progress', await tx.questProgress.deleteMany({ where: { actorId: input.actorId } }));
    count('attempts', await tx.questAttempt.deleteMany({ where: { actorId: input.actorId } }));
    count('guidance', await tx.questGuidancePreference.deleteMany({ where: { actorId: input.actorId } }));
    count('partnerLinks', await tx.questPartnerLink.updateMany({ where: { actorId: input.actorId }, data: { actorId: null, unlinkedAt: now } }));
    count('auditTokenised', await tx.questAuditLog.updateMany({ where: { subjectToken: input.actorId }, data: { subjectToken } }));
    await tx.questAuditLog.updateMany({ where: { byToken: input.actorId }, data: { byToken: subjectToken } });
    await tx.questAuditLog.create({
      data: {
        action: 'delete-account',
        subjectToken,
        byToken: input.byToken === input.actorId ? subjectToken : input.byToken,
        reason: input.scope,
        details: { removed, at: now.toISOString() },
        createdAt: now,
      },
    });
    return { subjectToken, removed };
  });
}

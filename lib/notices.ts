import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Things Orbit tells one person once (#374): a key of theirs is down, bots moved off a key in their universe. They show
 * on Orbit home and in the attention count until dismissed. Adding the same `dedupeKey` for the same person again does
 * nothing, which is what "once per outage" rests on.
 */
export interface NoticeInput {
  userId: string;
  kind: string;
  dedupeKey: string;
  title: string;
  body: string;
  badge?: string | null;
  href?: string | null;
}

/** Adds a notice; true if it is new, false if this person already has it (shown or dismissed). */
export async function addNotice(input: NoticeInput): Promise<boolean> {
  try {
    await prisma.userNotice.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 1000),
        badge: input.badge ?? null,
        href: input.href ?? null,
      },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false;
    throw error;
  }
}

/** The ones still waiting for this person, newest first. */
export function openNotices(userId: string, take = 20) {
  return prisma.userNotice.findMany({
    where: { userId, dismissedAt: null },
    orderBy: { createdAt: 'desc' },
    take,
  });
}

export function countOpenNotices(userId: string) {
  return prisma.userNotice.count({ where: { userId, dismissedAt: null } });
}

/** Dismisses one of this person's notices; false if it is not theirs or is already gone. */
export async function dismissNotice(userId: string, id: string): Promise<boolean> {
  const result = await prisma.userNotice.updateMany({ where: { id, userId, dismissedAt: null }, data: { dismissedAt: new Date() } });
  return result.count > 0;
}

/** Clears notices that stopped being true (a key that came back), for one person and one kind of thing. */
export async function clearNotices(userId: string, kind: string, dedupePrefix: string): Promise<void> {
  await prisma.userNotice.updateMany({
    where: { userId, kind, dedupeKey: { startsWith: dedupePrefix }, dismissedAt: null },
    data: { dismissedAt: new Date() },
  });
}

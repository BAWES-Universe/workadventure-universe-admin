import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * A member's "Ask for more" (game #1999). It is only a request: it is not a debt and not a grant, and nothing is charged for
 * asking. One is open for a person at a time, so a second tap (or a second device) finds the first. Giving extra usage answers
 * it. Nothing the person said is kept, only that they asked and when.
 */

export interface OpenRequest {
  id: string;
  personId: string;
  what: string;
  createdAt: Date;
}

/** Asks for more. Returns the open request and whether this call made it (a second ask while one waits makes nothing new). */
export async function askForMore(personId: string, now: Date = new Date()): Promise<{ request: OpenRequest; created: boolean }> {
  // The partial unique index makes two taps at the same moment one request
  const created = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
    INSERT INTO "meter_requests" ("id", "person_id", "what", "created_at")
    VALUES (${randomUUID()}, ${personId}, 'computer', ${now})
    ON CONFLICT ("person_id", "what") WHERE "answered_at" IS NULL DO NOTHING
    RETURNING "id"`);
  const open = await prisma.meterRequest.findFirstOrThrow({ where: { personId, what: 'computer', answeredAt: null } });
  return { request: { id: open.id, personId: open.personId, what: open.what, createdAt: open.createdAt }, created: created.length > 0 };
}

/** The request a person has open, if any. */
export async function openRequestFor(personId: string): Promise<OpenRequest | null> {
  const open = await prisma.meterRequest.findFirst({ where: { personId, answeredAt: null }, orderBy: { createdAt: 'desc' } });
  return open ? { id: open.id, personId: open.personId, what: open.what, createdAt: open.createdAt } : null;
}

/** Everyone waiting, oldest first. */
export async function openRequests(): Promise<OpenRequest[]> {
  const rows = await prisma.meterRequest.findMany({ where: { answeredAt: null }, orderBy: { createdAt: 'asc' }, take: 200 });
  return rows.map((row) => ({ id: row.id, personId: row.personId, what: row.what, createdAt: row.createdAt }));
}

/** Extra usage was given: what the person asked for is answered. Safe to say twice. */
export async function answerRequests(personId: string, grantKey: string, now: Date = new Date()): Promise<number> {
  const { count } = await prisma.meterRequest.updateMany({ where: { personId, answeredAt: null }, data: { answeredAt: now, grantKey } });
  return count;
}

import type { Prisma, PrismaClient } from '@prisma/client';

/** The client the engine runs on: the shared one, or the transaction it is inside. */
export type QuestDb = PrismaClient | Prisma.TransactionClient;

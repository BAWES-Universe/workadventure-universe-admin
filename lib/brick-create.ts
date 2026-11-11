import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { startWithToolCallsOn } from '@/lib/bot-tool-call-default';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';

/** What a new Brick starts with. Everything else is a bot's usual start. */
export interface NewBrick {
  /** The person the Brick belongs to: whoever makes it. */
  ownerId: string;
  name: string;
  description?: string | null;
  characterTextureId?: string | null;
  chatInstructions?: string | null;
}

/**
 * Makes a Brick (game #1992): a bot with an owner and no room. Its owner is the person who made it, so "made by" and
 * "owner" start as the same person, and it runs on Universe AI until its owner puts it on their own key.
 *
 * This is the one place a bot is written without a room, so every Brick starts the same way. The Brick everyone gets
 * (game #1995) is made through it, inside the transaction that claims the account's one row (see brick-default.ts).
 */
export async function createBrick(input: NewBrick, db: Prisma.TransactionClient = prisma) {
  return db.bot.create({
    data: {
      ownerId: input.ownerId,
      createdById: input.ownerId,
      updatedById: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      characterTextureId: input.characterTextureId ?? null,
      chatInstructions: input.chatInstructions ?? null,
      behaviorType: 'idle',
      behaviorConfig: startWithToolCallsOn({}),
      aiProviderRef: UNIVERSE_AI_REF,
    },
  });
}

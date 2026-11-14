import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { startWithToolCallsOn } from '@/lib/bot-tool-call-default';
import { UNIVERSE_AI_REF } from '@/lib/universe-ai';
import { grantKeyAppsToNewBrick } from '@/lib/app-direct/grants';

/** What a new Brick starts with. Everything else is a bot's usual start. */
export interface NewBrick {
  /** The person the Brick belongs to: whoever makes it. */
  ownerId: string;
  name: string;
  description?: string | null;
  characterTextureId?: string | null;
  chatInstructions?: string | null;
  /** The first line of its chat while nothing is written there (game #1996); none means the game's own hello. */
  hello?: string | null;
}

/**
 * Makes a Brick (game #1992): a bot with an owner and no room. Its owner is the person who made it, so "made by" and
 * "owner" start as the same person, and it runs on Universe AI until its owner puts it on their own key.
 *
 * This is the one place a bot is written without a room, so every Brick starts the same way. The Brick everyone gets
 * (game #1995) is made through it, inside the transaction that claims the account's one row (see brick-default.ts).
 */
export async function createBrick(input: NewBrick, db: Prisma.TransactionClient = prisma) {
  const brick = await db.bot.create({
    data: {
      ownerId: input.ownerId,
      createdById: input.ownerId,
      updatedById: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      characterTextureId: input.characterTextureId ?? null,
      chatInstructions: input.chatInstructions ?? null,
      hello: input.hello ?? null,
      behaviorType: 'idle',
      behaviorConfig: startWithToolCallsOn({}),
      aiProviderRef: UNIVERSE_AI_REF,
    },
  });
  // Every key app its owner has is available to it from the start (game #2044, default access)
  await grantKeyAppsToNewBrick(db, input.ownerId, brick.id);
  return brick;
}

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
 * Nothing calls this for a person yet: who gets a Brick, and when, comes with game #1995. This is the one place a bot is
 * written without a room, so every Brick starts the same way.
 */
export async function createBrick(input: NewBrick) {
  return prisma.bot.create({
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

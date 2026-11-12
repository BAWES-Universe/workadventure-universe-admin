import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { listBricks } from '@/lib/brick-default';
import { deleteBrick } from '@/lib/brick-delete';
import { ownsBrick } from '@/lib/brick';
import { checkAiProviderRef, checkBotModel } from '@/lib/ai-provider-ref';
import { checkConfigVision, dropOthersVisionKey } from '@/lib/bot-vision';
import { keepToolCallSetting } from '@/lib/bot-config-helpers';
import { clearBotRunsOnNotices } from '@/lib/notices';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * How a Brick moves and what it does when it sees someone (the Behavior row on its page): only these keys of a bot's
 * behavior config can be sent, and each is merged into what is saved, so the rest of the config (what Apps and the other
 * parts keep there) is never replaced by a save from this page. `vision` is where its images go (the Mind row).
 */
const brickBehaviorConfigSchema = z
  .object({
    behaviorType: z.enum(['idle', 'patrol', 'social']),
    moves: z.enum(['stay', 'wander', 'route']),
    goesToPeople: z.boolean(),
    conversationRadius: z.number().min(0).max(10000),
    minTimeBetweenConversations: z.number().min(0).max(86_400_000),
    facing: z.enum(['down', 'left', 'right', 'up']),
    assignedSpace: z.object({ center: z.object({ x: z.number(), y: z.number() }), radius: z.number().min(0).max(100000) }),
    vision: z.unknown(),
  })
  .partial()
  .strict();

/**
 * What a Brick's owner can change here (game #1995 onwards): its name, its one line, what it is told to be like, whether it
 * is on, its look (game #2013), what it runs on and its images, how it behaves, and its companion. Nothing else is read from
 * the body, so a save can never move a Brick into a room, hand it to someone else or put it on someone else's key: each of
 * those comes with its own issue and its own rule.
 */
const changeSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(100, 'name must be at most 100 characters').optional(),
    description: z.string().nullable().optional(),
    chatInstructions: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    /** Its look: a Brick look or a WOKA the game offers (the same check as when it is made). */
    characterTextureId: z.string().trim().min(1).max(100, 'characterTextureId must be at most 100 characters').optional(),
    /** What it runs on: Universe AI or one of its owner's own keys, and the model on that key (null: the key's own). */
    aiProviderRef: z.string().max(100, 'aiProviderRef must be at most 100 characters').nullable().optional(),
    aiModel: z.string().trim().min(1, 'aiModel cannot be empty').max(255, 'aiModel must be at most 255 characters').nullable().optional(),
    behaviorType: z.enum(['idle', 'patrol', 'social']).optional(),
    behaviorConfig: brickBehaviorConfigSchema.optional(),
    companionTextureId: z.string().trim().min(1).max(100, 'companionTextureId must be at most 100 characters').nullable().optional(),
  })
  .strict();

/**
 * PATCH /api/bricks/:id
 * A Brick's owner changes it. Only its owner: for anyone else, a super admin included, and for a bot that lives in a
 * room, the answer is the same as for a Brick that does not exist. So is it for a Brick that waits deleted (game #1996):
 * nothing about it changes, its switch least of all, until Undo. Answers with the Brick's card as the Bricks page
 * shows it.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;

    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true, createdById: true, aiProviderRef: true, aiModel: true, behaviorConfig: true } });
    if (!brick || !ownsBrick(brick, owner.userId)) return brickJson(request, { error: 'Brick not found' }, 404);

    const parsed = changeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const change = parsed.data;


    // What it runs on is the owner's own key or Universe AI, judged by the rules a room bot's are, with its owner in place of a
    // room: no lend, all of the key's models (lib/ai-key-pay.ts)
    const home = { actorId: owner.userId, makerId: brick.createdById, roomId: null, ownerId: owner.userId, botId: id };
    if (change.aiProviderRef) {
      const providerError = await checkAiProviderRef(change.aiProviderRef, brick.aiProviderRef, home);
      if (providerError) return brickJson(request, { error: providerError }, 400);
    }
    const nextRef = change.aiProviderRef !== undefined ? change.aiProviderRef : brick.aiProviderRef;
    const modelError = await checkBotModel(change.aiModel, { ...home, ref: nextRef ?? null, currentRef: brick.aiProviderRef, currentModel: brick.aiModel });
    if (modelError) return brickJson(request, { error: modelError }, 400);
    const visionError = await checkConfigVision(change.behaviorConfig, { storedConfig: brick.behaviorConfig, ...home, mainRef: nextRef ?? null });
    if (visionError) return brickJson(request, { error: visionError }, 400);

    // Only the keys sent change; the rest of what is saved there stays
    const storedConfig = brick.behaviorConfig && typeof brick.behaviorConfig === 'object' && !Array.isArray(brick.behaviorConfig) ? (brick.behaviorConfig as Record<string, unknown>) : {};
    let behaviorConfig = change.behaviorConfig ? keepToolCallSetting(storedConfig, { ...storedConfig, ...change.behaviorConfig }) : undefined;
    // Moving it to another key moves its images off a key that is not its owner's
    if (nextRef !== brick.aiProviderRef) {
      const withoutVision = await dropOthersVisionKey(behaviorConfig ?? storedConfig, owner.userId);
      if (withoutVision) behaviorConfig = withoutVision;
    }

    await prisma.bot.update({
      where: { id },
      data: {
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.description !== undefined ? { description: change.description?.trim() || null } : {}),
        ...(change.chatInstructions !== undefined ? { chatInstructions: change.chatInstructions?.trim() || null } : {}),
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        ...(change.characterTextureId !== undefined ? { characterTextureId: change.characterTextureId } : {}),
        ...(change.aiProviderRef !== undefined ? { aiProviderRef: change.aiProviderRef } : {}),
        // A model belongs to one key: a Brick moved to another key without a model picked starts on that key's own
        ...(change.aiModel !== undefined ? { aiModel: change.aiModel } : nextRef !== brick.aiProviderRef ? { aiModel: null } : {}),
        ...(change.behaviorType !== undefined ? { behaviorType: change.behaviorType } : {}),
        ...(behaviorConfig !== undefined ? { behaviorConfig: behaviorConfig as Prisma.InputJsonValue } : {}),
        ...(change.companionTextureId !== undefined ? { companionTextureId: change.companionTextureId } : {}),
        updatedById: owner.userId,
      },
    });
    // What it runs on changed: the notices that said where it was are out of date
    if (nextRef !== brick.aiProviderRef || (change.aiModel !== undefined && change.aiModel !== brick.aiModel)) await clearBotRunsOnNotices(id);
    const card = (await listBricks(owner.userId)).find((one) => one.id === id);
    return card ? brickJson(request, { brick: card }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error changing a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/bricks/:id
 * A Brick's owner deletes it (game #1996). It stops at once and waits under "Deleted" on their Bricks page until the
 * day in `goneAt`; `POST /api/bricks/:id/undo` gives it back before then. Only its owner: for anyone else, a super
 * admin included, and for a bot that lives in a room, the answer is the same as for a Brick that does not exist.
 * Answers with the waiting Brick. Asked twice, the second answer is the same.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const owner = await brickOwner(request);
    if (owner.response) return owner.response;
    const brick = await deleteBrick(id, owner.userId);
    return brick ? brickJson(request, { brick }) : brickJson(request, { error: 'Brick not found' }, 404);
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'bricks' } });
    console.error('Error deleting a Brick:', error);
    return brickJson(request, { error: 'Internal server error' }, 500);
  }
}

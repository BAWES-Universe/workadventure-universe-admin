import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { brickJson, brickOwner } from '@/lib/brick-api';
import { listBricks } from '@/lib/brick-default';
import { deleteBrick } from '@/lib/brick-delete';
import { ownsBrick } from '@/lib/brick';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * What a Brick's owner can change here (game #1995): its name, its one line, what it is told to be like, and whether it
 * is on. Nothing else is read from the body, so a save can never move a Brick into a room, hand it to someone else or
 * put it on another key: each of those comes with its own issue and its own rule.
 */
const changeSchema = z
  .object({
    name: z.string().trim().min(1, 'name cannot be empty').max(100, 'name must be at most 100 characters').optional(),
    description: z.string().nullable().optional(),
    chatInstructions: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
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

    const brick = await prisma.bot.findUnique({ where: { id }, select: { id: true, roomId: true, ownerId: true, deletedAt: true } });
    if (!brick || !ownsBrick(brick, owner.userId)) return brickJson(request, { error: 'Brick not found' }, 404);

    const parsed = changeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return brickJson(request, { error: 'Invalid input data', details: parsed.error.issues }, 400);
    const change = parsed.data;

    await prisma.bot.update({
      where: { id },
      data: {
        ...(change.name !== undefined ? { name: change.name } : {}),
        ...(change.description !== undefined ? { description: change.description?.trim() || null } : {}),
        ...(change.chatInstructions !== undefined ? { chatInstructions: change.chatInstructions?.trim() || null } : {}),
        ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
        updatedById: owner.userId,
      },
    });
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

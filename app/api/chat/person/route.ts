import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { isMatrixUserId } from '@/lib/matrix-id';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { parsePlayUri } from '@/lib/utils';
import { wokaTexturesForMany } from '@/lib/woka-avatar';
import type { ChatPersonData } from '@/types/workadventure';

/** The world of the room the asker is in, or undefined for a room that isn't a world's (they are then outside any world). */
async function askerWorldId(playUri: string | null): Promise<string | undefined> {
  if (!playUri) return undefined;
  try {
    const { universe, world } = parsePlayUri(playUri);
    const found = await prisma.world.findFirst({ where: { slug: world, universe: { slug: universe } }, select: { id: true } });
    return found?.id;
  } catch {
    return undefined;
  }
}

/**
 * GET /api/chat/person?chatId=<Matrix id>&playUri=<the asker's room> - one person's name and Woka by their chat ID, so the
 * game's chat can draw someone it has no other way to know (a direct chat with a person who is not in the asker's world).
 * The Woka is the one Orbit draws from the asker's place (see `wokaOutfitsFor`): the outfit saved for the asker's world,
 * else the latest one made only of parts allowed in every world; none when there is no such outfit, and the game then
 * draws its default. Called by the game's server with the admin token. Never an email address or an id.
 */
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);

    const { searchParams } = new URL(request.url);
    const chatId = searchParams.get('chatId');
    if (!isMatrixUserId(chatId)) {
      return NextResponse.json({ error: 'chatId must be a Matrix user ID' }, { status: 400 });
    }

    const user = await prisma.user.findFirst({
      where: { AND: [NOT_SYSTEM_USER, { matrixChatId: chatId, isGuest: false }] },
      select: { id: true, name: true },
    });
    if (!user) return NextResponse.json({ error: 'Person not found' }, { status: 404 });

    // Never fails the answer: without a Woka the game draws its default one.
    const characterTextures = await wokaTexturesForMany([user.id], await askerWorldId(searchParams.get('playUri')))
      .then((wokas) => wokas.get(user.id) ?? [])
      .catch(() => []);

    const person: ChatPersonData = { wokaName: user.name ?? null, characterTextures };
    return NextResponse.json(person);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error in /api/chat/person:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

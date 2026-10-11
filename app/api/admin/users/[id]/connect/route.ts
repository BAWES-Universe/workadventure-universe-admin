import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import {
  FriendsError,
  applyFriendAction,
  findAccount,
  relationshipBetween,
  type Account,
  type FriendAction,
} from '@/lib/friends';

export const runtime = 'nodejs';

/** What the profile page may do: the same friend steps as the game, nothing that blocks or hides someone. */
const PROFILE_ACTIONS: readonly FriendAction[] = ['request', 'accept', 'cancel', 'remove'];

type Pair = { me: Account; target: Account } | null;

/** The signed-in viewer and the person whose profile is open, both signed-in accounts and not the same person. */
async function pairFor(request: NextRequest, id: string): Promise<Pair | 'unauthorized'> {
  const viewer = await getSessionUser(request);
  if (!viewer) return 'unauthorized';
  const row = await prisma.user.findUnique({ where: { id }, select: { uuid: true } });
  if (!row) return null;
  const [me, target] = await Promise.all([findAccount(viewer.uuid), findAccount(row.uuid)]);
  return me && target && me.id !== target.id ? { me, target } : null;
}

// GET /api/admin/users/[id]/connect - how you stand with this person, and their chat address for Message.
// `{ available: false }` for yourself and for guests (on either side), who have no friends or chat to reach.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const pair = await pairFor(request, (await params).id);
    if (pair === 'unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!pair) return NextResponse.json({ available: false }, { headers: { 'Cache-Control': 'no-store' } });
    const relationship = await relationshipBetween(pair.me, pair.target);
    const blocked = relationship === 'blocked_by_me' || relationship === 'blocked_by_them';
    return NextResponse.json(
      { available: true, relationship, chatId: blocked ? null : pair.target.matrixChatId },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('Error reading how two people stand:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// POST /api/admin/users/[id]/connect { action } - request, accept, cancel or remove, as you
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const pair = await pairFor(request, (await params).id);
    if (pair === 'unauthorized') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!pair) return NextResponse.json({ error: 'not_available' }, { status: 403 });
    const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
    const action = body?.action;
    if (typeof action !== 'string' || !PROFILE_ACTIONS.includes(action as FriendAction)) {
      return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
    }
    const relationship = await applyFriendAction(pair.me, pair.target, action as FriendAction);
    return NextResponse.json({ relationship }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof FriendsError) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error('Error changing how two people stand:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

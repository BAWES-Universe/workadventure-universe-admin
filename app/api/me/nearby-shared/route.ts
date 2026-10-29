import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import {
  NEARBY_SHARED_MAX_PER_REQUEST,
  NEARBY_SHARED_PAGE_MAX,
  parseNearbySharedItem,
  type NearbySharedItemInput,
} from '@/lib/nearby-shared';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

// A page's place in the list: the last item's sentAt and id, so items sent at the same moment are never skipped.
function encodeCursor(row: { sentAt: Date; id: string }): string {
  return `${row.sentAt.toISOString()}|${row.id}`;
}

function decodeCursor(cursor: string): { sentAt: Date; id: string } | null {
  const [time, id] = cursor.split('|');
  const sentAt = new Date(time ?? '');
  return id && !Number.isNaN(sentAt.getTime()) ? { sentAt, id } : null;
}

/**
 * GET /api/me/nearby-shared[?cursor=<next>&limit=<n>][&with=<chat id>[&name=<their name>]] - what was shared in the
 * nearby chats the caller was in, newest first. `next` is set while an older page exists: ask again with it as
 * `cursor`. With `with`, only what that person sent the caller and what the caller sent while they were there (a
 * person's profile, game #1615); `name` also finds what they sent before items named their chat account.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  const cursorParam = request.nextUrl.searchParams.get('cursor');
  const cursor = cursorParam === null ? null : decodeCursor(cursorParam);
  if (cursorParam !== null && cursor === null) return respond(request, { error: 'Invalid cursor' }, 400);
  const limitParam = request.nextUrl.searchParams.get('limit');
  const limit = limitParam === null ? NEARBY_SHARED_PAGE_MAX : Number(limitParam);
  if (!Number.isInteger(limit) || limit < 1 || limit > NEARBY_SHARED_PAGE_MAX) {
    return respond(request, { error: `limit must be 1 to ${NEARBY_SHARED_PAGE_MAX}` }, 400);
  }

  const withParam = request.nextUrl.searchParams.get('with');
  const nameParam = request.nextUrl.searchParams.get('name');
  if (withParam !== null && (withParam.length === 0 || withParam.length > 255)) {
    return respond(request, { error: 'Invalid with' }, 400);
  }
  if (nameParam !== null && (withParam === null || nameParam.trim() === '' || nameParam.length > 100)) {
    return respond(request, { error: 'Invalid name' }, 400);
  }
  const name = nameParam?.trim();

  try {
    const rows = await prisma.nearbySharedItem.findMany({
      where: {
        userId: user.id,
        AND: [
          cursor
            ? { OR: [{ sentAt: { lt: cursor.sentAt } }, { sentAt: cursor.sentAt, id: { lt: cursor.id } }] }
            : {},
          withParam !== null
            ? {
                OR: [
                  { mine: false, senderChatId: withParam },
                  { mine: true, withChatIds: { has: withParam } },
                  ...(name ? [{ mine: false, senderChatId: null, senderName: name }] : []),
                ],
              }
            : {},
        ],
      },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        itemKey: true,
        kind: true,
        name: true,
        link: true,
        fileId: true,
        mimeType: true,
        size: true,
        isVideo: true,
        senderName: true,
        senderChatId: true,
        mine: true,
        sentAt: true,
      },
    });
    const page = rows.slice(0, limit);
    return respond(request, {
      items: page.map((row) => ({
        itemKey: row.itemKey,
        kind: row.kind,
        name: row.name,
        link: row.link,
        fileId: row.fileId,
        mimeType: row.mimeType,
        size: row.size,
        isVideo: row.isVideo,
        senderName: row.senderName,
        senderChatId: row.senderChatId,
        mine: row.mine,
        sentAt: row.sentAt.toISOString(),
      })),
      next: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  } catch (error) {
    console.error('[NearbyShared] List failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/me/nearby-shared { items: [...] } - keeps what the caller saw shared in a nearby chat. An item already
 * kept (same itemKey) stays as it was; an item that doesn't check out is left out and counted in `skipped`.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  const items = typeof body === 'object' && body !== null ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items) || items.length === 0) return respond(request, { error: 'Expected { items: [...] }' }, 400);
  if (items.length > NEARBY_SHARED_MAX_PER_REQUEST) {
    return respond(request, { error: `At most ${NEARBY_SHARED_MAX_PER_REQUEST} items per request` }, 413);
  }

  const now = new Date();
  const valid = items
    .map((item) => parseNearbySharedItem(item, now))
    .filter((item): item is NearbySharedItemInput => item !== null);
  const skipped = items.length - valid.length;
  if (valid.length === 0) return respond(request, { saved: 0, skipped });

  try {
    const result = await prisma.nearbySharedItem.createMany({
      data: valid.map((item) => ({ ...item, userId: user.id })),
      skipDuplicates: true,
    });
    return respond(request, { saved: result.count, skipped });
  } catch (error) {
    console.error('[NearbyShared] Save failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

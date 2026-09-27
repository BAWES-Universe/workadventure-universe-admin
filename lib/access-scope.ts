import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { validateAdminToken } from '@/lib/auth';
import { getSessionUser, type SessionUser } from '@/lib/auth-session';
import { canManageBots } from '@/lib/bot-permissions';

/**
 * Who is making a request to the admin API.
 *
 * - `admin-token`: the caller presented the server's ADMIN_API_TOKEN.
 * - `user`: the caller has a valid session.
 */
export type Viewer =
  | { kind: 'admin-token' }
  | { kind: 'user'; user: SessionUser };

function hasAdminToken(request: NextRequest): boolean {
  try {
    return validateAdminToken(request);
  } catch {
    // ADMIN_API_TOKEN not configured: no request can present it.
    return false;
  }
}

/** Resolve the viewer for a request, or null when the caller is not signed in. */
export async function getViewer(request: NextRequest): Promise<Viewer | null> {
  if (hasAdminToken(request)) {
    return { kind: 'admin-token' };
  }
  const user = await getSessionUser(request);
  return user ? { kind: 'user', user } : null;
}

/** Admin-token callers and super admins may see and manage everything. */
export function isPrivileged(viewer: Viewer | null): boolean {
  if (!viewer) return false;
  return viewer.kind === 'admin-token' || viewer.user.isSuperAdmin === true;
}

/** The session user's id, or null for admin-token / anonymous callers. */
export function viewerUserId(viewer: Viewer | null): string | null {
  return viewer?.kind === 'user' ? viewer.user.id : null;
}

/** A universe is managed by its owner. */
export async function canManageUniverse(userId: string, universeId: string): Promise<boolean> {
  const universe = await prisma.universe.findUnique({
    where: { id: universeId },
    select: { ownerId: true },
  });
  return !!universe && universe.ownerId === userId;
}

/**
 * A world is managed by the owner of its universe, or by a world member
 * tagged `admin` or `editor`.
 */
export async function canManageWorld(userId: string, worldId: string): Promise<boolean> {
  const world = await prisma.world.findUnique({
    where: { id: worldId },
    select: { universe: { select: { ownerId: true } } },
  });
  if (!world) return false;
  if (world.universe.ownerId === userId) return true;

  const member = await prisma.worldMember.findFirst({
    where: {
      worldId,
      userId,
      tags: { hasSome: ['admin', 'editor'] },
    },
  });
  return !!member;
}

/**
 * A world's members are managed by the owner of its universe, or by a world member tagged `admin` (the same rule
 * the members routes apply).
 */
export async function canManageWorldMembers(userId: string, worldId: string): Promise<boolean> {
  const world = await prisma.world.findUnique({
    where: { id: worldId },
    select: { universe: { select: { ownerId: true } } },
  });
  if (!world) return false;
  if (world.universe.ownerId === userId) return true;

  const member = await prisma.worldMember.findFirst({
    where: { worldId, userId, tags: { has: 'admin' } },
  });
  return !!member;
}

/** A room is managed by whoever can manage its world (same rule as bot management). */
export async function canManageRoom(userId: string, roomId: string): Promise<boolean> {
  return canManageBots(userId, roomId);
}

/** A bot is managed by whoever can manage the room it lives in. */
export async function canManageBot(userId: string, botId: string): Promise<boolean> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { roomId: true },
  });
  return !!bot && (await canManageBots(userId, bot.roomId));
}

export type AccessScope =
  | { universeId: string }
  | { worldId: string }
  | { roomId: string };

/**
 * How much per-visitor detail a viewer may see in room access records:
 * - `full`: everything, including email and IP address (privileged viewers).
 * - `manager`: who visited and how, without email or IP address.
 * - `minimal`: only when and where a visit happened.
 */
export type AccessDetail = 'full' | 'manager' | 'minimal';

export async function accessDetailFor(
  viewer: Viewer | null,
  scope: AccessScope | null,
): Promise<AccessDetail> {
  if (isPrivileged(viewer)) return 'full';
  const userId = viewerUserId(viewer);
  if (!userId || !scope) return 'minimal';

  let manages = false;
  if ('universeId' in scope) {
    manages = await canManageUniverse(userId, scope.universeId);
  } else if ('worldId' in scope) {
    manages = await canManageWorld(userId, scope.worldId);
  } else {
    manages = await canManageRoom(userId, scope.roomId);
  }
  return manages ? 'manager' : 'minimal';
}

/**
 * A viewer may always see who made their own visits, so a record that
 * belongs to the viewer is shown at least at `manager` detail.
 */
export function detailForRecord(
  viewer: Viewer | null,
  record: { userId?: string | null; userUuid?: string | null },
  detail: AccessDetail,
): AccessDetail {
  if (detail !== 'minimal' || viewer?.kind !== 'user') return detail;
  const own =
    (!!record.userId && record.userId === viewer.user.id) ||
    (!!record.userUuid && record.userUuid === viewer.user.uuid);
  return own ? 'manager' : detail;
}

const MANAGER_HIDDEN_FIELDS = ['userEmail', 'ipAddress'] as const;
const MINIMAL_FIELDS = ['id', 'accessedAt', 'world', 'room'] as const;

/**
 * Reduce a room access record to what the given detail level may see.
 * Fields are omitted rather than nulled so the response shape tells the
 * client what it is allowed to know.
 */
export function redactAccess<T extends Record<string, unknown>>(
  entry: T,
  detail: AccessDetail,
): Partial<T> {
  if (detail === 'full') return entry;
  if (detail === 'manager') {
    const copy: Record<string, unknown> = { ...entry };
    for (const field of MANAGER_HIDDEN_FIELDS) delete copy[field];
    return copy as Partial<T>;
  }
  const copy: Record<string, unknown> = {};
  for (const field of MINIMAL_FIELDS) {
    if (field in entry) copy[field] = entry[field];
  }
  return copy as Partial<T>;
}

export function unauthorizedResponse(headers?: HeadersInit) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
}

export function forbiddenResponse(headers?: HeadersInit) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers });
}

/**
 * Guard for routes that read one bot's data (conversations, memory, metrics,
 * emotions). Returns an error response when the viewer may not read it, or
 * null when they may: privileged viewers and managers of the bot's room.
 * A bot that does not exist is reported as forbidden so the response does
 * not reveal whether it exists.
 */
export async function botReadDenied(
  request: NextRequest,
  botId: string,
  headers?: HeadersInit,
): Promise<NextResponse | null> {
  const viewer = await getViewer(request);
  if (!viewer) return unauthorizedResponse(headers);
  if (isPrivileged(viewer)) return null;
  if (viewer.kind === 'user' && (await canManageBot(viewer.user.id, botId))) return null;
  return forbiddenResponse(headers);
}

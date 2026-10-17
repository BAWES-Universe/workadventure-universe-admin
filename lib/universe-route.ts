/**
 * The start of every universe roles and people route (#314): who is asking, and what they may do in that universe.
 * A universe they can't see doesn't exist to them (404), like the other universe routes.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser, type SessionUser } from '@/lib/auth-session';
import { canSeeUniverse } from '@/lib/room-visibility';
import { accessFor, worldsAllowing, type Access } from '@/lib/role-access';
import { isBuiltInKey } from '@/lib/roles';

export type UniverseContext =
  | { ok: true; user: SessionUser; access: Access; universe: { id: string; name: string; ownerId: string } }
  | { ok: false; response: NextResponse };

export async function universeContext(request: NextRequest, universeId: string): Promise<UniverseContext> {
  const user = await getSessionUser(request);
  if (!user) return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  const universe = await prisma.universe.findUnique({
    where: { id: universeId },
    select: { id: true, name: true, ownerId: true, isPublic: true },
  });
  const access = universe ? await accessFor(prisma, universeId, user) : null;
  if (!universe || !access || !canSeeUniverse(universe, user, access.inUniverse)) {
    return { ok: false, response: NextResponse.json({ error: 'Universe not found' }, { status: 404 }) };
  }
  return { ok: true, user, access, universe: { id: universe.id, name: universe.name, ownerId: universe.ownerId } };
}

/** A refusal that says which permission it needs, never who has it. */
export function needs(what: string, status = 403) {
  return NextResponse.json({ error: `Needs ${what}` }, { status });
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** The common ending of a route: a bad body is a 400, anything else is logged and a 500. */
export function failed(error: unknown, what: string) {
  if (error instanceof z.ZodError) {
    return NextResponse.json({ error: 'Invalid request data', details: error.issues }, { status: 400 });
  }
  if (error instanceof SyntaxError) return badRequest('Invalid JSON');
  console.error(`Error: ${what}`, error);
  return NextResponse.json({ error: `Failed to ${what}` }, { status: 500 });
}

/** Where a role or a membership works, as sent by the screens. */
export const scopeSchema = z
  .object({
    allWorlds: z.boolean(),
    worldIds: z.array(z.string().uuid()).max(500).default([]),
  })
  .transform((scope) => (scope.allWorlds ? { allWorlds: true, worldIds: [] as string[] } : { allWorlds: false, worldIds: [...new Set(scope.worldIds)] }));

/** A scope's worlds must belong to the universe, and "some worlds" must name at least one. */
export function checkScope(scope: { allWorlds: boolean; worldIds: string[] }, universeWorldIds: readonly string[]): string | null {
  if (scope.allWorlds) return null;
  if (scope.worldIds.length === 0) return 'Pick at least one world';
  const known = new Set(universeWorldIds);
  if (scope.worldIds.some((id) => !known.has(id))) return 'A world is not in this universe';
  return null;
}

export const roleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  badge: z.string().trim().max(16).nullable().optional(),
  permissions: z.string().regex(/^\d{1,20}$/),
});

// Letters and digits of any script stay (the app targets ES2017, so no /u regex literal)
const NOT_KEY_CHARACTER = new RegExp('[^\\p{L}\\p{N}_-]', 'gu');

/**
 * The key a new role is sent to the game and map areas as: its name in lower case with dashes, kept unique in the
 * universe. It never changes when the role is renamed, so a map area locked to the role stays locked to it.
 */
export function keyForName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(NOT_KEY_CHARACTER, '')
      .slice(0, 40) || 'role';
  let key = base;
  for (let n = 2; taken.has(key) || isBuiltInKey(key); n += 1) key = `${base}-${n}`;
  return key;
}

/** They invite, remove or give roles somewhere in the universe, so they see people's emails. */
export function managesPeople(access: Access): boolean {
  const some = (worlds: 'all' | string[]) => worlds === 'all' || worlds.length > 0;
  return access.full || some(worldsAllowing(access, 'INVITE_AND_REMOVE')) || some(worldsAllowing(access, 'GIVE_ROLES'));
}

export const memberInclude = {
  user: { select: { id: true, name: true, email: true } },
  roles: { select: { roleId: true, allWorlds: true, worldIds: true, role: { select: { position: true } } } },
} satisfies Prisma.UniverseMemberInclude;

type MemberRow = Prisma.UniverseMemberGetPayload<{ include: typeof memberInclude }>;

/** One member for the screens: their roles highest first, and their email only for people who manage members. */
export function memberForJson(member: MemberRow, ownerId: string, showEmail: boolean) {
  return {
    userId: member.userId,
    name: member.user.name,
    email: showEmail ? member.user.email : null,
    joinedAt: member.joinedAt,
    isOwner: member.userId === ownerId,
    worlds: { allWorlds: member.allWorlds, worldIds: member.worldIds },
    roles: [...member.roles]
      .sort((a, b) => b.role.position - a.role.position)
      .map((given) => ({ roleId: given.roleId, allWorlds: given.allWorlds, worldIds: given.worldIds })),
  };
}

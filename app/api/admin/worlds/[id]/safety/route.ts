import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { withWokas } from '@/lib/woka-avatar';
import { BAN_DURATIONS, banEndsAt, canModerateWorld, playerNames, sendOutOfWorld, type BanDuration } from '@/lib/moderation';

/** The longest reason an admin can give a banned player. */
const MAX_REASON = 200;

/** How many handled reports the Done list shows. */
const DONE_LIMIT = 50;

/** One reported player: an Orbit user's id, or the game's uuid for someone Orbit has no record of. */
function personKey(report: { reportedUserId: string | null; reportedUuid: string }) {
  return report.reportedUserId ?? `uuid:${report.reportedUuid}`;
}

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('dismiss'), person: z.string().min(1) }),
  z.object({
    action: z.literal('ban'),
    person: z.string().min(1),
    duration: z.enum(Object.keys(BAN_DURATIONS) as [BanDuration, ...BanDuration[]]),
    // Shown to the banned player; reports stay private to the admins
    reason: z.string().trim().max(MAX_REASON).optional(),
  }),
  z.object({ action: z.literal('lift'), banId: z.string().uuid() }),
  z.object({ action: z.literal('keep'), banId: z.string().uuid() }),
]);

/** Reports to review, reports handled, and who is banned from the world, for its admins. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    if (!(await canModerateWorld(sessionUser, id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const reportInclude = { room: { select: { name: true } }, handledBy: { select: { name: true } } } as const;
    const [open, done, bans] = await Promise.all([
      prisma.report.findMany({ where: { worldId: id, status: 'open' }, include: reportInclude, orderBy: { createdAt: 'desc' } }),
      prisma.report.findMany({
        where: { worldId: id, status: { not: 'open' } },
        include: reportInclude,
        orderBy: { handledAt: 'desc' },
        take: DONE_LIMIT,
      }),
      prisma.ban.findMany({
        where: { worldId: id, isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        include: { user: { select: { id: true, uuid: true } }, bannedBy: { select: { name: true } } },
        orderBy: { bannedAt: 'desc' },
      }),
    ]);

    const nameOf = await playerNames(id, [
      ...[...open, ...done].flatMap((report) => [
        { userId: report.reportedUserId, uuid: report.reportedUuid },
        { userId: report.reporterUserId, uuid: report.reporterUuid },
      ]),
      ...bans.flatMap((ban) => (ban.user ? [{ userId: ban.user.id, uuid: ban.user.uuid }] : [])),
    ]);
    // Admins are named, never shown by email: an admin without a name is just "an admin"
    const by = (user: { name: string | null } | null) => user?.name || 'an admin';

    // Open reports, one card per reported player, newest report first
    const openGroups = new Map<string, { key: string; userId: string | null; uuid: string; reports: typeof open }>();
    for (const report of open) {
      const key = personKey(report);
      const group = openGroups.get(key) ?? { key, userId: report.reportedUserId, uuid: report.reportedUuid, reports: [] };
      group.reports.push(report);
      openGroups.set(key, group);
    }

    // Handled reports, one row per decision (a decision marks all of a player's reports at once)
    const doneGroups = new Map<string, { key: string; userId: string | null; uuid: string; reports: typeof done }>();
    for (const report of done) {
      const key = `${personKey(report)}|${report.status}|${report.handledAt?.toISOString() ?? ''}`;
      const group = doneGroups.get(key) ?? { key, userId: report.reportedUserId, uuid: report.reportedUuid, reports: [] };
      group.reports.push(report);
      doneGroups.set(key, group);
    }

    const openPeople = await withWokas(
      [...openGroups.values()].map((group) => ({
        key: group.key,
        userId: group.userId,
        userUuid: group.uuid,
        ...nameOf(group),
        reports: group.reports.map((report) => ({
          id: report.id,
          comment: report.comment,
          createdAt: report.createdAt.toISOString(),
          reporterName: nameOf({ userId: report.reporterUserId, uuid: report.reporterUuid }).name,
          roomName: report.room?.name ?? null,
        })),
      })),
    );
    const donePeople = await withWokas(
      [...doneGroups.values()].map((group) => ({
        key: group.key,
        userId: group.userId,
        userUuid: group.uuid,
        ...nameOf(group),
        count: group.reports.length,
        roomName: group.reports[0].room?.name ?? null,
        outcome: group.reports[0].status as 'dismissed' | 'banned',
        handledByName: by(group.reports[0].handledBy),
        handledAt: group.reports[0].handledAt?.toISOString() ?? null,
      })),
    );
    const banned = await withWokas(
      bans.map((ban) => ({
        id: ban.id,
        userId: ban.userId,
        userUuid: ban.user?.uuid ?? null,
        ...(ban.user ? nameOf({ userId: ban.user.id, uuid: ban.user.uuid }) : { name: 'Guest', isGuest: true }),
        expiresAt: ban.expiresAt?.toISOString() ?? null,
        reason: ban.reason,
        bannedByName: by(ban.bannedBy),
        bannedAt: ban.bannedAt.toISOString(),
        // Only an appeal still waiting for an answer asks anything of the admins
        appeal: ban.appealedAt && !ban.appealDecision ? { text: ban.appealText ?? '', sentAt: ban.appealedAt.toISOString() } : null,
      })),
    );

    return NextResponse.json({
      open: openPeople,
      done: donePeople,
      bans: banned,
      counts: { reports: open.length, appeals: banned.filter((ban) => ban.appeal).length },
    });
  } catch (error) {
    console.error('Error in GET /api/admin/worlds/[id]/safety:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Dismiss a player's reports, ban them from the world, lift a ban, or answer an appeal by keeping the ban. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    if (!(await canModerateWorld(sessionUser, id))) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
    const body = parsed.data;
    const now = new Date();

    if (body.action === 'dismiss' || body.action === 'ban') {
      const byUuid = body.person.startsWith('uuid:');
      // The player's Orbit record, if Orbit knows them by now
      const user = await prisma.user.findFirst({
        where: byUuid ? { uuid: body.person.slice(5) } : { id: body.person },
        select: { id: true, uuid: true },
      });
      // Every open report about them in this world: by game uuid from before Orbit knew them, and by Orbit id since
      const openReports = {
        worldId: id,
        status: 'open',
        OR: user
          ? [{ reportedUserId: user.id }, { reportedUserId: null, reportedUuid: user.uuid }]
          : [byUuid ? { reportedUserId: null, reportedUuid: body.person.slice(5) } : { reportedUserId: body.person }],
      };

      if (body.action === 'dismiss') {
        const { count } = await prisma.report.updateMany({ where: openReports, data: { status: 'dismissed', handledById: sessionUser.id, handledAt: now } });
        // Nothing left to dismiss: another admin handled them, or the player's account was deleted since the list loaded
        if (count === 0) return NextResponse.json({ error: 'Those reports changed since you opened this page. Refresh to see the latest.' }, { status: 404 });
        return NextResponse.json({ ok: true });
      }

      // A ban needs the player's Orbit record; someone reported only by a game uuid Orbit never saw can't be banned
      if (!user) return NextResponse.json({ error: 'Player not found' }, { status: 404 });
      if (user.id === sessionUser.id) return NextResponse.json({ error: 'You can’t ban yourself' }, { status: 400 });
      const owner = await prisma.world.findFirst({ where: { id, universe: { ownerId: user.id } }, select: { id: true } });
      if (owner) return NextResponse.json({ error: 'The universe’s owner can’t be banned from its worlds' }, { status: 400 });

      await prisma.$transaction([
        // A new ban replaces any ban they already have from this world
        prisma.ban.updateMany({
          where: { userId: user.id, worldId: id, isActive: true },
          data: { isActive: false, liftedAt: now, liftedById: sessionUser.id },
        }),
        prisma.ban.create({
          data: {
            userId: user.id,
            worldId: id,
            reason: body.reason || null,
            bannedById: sessionUser.id,
            expiresAt: banEndsAt(body.duration, now),
          },
        }),
        prisma.report.updateMany({ where: openReports, data: { status: 'banned', handledById: sessionUser.id, handledAt: now } }),
      ]);
      const sentOut = await sendOutOfWorld(user.uuid, id);
      return NextResponse.json({ ok: true, sentOut });
    }

    // Only a ban still in force, as the Banned list shows: one that ran out has nothing left to lift or answer
    const ban = await prisma.ban.findFirst({
      where: { id: body.banId, worldId: id, isActive: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    });
    if (!ban) return NextResponse.json({ error: 'Ban not found' }, { status: 404 });

    if (body.action === 'lift') {
      await prisma.ban.update({
        where: { id: ban.id },
        data: {
          isActive: false,
          liftedAt: now,
          liftedById: sessionUser.id,
          // Lifting a ban that has an appeal waiting answers it
          ...(ban.appealedAt && !ban.appealDecision ? { appealDecision: 'lifted', appealDecidedAt: now, appealDecidedById: sessionUser.id } : {}),
        },
      });
      return NextResponse.json({ ok: true });
    }

    if (!ban.appealedAt || ban.appealDecision) return NextResponse.json({ error: 'No appeal to answer' }, { status: 409 });
    await prisma.ban.update({
      where: { id: ban.id },
      data: { appealDecision: 'kept', appealDecidedAt: now, appealDecidedById: sessionUser.id },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error in POST /api/admin/worlds/[id]/safety:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

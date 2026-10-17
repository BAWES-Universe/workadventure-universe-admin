import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// GET /api/memberships/invitations - Get current user's pending invitations
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const invitations = await prisma.membershipInvitation.findMany({
      where: {
        invitedUserId: sessionUser.id,
        status: 'pending',
      },
      include: {
        world: {
          select: {
            id: true,
            name: true,
            slug: true,
            universe: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
        // Who invited you is shown by name; their email stays private
        invitedBy: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });

    // A universe invitation (#314) names its roles by id: send their names and colours, highest first
    const roleIds = [...new Set(invitations.flatMap((invitation) => invitation.roleIds))];
    const roles = roleIds.length
      ? await prisma.role.findMany({
          where: { id: { in: roleIds } },
          select: { id: true, name: true, color: true, badge: true, position: true },
          orderBy: { position: 'desc' },
        })
      : [];
    return NextResponse.json({
      invitations: invitations.map((invitation) => ({
        ...invitation,
        roles: roles
          .filter((role) => invitation.roleIds.includes(role.id))
          .map((role) => ({ id: role.id, name: role.name, color: role.color, badge: role.badge })),
      })),
    });
  } catch (error) {
    console.error('Error fetching invitations:', error);
    return NextResponse.json(
      { error: 'Failed to fetch invitations' },
      { status: 500 }
    );
  }
}


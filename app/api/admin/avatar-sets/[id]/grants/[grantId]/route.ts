import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: Promise<{ id: string; grantId: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const grant = await prisma.userAvatarGrant.update({
    where: { id: (await params).grantId, avatarSetId: (await params).id },
    data: { isActive: false, revokedAt: new Date() },
  })
  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'grant.revoked',
      diff: { userId: grant.userId, grantId: (await params).grantId },
    },
  })
  return new NextResponse(null, { status: 204 })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string; grantId: string } }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const grant = await prisma.userAvatarGrant.update({
    where: { id: params.grantId },
    data: { isActive: false, revokedAt: new Date() },
  })
  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'grant.revoked',
      diff: { userId: grant.userId, grantId: params.grantId },
    },
  })
  return new NextResponse(null, { status: 204 })
}

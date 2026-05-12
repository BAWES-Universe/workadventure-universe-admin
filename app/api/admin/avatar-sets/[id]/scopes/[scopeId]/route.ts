import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string; scopeId: string } }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const scope = await prisma.avatarSetScope.delete({ where: { id: params.scopeId } })
  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'scope.removed',
      diff: { scopeType: scope.scopeType, scopeId: scope.scopeId },
    },
  })
  return new NextResponse(null, { status: 204 })
}

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'
import { Prisma } from '@prisma/client'

type Params = { params: { id: string; scopeId: string } }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  try {
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
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      return NextResponse.json({ error: 'Scope not found' }, { status: 404 })
    }
    throw error
  }
}

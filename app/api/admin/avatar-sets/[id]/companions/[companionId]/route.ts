import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string; companionId: string } }

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()
  const companion = await prisma.avatarCompanion.update({
    where: { id: params.companionId, avatarSetId: params.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.behavior !== undefined && { behavior: body.behavior }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })
  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: params.id, actorId: actor.userId, action: 'companion.updated', diff: body },
  })
  return NextResponse.json(companion)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const companion = await prisma.avatarCompanion.findFirst({
    where: { id: params.companionId, avatarSetId: params.id },
  })
  if (!companion) {
    return NextResponse.json({ error: 'Companion not found' }, { status: 404 })
  }
  await prisma.avatarCompanion.delete({ where: { id: params.companionId } })
  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: params.id, actorId: actor.userId, action: 'companion.removed', diff: { textureId: companion.textureId } },
  })
  return new NextResponse(null, { status: 204 })
}

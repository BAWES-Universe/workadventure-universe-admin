import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string; layerId: string } }

// PATCH /api/admin/avatar-sets/:id/layers/:layerId
export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  const layer = await prisma.avatarLayer.update({
    where: { id: params.layerId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'layer.updated',
      diff: { layerId: params.layerId, ...body },
    },
  })

  return NextResponse.json(layer)
}

// DELETE /api/admin/avatar-sets/:id/layers/:layerId
export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()

  const layer = await prisma.avatarLayer.delete({ where: { id: params.layerId } })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'layer.removed',
      diff: { textureId: layer.textureId, layer: layer.layer },
    },
  })

  return new NextResponse(null, { status: 204 })
}

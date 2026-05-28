import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession, requireSuperAdminSession } from '@/lib/auth'

type Params = { params: Promise<{ id: string }> }

// GET /api/admin/avatar-sets/:id/layers
export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const layers = await prisma.avatarLayer.findMany({
    where: { avatarSetId: (await params).id },
    orderBy: [{ layer: 'asc' }, { position: 'asc' }],
  })
  return NextResponse.json(layers)
}

// POST /api/admin/avatar-sets/:id/layers
export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()

  const VALID_LAYER_TYPES = ['woka', 'body', 'eyes', 'hair', 'clothes', 'hat', 'accessory', 'shoes', 'background']

  if (!body.layer || !VALID_LAYER_TYPES.includes(body.layer)) {
    return NextResponse.json({ error: `Invalid layer type. Must be one of: ${VALID_LAYER_TYPES.join(', ')}` }, { status: 400 })
  }

  const layer = await prisma.avatarLayer.create({
    data: {
      avatarSetId: (await params).id,
      textureId: body.textureId,
      layer: body.layer,
      name: body.name ?? null,
      url: body.url,
      position: body.position ?? 0,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'layer.added',
      diff: { after: { textureId: layer.textureId, layer: layer.layer, url: layer.url } },
    },
  })

  return NextResponse.json(layer, { status: 201 })
}

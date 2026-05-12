import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  return NextResponse.json(
    await prisma.avatarCompanion.findMany({
      where: { avatarSetId: params.id },
      orderBy: { position: 'asc' },
    })
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  if (!body.textureId || !body.url) {
    return NextResponse.json({ error: 'textureId and url are required' }, { status: 400 })
  }

  const companion = await prisma.avatarCompanion.create({
    data: {
      avatarSetId: params.id,
      textureId: body.textureId,
      name: body.name ?? null,
      url: body.url,
      behavior: body.behavior ?? null,
      position: body.position ?? 0,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'companion.added',
      diff: { after: { textureId: companion.textureId, url: companion.url } },
    },
  })

  return NextResponse.json(companion, { status: 201 })
}

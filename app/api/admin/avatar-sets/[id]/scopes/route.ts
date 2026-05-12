import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  return NextResponse.json(
    await prisma.avatarSetScope.findMany({ where: { avatarSetId: params.id } })
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  const VALID_SCOPE_TYPES = ['platform', 'universe', 'world']
  if (!body.scopeType || !VALID_SCOPE_TYPES.includes(body.scopeType)) {
    return NextResponse.json({ error: 'Invalid or missing scopeType' }, { status: 400 })
  }

  // Validate scopeId exists for universe/world scopes
  if (body.scopeType === 'world' && body.scopeId) {
    const world = await prisma.world.findUnique({ where: { id: body.scopeId } })
    if (!world) return NextResponse.json({ error: 'World not found' }, { status: 404 })
  }
  if (body.scopeType === 'universe' && body.scopeId) {
    const universe = await prisma.universe.findUnique({ where: { id: body.scopeId } })
    if (!universe) return NextResponse.json({ error: 'Universe not found' }, { status: 404 })
  }

  const scope = await prisma.avatarSetScope.create({
    data: {
      avatarSetId: params.id,
      scopeType: body.scopeType,
      scopeId: body.scopeId ?? null,
      worldId: body.scopeType === 'world' ? (body.scopeId ?? null) : null,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'scope.added',
      diff: { scopeType: scope.scopeType, scopeId: scope.scopeId },
    },
  })

  return NextResponse.json(scope, { status: 201 })
}

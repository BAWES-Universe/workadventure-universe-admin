import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession, requireSuperAdminSession } from '@/lib/auth'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  return NextResponse.json(
    await prisma.avatarSetScope.findMany({ where: { avatarSetId: (await params).id } })
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()

  const VALID_SCOPE_TYPES = ['platform', 'universe', 'world']
  if (!body.scopeType || !VALID_SCOPE_TYPES.includes(body.scopeType)) {
    return NextResponse.json({ error: 'Invalid or missing scopeType' }, { status: 400 })
  }

  // Normalize scopeId: platform scopes get '', universe/world must be non-empty
  let scopeId: string
  if (body.scopeType === 'platform') {
    scopeId = ''
  } else {
    scopeId = body.scopeId ?? ''
    if (!scopeId) {
      return NextResponse.json({ error: 'scopeId is required for universe/world scopes' }, { status: 400 })
    }
  }

  // Validate scopeId exists for universe/world scopes
  if (body.scopeType === 'world') {
    const world = await prisma.world.findUnique({ where: { id: scopeId } })
    if (!world) return NextResponse.json({ error: 'World not found' }, { status: 404 })
  }
  if (body.scopeType === 'universe') {
    const universe = await prisma.universe.findUnique({ where: { id: scopeId } })
    if (!universe) return NextResponse.json({ error: 'Universe not found' }, { status: 404 })
  }

  const scope = await prisma.avatarSetScope.create({
    data: {
      avatarSetId: (await params).id,
      scopeType: body.scopeType,
      scopeId,
      worldId: body.scopeType === 'world' ? scopeId : null,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'scope.added',
      diff: { scopeType: scope.scopeType, scopeId: scope.scopeId },
    },
  })

  return NextResponse.json(scope, { status: 201 })
}

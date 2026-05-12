import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  return NextResponse.json(
    await prisma.userAvatarGrant.findMany({
      where: { avatarSetId: params.id },
      include: { user: { select: { id: true, name: true, email: true, uuid: true } } },
      orderBy: { grantedAt: 'desc' },
    })
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  if (!body.userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 })
  }

  const VALID_GRANT_TYPES = ['select', 'direct', 'subscription', 'promotional']
  if (!body.grantType || !VALID_GRANT_TYPES.includes(body.grantType)) {
    return NextResponse.json({ error: 'Invalid or missing grantType' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({ where: { id: body.userId } })
  if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  let expiresAt = null
  if (body.expiresAt) {
    const parsedDate = new Date(body.expiresAt)
    if (isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: 'Invalid expiresAt date' }, { status: 400 })
    }
    expiresAt = parsedDate
  }

  const grant = await prisma.userAvatarGrant.create({
    data: {
      userId: body.userId,
      avatarSetId: params.id,
      grantType: body.grantType,
      note: body.note ?? null,
      expiresAt,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'grant.issued',
      diff: { userId: body.userId, grantType: grant.grantType, note: grant.note },
    },
  })

  return NextResponse.json(grant, { status: 201 })
}

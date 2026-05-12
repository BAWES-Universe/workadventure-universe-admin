import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  return NextResponse.json(
    await prisma.avatarEntitlementPolicy.findMany({ where: { avatarSetId: params.id } })
  )
}

export async function POST(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  const VALID_SUBJECT_TYPES = ['everyone', 'membership_tag', 'user', 'email_domain', 'subscription_plan', 'external_contract']
  const VALID_ACTIONS = ['select', 'assign_to_bot', 'manage']

  if (!VALID_SUBJECT_TYPES.includes(body.subjectType)) {
    return NextResponse.json({ error: 'Invalid subjectType' }, { status: 400 })
  }
  if (!VALID_ACTIONS.includes(body.action)) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }

  if (body.worldId != null) {
    const world = await prisma.world.findUnique({ where: { id: body.worldId } })
    if (!world) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 })
    }
  }

  const policy = await prisma.avatarEntitlementPolicy.create({
    data: {
      avatarSetId: params.id,
      subjectType: body.subjectType,
      subjectValue: body.subjectValue ?? null,
      action: body.action ?? 'select',
      worldId: body.worldId ?? null,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'policy.added',
      diff: { subjectType: policy.subjectType, subjectValue: policy.subjectValue, action: policy.action },
    },
  })

  return NextResponse.json(policy, { status: 201 })
}

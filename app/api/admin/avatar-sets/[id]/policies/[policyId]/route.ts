import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string; policyId: string } }

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()
  const policy = await prisma.avatarEntitlementPolicy.update({
    where: { id: params.policyId },
    data: {
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.subjectValue !== undefined && { subjectValue: body.subjectValue }),
    },
  })
  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: params.id, actorId: actor.userId, action: 'policy.updated', diff: body },
  })
  return NextResponse.json(policy)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const policy = await prisma.avatarEntitlementPolicy.delete({ where: { id: params.policyId } })
  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'policy.removed',
      diff: { subjectType: policy.subjectType, subjectValue: policy.subjectValue },
    },
  })
  return new NextResponse(null, { status: 204 })
}

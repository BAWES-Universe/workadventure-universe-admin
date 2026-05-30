import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireSuperAdminSession } from '@/lib/auth'

type Params = { params: Promise<{ id: string; policyId: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()
  const policy = await prisma.avatarEntitlementPolicy.update({
    where: { id: (await params).policyId, avatarSetId: (await params).id },
    data: {
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(body.subjectValue !== undefined && { subjectValue: body.subjectValue }),
    },
  })
  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: (await params).id, actorId: actor.userId, action: 'policy.updated', diff: body },
  })
  return NextResponse.json(policy)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const policy = await prisma.avatarEntitlementPolicy.delete({ where: { id: (await params).policyId, avatarSetId: (await params).id } })
  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'policy.removed',
      diff: { subjectType: policy.subjectType, subjectValue: policy.subjectValue },
    },
  })
  return new NextResponse(null, { status: 204 })
}

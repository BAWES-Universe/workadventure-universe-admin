import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdminSession } from '@/lib/auth'

type Params = { params: { id: string } }

// GET /api/admin/avatar-sets/:id
export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const set = await prisma.avatarSet.findUnique({
    where: { id: params.id },
    include: {
      layers: { orderBy: { position: 'asc' } },
      companions: { orderBy: { position: 'asc' } },
      scopes: true,
      policies: true,
      userGrants: {
        where: { isActive: true },
        include: { user: { select: { id: true, name: true, email: true, uuid: true } } },
      },
      auditLogs: {
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { actor: { select: { id: true, name: true, email: true } } },
      },
    },
  })
  if (!set) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(set)
}

// PATCH /api/admin/avatar-sets/:id
export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  const before = await prisma.avatarSet.findUnique({ where: { id: params.id } })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const updated = await prisma.avatarSet.update({
    where: { id: params.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.kind !== undefined && { kind: body.kind }),
      ...(body.visibility !== undefined && { visibility: body.visibility }),
      ...(body.lifecycle !== undefined && { lifecycle: body.lifecycle }),
      ...(body.sourceOwnerType !== undefined && { sourceOwnerType: body.sourceOwnerType }),
      ...(body.partnerRef !== undefined && { partnerRef: body.partnerRef }),
      ...(body.campaignCode !== undefined && { campaignCode: body.campaignCode }),
      ...(body.monetizationType !== undefined && { monetizationType: body.monetizationType }),
      ...(body.billingReference !== undefined && { billingReference: body.billingReference }),
      ...(body.licenseNotes !== undefined && { licenseNotes: body.licenseNotes }),
      ...(body.availableFrom !== undefined && {
        availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
      }),
      ...(body.availableUntil !== undefined && {
        availableUntil: body.availableUntil ? new Date(body.availableUntil) : null,
      }),
      ...(body.position !== undefined && { position: body.position }),
    },
  })

  // Determine action label for audit
  let action = 'set.updated'
  if (body.lifecycle === 'active' && before.lifecycle !== 'active') action = 'set.published'
  if (body.lifecycle === 'archived' && before.lifecycle !== 'archived') action = 'set.archived'

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action,
      diff: { before, after: updated },
    },
  })

  return NextResponse.json(updated)
}

// DELETE /api/admin/avatar-sets/:id  — soft archive only
export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()

  // Check for active user grants or current user avatars referencing this set
  const activeGrants = await prisma.userAvatarGrant.count({
    where: { avatarSetId: params.id, isActive: true },
  })

  if (activeGrants > 0) {
    return NextResponse.json(
      {
        error: 'Cannot archive: this set has active user grants. Revoke them first.',
        activeGrants,
      },
      { status: 409 }
    )
  }

  const updated = await prisma.avatarSet.update({
    where: { id: params.id },
    data: { lifecycle: 'archived' },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: params.id,
      actorId: actor.userId,
      action: 'set.archived',
      diff: { before: { lifecycle: 'active' }, after: { lifecycle: 'archived' } },
    },
  })

  return NextResponse.json(updated)
}

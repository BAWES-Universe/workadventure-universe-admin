import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'

// GET /api/admin/avatar-sets
export async function GET() {
  await requireAdminSession()
  const sets = await prisma.avatarSet.findMany({
    include: {
      _count: { select: { layers: true, companions: true, policies: true, userGrants: true } },
      scopes: true,
    },
    orderBy: { position: 'asc' },
  })

  // Sort by lifecycle (draft → active → archived) then by position
  const lifecycleOrder = { draft: 0, active: 1, archived: 2 }
  sets.sort((a, b) => {
    const aOrder = lifecycleOrder[a.lifecycle as keyof typeof lifecycleOrder] ?? 999
    const bOrder = lifecycleOrder[b.lifecycle as keyof typeof lifecycleOrder] ?? 999
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.position - b.position
  })

  return NextResponse.json(sets)
}

// POST /api/admin/avatar-sets
export async function POST(req: NextRequest) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()

  // Validate date fields
  if (body.availableFrom) {
    const date = new Date(body.availableFrom)
    if (isNaN(date.getTime())) {
      return NextResponse.json({ error: 'Invalid availableFrom date' }, { status: 400 })
    }
  }
  if (body.availableUntil) {
    const date = new Date(body.availableUntil)
    if (isNaN(date.getTime())) {
      return NextResponse.json({ error: 'Invalid availableUntil date' }, { status: 400 })
    }
  }

  const VALID_KINDS = ['woka', 'companion']
  const VALID_VISIBILITIES = ['public', 'unlisted', 'private']
  const VALID_MONETIZATION_TYPES = ['free', 'one_time', 'subscription', 'metered']
  const VALID_SOURCE_OWNER_TYPES = ['platform', 'world_admin', 'partner']

  if (body.kind && !VALID_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: `Invalid kind. Must be one of: ${VALID_KINDS.join(', ')}` }, { status: 400 })
  }
  if (body.visibility && !VALID_VISIBILITIES.includes(body.visibility)) {
    return NextResponse.json({ error: `Invalid visibility. Must be one of: ${VALID_VISIBILITIES.join(', ')}` }, { status: 400 })
  }
  if (body.monetizationType && !VALID_MONETIZATION_TYPES.includes(body.monetizationType)) {
    return NextResponse.json({ error: `Invalid monetizationType. Must be one of: ${VALID_MONETIZATION_TYPES.join(', ')}` }, { status: 400 })
  }
  if (body.sourceOwnerType && !VALID_SOURCE_OWNER_TYPES.includes(body.sourceOwnerType)) {
    return NextResponse.json({ error: `Invalid sourceOwnerType. Must be one of: ${VALID_SOURCE_OWNER_TYPES.join(', ')}` }, { status: 400 })
  }

  const set = await prisma.avatarSet.create({
    data: {
      slug: body.slug,
      name: body.name,
      description: body.description ?? null,
      kind: body.kind ?? 'woka',
      lifecycle: 'draft',
      visibility: body.visibility ?? 'public',
      sourceOwnerType: body.sourceOwnerType ?? 'platform',
      partnerRef: body.partnerRef ?? null,
      campaignCode: body.campaignCode ?? null,
      monetizationType: body.monetizationType ?? 'free',
      billingReference: body.billingReference ?? null,
      licenseNotes: body.licenseNotes ?? null,
      availableFrom: body.availableFrom ? new Date(body.availableFrom) : null,
      availableUntil: body.availableUntil ? new Date(body.availableUntil) : null,
      position: body.position ?? 0,
    },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: set.id,
      actorId: actor.userId,
      action: 'set.created',
      diff: { after: { name: set.name, slug: set.slug, visibility: set.visibility } },
    },
  })

  return NextResponse.json(set, { status: 201 })
}

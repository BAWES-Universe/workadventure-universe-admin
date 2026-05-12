import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
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
  const actor = await requireAdminSession()
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

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
    orderBy: [{ lifecycle: 'asc' }, { position: 'asc' }],
  })
  return NextResponse.json(sets)
}

// POST /api/admin/avatar-sets
export async function POST(req: NextRequest) {
  const actor = await requireAdminSession()
  const body = await req.json()

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

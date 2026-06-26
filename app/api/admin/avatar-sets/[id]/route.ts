import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession, requireSuperAdminSession } from '@/lib/auth'
import { extractS3KeyFromUrl, deleteImageFromS3 } from '@/lib/s3-upload'

type Params = { params: Promise<{ id: string }> }

/** Scalar fields on AvatarSet that can appear in audit diff. */
const AVATAR_SET_SCALARS = [
  'name', 'description', 'kind', 'visibility', 'lifecycle',
  'sourceOwnerType', 'partnerRef', 'campaignCode', 'monetizationType',
  'billingReference', 'licenseNotes', 'position', 'availableFrom', 'availableUntil',
] as const

/**
 * Given a full AvatarSet row (which may contain relation keys), return
 * only the scalar fields relevant for audit logging.
 */
function pickAvatarSetScalars(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of AVATAR_SET_SCALARS) {
    if (k in row) out[k] = row[k]
  }
  return out
}

/**
 * Clean up S3 file if the texture URL points to an uploaded texture.
 * Silently succeeds — deletion of built-in textures (non-S3 URLs) is a no-op.
 */
async function cleanupS3Texture(url: string): Promise<void> {
  const s3Key = extractS3KeyFromUrl(url)
  if (!s3Key) return

  // With forcePathStyle the pathname returned by extractS3KeyFromUrl includes
  // the bucket name as the first segment (e.g. "bucket/avatar-textures/…").
  // Strip any leading path segment so the guard below works reliably.
  const cleanedKey = s3Key.includes('/') ? s3Key.slice(s3Key.indexOf('/') + 1) : s3Key

  if (cleanedKey.startsWith('avatar-textures/')) {
    try {
      await deleteImageFromS3(cleanedKey)
    } catch (err) {
      console.warn('Failed to delete S3 texture (file may already be gone):', cleanedKey)
    }
  }
}

// GET /api/admin/avatar-sets/:id
export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const id = (await params).id
  const set = await prisma.avatarSet.findUnique({
    where: { id },
    include: {
      layers: { orderBy: { position: 'asc' } },
      companions: { orderBy: { position: 'asc' } },
      scopes: true,
      policies: true,
      userGrants: {
        where: { isActive: true },
        include: { user: { select: { id: true, name: true, email: true, uuid: true } } },
      },
    },
  })
  if (!set) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const auditLogs = await prisma.avatarSetAuditLog.findMany({
    where: { avatarSetId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { id: true, name: true, email: true } } },
  })

  return NextResponse.json({ ...set, auditLogs })
}

// PATCH /api/admin/avatar-sets/:id
export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()
  const id = (await params).id

  const before = await prisma.avatarSet.findUnique({ where: { id } })
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Determine action label early (based on request, not DB state)
  let action = 'set.updated'
  if (body.lifecycle === 'active' && before.lifecycle !== 'active') action = 'set.published'
  if (body.lifecycle === 'archived' && before.lifecycle !== 'archived') action = 'set.archived'

  // Perform the grant check, update, and audit log inside a single transaction
  // so a concurrent grant cannot slip between the check and the mutation.
  let updated: Record<string, unknown>
  try {
    await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction for an up-to-date view
      const current = await tx.avatarSet.findUnique({ where: { id } })
      if (!current) throw new Error('NOT_FOUND')

      if (body.lifecycle === 'archived' && current.lifecycle !== 'archived') {
        const activeGrants = await tx.userAvatarGrant.count({
          where: { avatarSetId: id, isActive: true },
        })
        if (activeGrants > 0) {
          throw new Error('GRANT_CONFLICT')
        }
      }

      updated = await tx.avatarSet.update({
        where: { id },
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

      await tx.avatarSetAuditLog.create({
        data: {
          avatarSetId: id,
          actorId: actor.userId,
          action,
          // Only log scalar field changes — omit relations (layers, grants, etc.)
          diff: { before: pickAvatarSetScalars(current), after: pickAvatarSetScalars(updated) },
        },
      })
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (e instanceof Error && e.message === 'GRANT_CONFLICT') {
      return NextResponse.json(
        {
          error: 'Cannot archive: this set has active user grants. Revoke them first.',
          activeGrants: 1,
        },
        { status: 409 }
      )
    }
    throw e
  }

  // Fetch the updated set with relations for the response (separate query — no relations leaked into audit)
  const [auditLogs, fullSet] = await Promise.all([
    prisma.avatarSetAuditLog.findMany({
      where: { avatarSetId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { actor: { select: { id: true, name: true, email: true } } },
    }),
    prisma.avatarSet.findUnique({
      where: { id },
      include: {
        layers: { orderBy: { position: 'asc' } },
        companions: { orderBy: { position: 'asc' } },
        scopes: true,
        policies: true,
        userGrants: {
          where: { isActive: true },
          include: { user: { select: { id: true, name: true, email: true, uuid: true } } },
        },
      },
    }),
  ])

  return NextResponse.json({ ...fullSet, auditLogs })
}

// DELETE /api/admin/avatar-sets/:id
//
// If lifecycle === 'archived': permanently deletes the set, all related records,
//   and S3-hosted textures. Otherwise: soft-archives (sets lifecycle to 'archived').
export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const id = (await params).id

  const existingSet = await prisma.avatarSet.findUnique({
    where: { id },
    select: { lifecycle: true, name: true },
  })

  if (!existingSet) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  // Check for active user grants — blocks both archive AND hard delete
  const activeGrants = await prisma.userAvatarGrant.count({
    where: { avatarSetId: id, isActive: true },
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

  // --- Hard delete (archive → permanent removal) ---
  if (existingSet.lifecycle === 'archived') {
    // Collect all S3-hosted texture URLs for layers and companions
    const [layers, companions] = await Promise.all([
      prisma.avatarLayer.findMany({
        where: { avatarSetId: id },
        select: { url: true },
      }),
      prisma.avatarCompanion.findMany({
        where: { avatarSetId: id },
        select: { url: true },
      }),
    ])

    // DB work first: create audit log + delete set in a single transaction
    await prisma.$transaction(async (tx) => {
      await tx.avatarSetAuditLog.create({
        data: {
          avatarSetId: id,
          actorId: actor.userId,
          action: 'set.deleted',
          diff: { name: existingSet.name, layerCount: layers.length, companionCount: companions.length },
        },
      })
      await tx.avatarSet.delete({ where: { id } })
    })

    // S3 cleanup after the DB commit — best-effort, textures are disposable
    for (const layer of layers) {
      await cleanupS3Texture(layer.url)
    }
    for (const companion of companions) {
      await cleanupS3Texture(companion.url)
    }

    return new NextResponse(null, { status: 204 })
  }

  // --- Soft archive (draft / active → archived) ---
  const updated = await prisma.avatarSet.update({
    where: { id },
    data: { lifecycle: 'archived' },
  })

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: id,
      actorId: actor.userId,
      action: 'set.archived',
      diff: { before: { lifecycle: existingSet.lifecycle }, after: { lifecycle: 'archived' } },
    },
  })

  return NextResponse.json(updated)
}

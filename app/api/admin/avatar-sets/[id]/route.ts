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

/** Error type used to abort a transaction with an active-grant conflict. */
class GrantConflictError extends Error {
  count: number
  constructor(count: number) {
    super('GRANT_CONFLICT')
    this.count = count
  }
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
  // For virtual-hosted URLs there is no bucket prefix — the key starts with
  // "avatar-textures/" directly. Only strip the leading segment when needed.
  const cleanedKey = s3Key.startsWith('avatar-textures/')
    ? s3Key
    : s3Key.replace(/^[^/]+\//, '')

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

  // Perform the grant check, update, and audit log inside a single transaction
  // so a concurrent grant cannot slip between the check and the mutation.
  let updated: Record<string, unknown> = {}
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
          throw new GrantConflictError(activeGrants)
        }
      }

      // Determine action from the transactional snapshot, not from 'before'
      let action = 'set.updated'
      if (body.lifecycle === 'active' && current.lifecycle !== 'active') action = 'set.published'
      if (body.lifecycle === 'archived' && current.lifecycle !== 'archived') action = 'set.archived'

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
          diff: { before: pickAvatarSetScalars(current), after: pickAvatarSetScalars(updated) } as any,
        },
      })
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (e instanceof GrantConflictError) {
      return NextResponse.json(
        {
          error: 'Cannot archive: this set has active user grants. Revoke them first.',
          activeGrants: e.count,
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

  // If the set was concurrently deleted between the update and this fetch,
  // fall back to the scalar data we already have from the transaction.
  const responseSet = fullSet ?? {
    ...updated,
    layers: [],
    companions: [],
    scopes: [],
    policies: [],
    userGrants: [],
  }

  return NextResponse.json({ ...responseSet, auditLogs })
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
  // (Checks happen again inside the transaction for the hard-delete path.)
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

  // Work inside a transaction so we have an up-to-date view of the set.
  const layers: { url: string }[] = []
  const companions: { url: string }[] = []

  let result: { type: 'hard-delete' } | { type: 'soft-archive'; updated: Record<string, unknown> }
  try {
    result = await prisma.$transaction(async (tx) => {
      const current = await tx.avatarSet.findUnique({
        where: { id },
        select: { lifecycle: true, name: true },
      })
      if (!current) throw new Error('NOT_FOUND')

      if (current.lifecycle === 'archived') {
        // Re-check grants inside the transaction — a concurrent grant could have been
        // created between the outer check and this point.
        const grantCount = await tx.userAvatarGrant.count({
          where: { avatarSetId: id, isActive: true },
        })
        if (grantCount > 0) {
          throw new GrantConflictError(grantCount)
        }

        // --- Hard delete ---
        // Collect texture URLs for S3 cleanup outside the transaction
        const [ls, cs] = await Promise.all([
          tx.avatarLayer.findMany({ where: { avatarSetId: id }, select: { url: true } }),
          tx.avatarCompanion.findMany({ where: { avatarSetId: id }, select: { url: true } }),
        ])
        layers.push(...ls)
        companions.push(...cs)

        await tx.avatarSetAuditLog.create({
          data: {
            avatarSetId: id,
            actorId: actor.userId,
            action: 'set.deleted',
            diff: { name: current.name, layerCount: ls.length, companionCount: cs.length },
          },
        })
        await tx.avatarSet.delete({ where: { id } })

        return { type: 'hard-delete' as const }
      }

      // --- Soft archive ---
      const updated = await tx.avatarSet.update({
        where: { id },
        data: { lifecycle: 'archived' },
      })

      await tx.avatarSetAuditLog.create({
        data: {
          avatarSetId: id,
          actorId: actor.userId,
          action: 'set.archived',
          diff: { before: { lifecycle: current.lifecycle }, after: { lifecycle: 'archived' } },
        },
      })

      return { type: 'soft-archive' as const, updated }
    })
  } catch (e) {
    if (e instanceof Error && e.message === 'NOT_FOUND') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (e instanceof GrantConflictError) {
      return NextResponse.json(
        {
          error: 'Cannot archive: this set has active user grants. Revoke them first.',
          activeGrants: e.count,
        },
        { status: 409 }
      )
    }
    throw e
  }

  if (result.type === 'hard-delete') {
    // S3 cleanup after the DB commit — best-effort, textures are disposable
    for (const layer of layers) await cleanupS3Texture(layer.url)
    for (const companion of companions) await cleanupS3Texture(companion.url)
    return new NextResponse(null, { status: 204 })
  }

  return NextResponse.json(result.updated)
}

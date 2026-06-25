import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession, requireSuperAdminSession } from '@/lib/auth'
import { extractS3KeyFromUrl, deleteImageFromS3 } from '@/lib/s3-upload'

type Params = { params: Promise<{ id: string }> }

/**
 * Clean up S3 file if the texture URL points to an uploaded texture.
 * Silently succeeds — deletion of built-in textures (non-S3 URLs) is a no-op.
 */
async function cleanupS3Texture(url: string): Promise<void> {
  const s3Key = extractS3KeyFromUrl(url)
  if (s3Key && s3Key.startsWith('avatar-textures/')) {
    try {
      await deleteImageFromS3(s3Key)
    } catch (err) {
      console.warn('Failed to delete S3 texture (file may already be gone):', s3Key)
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

  // Prevent archiving sets with active grants (same guard as DELETE)
  if (body.lifecycle === 'archived' && before.lifecycle !== 'archived') {
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
  }

  const updated = await prisma.avatarSet.update({
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

  // Determine action label for audit
  let action = 'set.updated'
  if (body.lifecycle === 'active' && before.lifecycle !== 'active') action = 'set.published'
  if (body.lifecycle === 'archived' && before.lifecycle !== 'archived') action = 'set.archived'

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: id,
      actorId: actor.userId,
      action,
      diff: { before, after: updated },
    },
  })

  const auditLogs = await prisma.avatarSetAuditLog.findMany({
    where: { avatarSetId: id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: { select: { id: true, name: true, email: true } } },
  })

  return NextResponse.json({ ...updated, auditLogs })
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

    // Delete S3 files for each texture (best-effort, built-in URLs skipped)
    for (const layer of layers) {
      await cleanupS3Texture(layer.url)
    }
    for (const companion of companions) {
      await cleanupS3Texture(companion.url)
    }

    // Create audit log BEFORE deleting the set (no FK constraint — audit log survives as a permanent record)
    await prisma.avatarSetAuditLog.create({
      data: {
        avatarSetId: id,
        actorId: actor.userId,
        action: 'set.deleted',
        diff: { name: existingSet.name, layerCount: layers.length, companionCount: companions.length },
      },
    })

    // Delete the set — related records removed via Prisma cascade
    await prisma.avatarSet.delete({ where: { id } })

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

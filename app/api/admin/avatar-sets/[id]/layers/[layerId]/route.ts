import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'
import { extractS3KeyFromUrl, deleteImageFromS3 } from '@/lib/s3-upload'

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

type Params = { params: Promise<{ id: string; layerId: string }> }

// GET /api/admin/avatar-sets/:id/layers/:layerId
export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const layer = await prisma.avatarLayer.findFirst({
    where: { id: (await params).layerId, avatarSetId: (await params).id },
  })
  if (!layer) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(layer)
}

// PATCH /api/admin/avatar-sets/:id/layers/:layerId
export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()
  const body = await req.json()

  const existing = await prisma.avatarLayer.findFirst({
    where: { id: (await params).layerId, avatarSetId: (await params).id },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const layer = await prisma.avatarLayer.update({
    where: { id: (await params).layerId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  // If URL changed from an S3 texture, clean up the old file
  if (body.url !== undefined && body.url !== existing.url) {
    await cleanupS3Texture(existing.url)
  }

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'layer.updated',
      diff: { layerId: (await params).layerId, ...body },
    },
  })

  return NextResponse.json(layer)
}

// DELETE /api/admin/avatar-sets/:id/layers/:layerId
export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireSuperAdminSession()

  // Fetch the layer first to get its URL for S3 cleanup
  const existing = await prisma.avatarLayer.findFirst({
    where: { id: (await params).layerId, avatarSetId: (await params).id },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const layer = await prisma.avatarLayer.delete({ where: { id: (await params).layerId } })

  // Clean up S3 file if it's an uploaded texture
  await cleanupS3Texture(layer.url)

  await prisma.avatarSetAuditLog.create({
    data: {
      avatarSetId: (await params).id,
      actorId: actor.userId,
      action: 'layer.removed',
      diff: { textureId: layer.textureId, layer: layer.layer },
    },
  })

  return new NextResponse(null, { status: 204 })
}

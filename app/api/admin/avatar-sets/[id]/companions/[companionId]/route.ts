import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'
import { extractS3KeyFromUrl, deleteImageFromS3 } from '@/lib/s3-upload'

/**
 * Clean up S3 file if the texture URL points to an uploaded texture.
 * Built-in textures (non-S3 URLs) are not affected.
 */
async function cleanupS3Texture(url: string): Promise<void> {
  const s3Key = extractS3KeyFromUrl(url)
  if (s3Key && s3Key.startsWith('avatar-textures/')) {
    try {
      await deleteImageFromS3(s3Key)
    } catch {
      console.warn('Failed to delete S3 texture:', s3Key)
    }
  }
}

type Params = { params: Promise<{ id: string; companionId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  await requireAdminSession()
  const companion = await prisma.avatarCompanion.findUnique({
    where: { id: (await params).companionId },
  })
  if (!companion) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(companion)
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()

  // Fetch existing to check for S3 URL change
  const existing = await prisma.avatarCompanion.findUnique({
    where: { id: (await params).companionId },
  })
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const companion = await prisma.avatarCompanion.update({
    where: { id: (await params).companionId, avatarSetId: (await params).id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.behavior !== undefined && { behavior: body.behavior }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })

  // If URL changed from an S3 texture, clean up the old file
  if (body.url !== undefined && body.url !== existing.url) {
    await cleanupS3Texture(existing.url)
  }

  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: (await params).id, actorId: actor.userId, action: 'companion.updated', diff: body },
  })
  return NextResponse.json(companion)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const companion = await prisma.avatarCompanion.findFirst({
    where: { id: (await params).companionId, avatarSetId: (await params).id },
  })
  if (!companion) {
    return NextResponse.json({ error: 'Companion not found' }, { status: 404 })
  }
  await prisma.avatarCompanion.delete({ where: { id: (await params).companionId } })

  // Clean up S3 file if it's an uploaded texture
  await cleanupS3Texture(companion.url)

  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: (await params).id, actorId: actor.userId, action: 'companion.removed', diff: { textureId: companion.textureId } },
  })
  return new NextResponse(null, { status: 204 })
}

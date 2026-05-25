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

type Params = { params: { id: string; companionId: string } }

export async function PATCH(req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const body = await req.json()
  const companion = await prisma.avatarCompanion.update({
    where: { id: params.companionId, avatarSetId: params.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.url !== undefined && { url: body.url }),
      ...(body.behavior !== undefined && { behavior: body.behavior }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  })
  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: params.id, actorId: actor.userId, action: 'companion.updated', diff: body },
  })
  return NextResponse.json(companion)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const actor = await requireAdminSession()
  const companion = await prisma.avatarCompanion.findFirst({
    where: { id: params.companionId, avatarSetId: params.id },
  })
  if (!companion) {
    return NextResponse.json({ error: 'Companion not found' }, { status: 404 })
  }
  await prisma.avatarCompanion.delete({ where: { id: params.companionId } })

  // Clean up S3 file if it's an uploaded texture
  await cleanupS3Texture(companion.url)

  await prisma.avatarSetAuditLog.create({
    data: { avatarSetId: params.id, actorId: actor.userId, action: 'companion.removed', diff: { textureId: companion.textureId } },
  })
  return new NextResponse(null, { status: 204 })
}

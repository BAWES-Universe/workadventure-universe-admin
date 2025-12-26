import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { z } from 'zod';

const updateMapSchema = z.object({
  templateId: z.string().uuid().optional(),
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  mapUrl: z.string().url().optional(),
  previewImageUrl: z.string().url().nullable().optional(),
  sizeLabel: z.string().nullable().optional(),
  orientation: z.string().optional(),
  tileSize: z.number().int().optional(),
  recommendedWorldTags: z.array(z.string()).optional(),
  authorId: z.string().nullable().optional(),
  order: z.number().int().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/admin/templates/maps/[id]
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { id } = await params;
    const map = await prisma.roomTemplateMap.findUnique({
      where: { id },
      include: {
        template: {
          include: {
            category: true,
          },
        },
        _count: {
          select: { rooms: true },
        },
      },
    });

    if (!map) {
      return NextResponse.json(
        { error: 'Map not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ map });
  } catch (error) {
    console.error('Error fetching map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PUT /api/admin/templates/maps/[id]
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const data = updateMapSchema.parse(body);

    // Check if map exists
    const existing = await prisma.roomTemplateMap.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Map not found' },
        { status: 404 }
      );
    }

    // If templateId is being changed, verify it exists
    if (data.templateId && data.templateId !== existing.templateId) {
      const template = await prisma.roomTemplate.findUnique({
        where: { id: data.templateId },
      });
      if (!template) {
        return NextResponse.json(
          { error: 'Template not found' },
          { status: 404 }
        );
      }
    }

    // If slug or templateId is being changed, check for conflicts
    const newTemplateId = data.templateId || existing.templateId;
    const newSlug = data.slug || existing.slug;

    if (data.slug || data.templateId) {
      const slugExists = await prisma.roomTemplateMap.findUnique({
        where: {
          templateId_slug: {
            templateId: newTemplateId,
            slug: newSlug,
          },
        },
      });
      if (slugExists && slugExists.id !== id) {
        return NextResponse.json(
          { error: 'Map with this slug already exists for this template' },
          { status: 409 }
        );
      }
    }

    const map = await prisma.roomTemplateMap.update({
      where: { id },
      data: {
        ...(data.templateId && { templateId: data.templateId }),
        ...(data.slug && { slug: data.slug }),
        ...(data.name && { name: data.name }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.mapUrl && { mapUrl: data.mapUrl }),
        ...(data.previewImageUrl !== undefined && { previewImageUrl: data.previewImageUrl }),
        ...(data.sizeLabel !== undefined && { sizeLabel: data.sizeLabel }),
        ...(data.orientation && { orientation: data.orientation }),
        ...(data.tileSize !== undefined && { tileSize: data.tileSize }),
        ...(data.recommendedWorldTags !== undefined && { recommendedWorldTags: data.recommendedWorldTags }),
        ...(data.authorId !== undefined && { authorId: data.authorId }),
        ...(data.order !== undefined && { order: data.order }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      include: {
        template: {
          include: {
            category: true,
          },
        },
      },
    });

    return NextResponse.json({ map });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/templates/maps/[id]
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { id } = await params;

    // Check if map is used by any rooms
    const map = await prisma.roomTemplateMap.findUnique({
      where: { id },
      include: {
        _count: {
          select: { rooms: true },
        },
      },
    });

    if (!map) {
      return NextResponse.json(
        { error: 'Map not found' },
        { status: 404 }
      );
    }

    if (map._count.rooms > 0) {
      return NextResponse.json(
        { error: 'Cannot delete map that is used by existing rooms' },
        { status: 400 }
      );
    }

    await prisma.roomTemplateMap.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


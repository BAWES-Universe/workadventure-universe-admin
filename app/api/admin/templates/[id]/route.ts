import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { z } from 'zod';

const updateTemplateSchema = z.object({
  categoryId: z.string().uuid().optional(),
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  shortDescription: z.string().nullable().optional(),
  philosophy: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  whoItsFor: z.string().nullable().optional(),
  typicalUseCases: z.array(z.string()).optional(),
  visibility: z.string().optional(),
  isFeatured: z.boolean().optional(),
  authorId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

// GET /api/admin/templates/[id]
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
    const template = await prisma.roomTemplate.findUnique({
      where: { id },
      include: {
        category: true,
        maps: {
          orderBy: { order: 'asc' },
        },
      },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ template });
  } catch (error) {
    console.error('Error fetching template:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PUT /api/admin/templates/[id]
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
    const data = updateTemplateSchema.parse(body);

    // Check if template exists
    const existing = await prisma.roomTemplate.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // If categoryId is being changed, verify it exists
    if (data.categoryId && data.categoryId !== existing.categoryId) {
      const category = await prisma.roomTemplateCategory.findUnique({
        where: { id: data.categoryId },
      });
      if (!category) {
        return NextResponse.json(
          { error: 'Category not found' },
          { status: 404 }
        );
      }
    }

    // If slug is being changed, check for conflicts
    if (data.slug && data.slug !== existing.slug) {
      const slugExists = await prisma.roomTemplate.findUnique({
        where: { slug: data.slug },
      });
      if (slugExists) {
        return NextResponse.json(
          { error: 'Template with this slug already exists' },
          { status: 409 }
        );
      }
    }

    const template = await prisma.roomTemplate.update({
      where: { id },
      data: {
        ...(data.categoryId && { categoryId: data.categoryId }),
        ...(data.slug && { slug: data.slug }),
        ...(data.name && { name: data.name }),
        ...(data.shortDescription !== undefined && { shortDescription: data.shortDescription }),
        ...(data.philosophy !== undefined && { philosophy: data.philosophy }),
        ...(data.purpose !== undefined && { purpose: data.purpose }),
        ...(data.whoItsFor !== undefined && { whoItsFor: data.whoItsFor }),
        ...(data.typicalUseCases !== undefined && { typicalUseCases: data.typicalUseCases }),
        ...(data.visibility && { visibility: data.visibility }),
        ...(data.isFeatured !== undefined && { isFeatured: data.isFeatured }),
        ...(data.authorId !== undefined && { authorId: data.authorId }),
        ...(data.isActive !== undefined && { isActive: data.isActive }),
      },
      include: {
        category: true,
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating template:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/templates/[id]
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

    // Get template with all maps and their rooms
    const template = await prisma.roomTemplate.findUnique({
      where: { id },
      include: {
        maps: {
          include: {
            rooms: {
              select: {
                id: true,
                mapUrl: true,
              },
            },
          },
        },
      },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Preserve all rooms by copying mapUrl from each map before deletion
    let totalRoomsPreserved = 0;
    for (const map of template.maps) {
      if (map.rooms.length > 0) {
        await prisma.room.updateMany({
          where: {
            templateMapId: map.id,
          },
          data: {
            mapUrl: map.mapUrl, // Copy the template map's URL to preserve the room
          },
        });
        totalRoomsPreserved += map.rooms.length;
      }
    }

    if (totalRoomsPreserved > 0) {
      console.log(`Preserved ${totalRoomsPreserved} room(s) across ${template.maps.length} map(s) before template deletion`);
    }

    // Delete the template (cascades to maps)
    await prisma.roomTemplate.delete({
      where: { id },
    });

    return NextResponse.json({ 
      success: true,
      roomsPreserved: totalRoomsPreserved,
      mapsDeleted: template.maps.length,
    });
  } catch (error) {
    console.error('Error deleting template:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


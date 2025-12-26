import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { z } from 'zod';
import { moveTempPreviewImage } from '@/lib/s3-upload';

const createMapSchema = z.object({
  templateId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  mapUrl: z.string().url(),
  previewImageUrl: z.string().url().nullable().optional(),
  sizeLabel: z.string().nullable().optional(),
  orientation: z.string().default('orthogonal'),
  tileSize: z.number().int().default(32),
  recommendedWorldTags: z.array(z.string()).optional(),
  authorId: z.string().nullable().optional(),
  order: z.number().int().default(0),
  isActive: z.boolean().default(true),
});

const updateMapSchema = createMapSchema.partial().extend({
  templateId: z.string().uuid().optional(),
  slug: z.string().min(1).max(100).optional(),
  mapUrl: z.string().url().optional(),
});

// GET /api/admin/templates/maps
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const templateId = searchParams.get('templateId');

    const where: any = {};
    if (templateId) {
      where.templateId = templateId;
    }

    const maps = await prisma.roomTemplateMap.findMany({
      where,
      include: {
        template: {
          select: {
            id: true,
            slug: true,
            name: true,
            category: {
              select: {
                id: true,
                slug: true,
                name: true,
              },
            },
          },
        },
        _count: {
          select: { rooms: true },
        },
      },
      orderBy: [
        { template: { category: { order: 'asc' } } },
        { template: { name: 'asc' } },
        { order: 'asc' },
      ],
    });

    return NextResponse.json({ maps });
  } catch (error) {
    console.error('Error fetching maps:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/admin/templates/maps
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const body = await request.json();
    const data = createMapSchema.parse(body);

    // Verify template exists
    const template = await prisma.roomTemplate.findUnique({
      where: { id: data.templateId },
    });

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      );
    }

    // Check if slug already exists for this template
    const existing = await prisma.roomTemplateMap.findUnique({
      where: {
        templateId_slug: {
          templateId: data.templateId,
          slug: data.slug,
        },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'Map with this slug already exists for this template' },
        { status: 409 }
      );
    }

    const map = await prisma.roomTemplateMap.create({
      data: {
        templateId: data.templateId,
        slug: data.slug,
        name: data.name,
        description: data.description || null,
        mapUrl: data.mapUrl,
        previewImageUrl: data.previewImageUrl || null,
        sizeLabel: data.sizeLabel || null,
        orientation: data.orientation,
        tileSize: data.tileSize,
        recommendedWorldTags: data.recommendedWorldTags || [],
        authorId: data.authorId || null,
        order: data.order,
        isActive: data.isActive,
      },
      include: {
        template: {
          include: {
            category: true,
          },
        },
      },
    });

    // If previewImageUrl is a temp image, move it to the final location with the actual mapId
    if (map.previewImageUrl && map.previewImageUrl.includes('template-maps/temp-')) {
      try {
        const movedUrl = await moveTempPreviewImage(map.previewImageUrl, map.id);
        // Update the map with the final URL
        const updatedMap = await prisma.roomTemplateMap.update({
          where: { id: map.id },
          data: { previewImageUrl: movedUrl },
          include: {
            template: {
              include: {
                category: true,
              },
            },
          },
        });
        return NextResponse.json(updatedMap, { status: 201 });
      } catch (error) {
        console.error('Error moving temp preview image after map creation:', error);
        // Continue with original URL if move fails
      }
    }

    return NextResponse.json(map, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error creating map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


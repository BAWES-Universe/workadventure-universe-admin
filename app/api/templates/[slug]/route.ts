import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/templates/[slug]
// Public endpoint - no authentication required
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;

    const template = await prisma.roomTemplate.findUnique({
      where: {
        slug,
        isActive: true,
        visibility: 'public',
      },
      include: {
        category: {
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            icon: true,
          },
        },
        maps: {
          where: {
            isActive: true,
          },
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            mapUrl: true,
            previewImageUrl: true,
            sizeLabel: true,
            recommendedWorldTags: true,
            order: true,
            _count: {
              select: {
                rooms: true,
              },
            },
          },
          orderBy: {
            order: 'asc',
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

    // Return template with all fields (including future fields for extensibility)
    return NextResponse.json({
      template: {
        id: template.id,
        slug: template.slug,
        name: template.name,
        shortDescription: template.shortDescription,
        philosophy: template.philosophy,
        purpose: template.purpose,
        whoItsFor: template.whoItsFor,
        typicalUseCases: template.typicalUseCases,
        isFeatured: template.isFeatured,
        category: template.category,
        maps: template.maps,
      },
    });
  } catch (error) {
    console.error('Error fetching template:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


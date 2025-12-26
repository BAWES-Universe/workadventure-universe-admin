import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/templates
// Public endpoint - no authentication required
// Query params: category (slug), search (optional)
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const categorySlug = searchParams.get('category');
    const search = searchParams.get('search') || '';

    // Build where clause
    const where: any = {
      isActive: true,
      visibility: 'public',
    };

    if (categorySlug) {
      where.category = {
        slug: categorySlug,
        isActive: true,
      };
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { shortDescription: { contains: search, mode: 'insensitive' as const } },
      ];
    }

    // Fetch templates
    const templates = await prisma.roomTemplate.findMany({
      where,
      include: {
        category: {
          select: {
            id: true,
            slug: true,
            name: true,
            icon: true,
          },
        },
        _count: {
          select: {
            maps: {
              where: {
                isActive: true,
              },
            },
          },
        },
      },
      orderBy: [
        { isFeatured: 'desc' },
        { name: 'asc' },
      ],
    });

    // Fetch all categories for filter
    const categories = await prisma.roomTemplateCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        order: 'asc',
      },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        icon: true,
        order: true,
      },
    });

    // Transform templates to include map count and preserve _count structure
    const templatesWithMapCount = templates.map((template) => ({
      id: template.id,
      slug: template.slug,
      name: template.name,
      shortDescription: template.shortDescription,
      philosophy: template.philosophy,
      category: template.category,
      mapCount: template._count.maps,
      isFeatured: template.isFeatured,
      _count: {
        maps: template._count.maps,
      },
    }));

    return NextResponse.json({
      templates: templatesWithMapCount,
      categories,
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


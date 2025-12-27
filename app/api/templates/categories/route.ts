import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// GET /api/templates/categories
// Public endpoint - no authentication required
export async function GET(request: NextRequest) {
  try {
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
        isActive: true,
        _count: {
          select: {
            templates: {
              where: {
                isActive: true,
              },
            },
          },
        },
        templates: {
          where: {
            isActive: true,
            visibility: 'public',
          },
          select: {
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
        },
      },
    });

    // Calculate map count for each category
    const categoriesWithMapCount = categories.map((category) => {
      const mapCount = category.templates.reduce(
        (sum, template) => sum + template._count.maps,
        0
      );
      const { templates, ...categoryWithoutTemplates } = category;
      return {
        ...categoryWithoutTemplates,
        _count: {
          ...category._count,
          maps: mapCount,
        },
      };
    });

    return NextResponse.json({ categories: categoriesWithMapCount });
  } catch (error) {
    console.error('Error fetching template categories:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


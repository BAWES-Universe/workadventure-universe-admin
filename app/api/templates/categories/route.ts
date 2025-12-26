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
      },
    });

    return NextResponse.json({ categories });
  } catch (error) {
    console.error('Error fetching template categories:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


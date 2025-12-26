import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { z } from 'zod';

const createTemplateSchema = z.object({
  categoryId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  shortDescription: z.string().nullable().optional(),
  philosophy: z.string().nullable().optional(),
  purpose: z.string().nullable().optional(),
  whoItsFor: z.string().nullable().optional(),
  typicalUseCases: z.array(z.string()).optional(),
  visibility: z.string().default('public'),
  isFeatured: z.boolean().default(false),
  authorId: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
});

const updateTemplateSchema = createTemplateSchema.partial().extend({
  categoryId: z.string().uuid().optional(),
  slug: z.string().min(1).max(100).optional(),
});

// GET /api/admin/templates
export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const categoryId = searchParams.get('categoryId');

    const where: any = {};
    if (categoryId) {
      where.categoryId = categoryId;
    }

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
          select: { maps: true },
        },
      },
      orderBy: [
        { category: { order: 'asc' } },
        { name: 'asc' },
      ],
    });

    return NextResponse.json({ templates });
  } catch (error) {
    console.error('Error fetching templates:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/admin/templates
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const body = await request.json();
    const data = createTemplateSchema.parse(body);

    // Verify category exists
    const category = await prisma.roomTemplateCategory.findUnique({
      where: { id: data.categoryId },
    });

    if (!category) {
      return NextResponse.json(
        { error: 'Category not found' },
        { status: 404 }
      );
    }

    // Check if slug already exists
    const existing = await prisma.roomTemplate.findUnique({
      where: { slug: data.slug },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'Template with this slug already exists' },
        { status: 409 }
      );
    }

    const template = await prisma.roomTemplate.create({
      data: {
        categoryId: data.categoryId,
        slug: data.slug,
        name: data.name,
        shortDescription: data.shortDescription || null,
        philosophy: data.philosophy || null,
        purpose: data.purpose || null,
        whoItsFor: data.whoItsFor || null,
        typicalUseCases: data.typicalUseCases || [],
        visibility: data.visibility,
        isFeatured: data.isFeatured,
        authorId: data.authorId || null,
        isActive: data.isActive,
      },
      include: {
        category: true,
      },
    });

    return NextResponse.json(template, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error creating template:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


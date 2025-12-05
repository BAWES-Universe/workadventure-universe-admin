import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const updateUniverseSchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  ownerId: z.string().uuid().optional(),
  isPublic: z.boolean().optional(),
  featured: z.boolean().optional(),
  thumbnailUrl: z.string().url().optional().nullable().or(z.literal('')),
});

// GET /api/admin/universes/[id] - Get a single universe
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAuth(request);
    
    const { id } = await params;
    const universe = await prisma.universe.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        worlds: {
          include: {
            _count: {
              select: {
                rooms: true,
                members: true,
              },
            },
          },
        },
        _count: {
          select: {
            members: true,
          },
        },
      },
    });
    
    if (!universe) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json(universe);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching universe:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/universes/[id] - Update a universe
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAuth(request);
    
    const { id } = await params;
    const body = await request.json();
    const data = updateUniverseSchema.parse(body);
    
    // Check if universe exists
    const existing = await prisma.universe.findUnique({
      where: { id },
    });
    
    if (!existing) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
      );
    }
    
    // Check if slug is being changed and already exists
    if (data.slug && data.slug !== existing.slug) {
      const slugExists = await prisma.universe.findUnique({
        where: { slug: data.slug },
      });
      
      if (slugExists) {
        return NextResponse.json(
          { error: 'Universe with this slug already exists' },
          { status: 409 }
        );
      }
    }
    
    // Verify owner exists if being changed
    if (data.ownerId) {
      const owner = await prisma.user.findUnique({
        where: { id: data.ownerId },
      });
      
      if (!owner) {
        return NextResponse.json(
          { error: 'Owner user not found' },
          { status: 404 }
        );
      }
    }
    
    const updateData: any = {};
    if (data.slug !== undefined) updateData.slug = data.slug;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.ownerId !== undefined) updateData.ownerId = data.ownerId;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    if (data.featured !== undefined) updateData.featured = data.featured;
    if (data.thumbnailUrl !== undefined) {
      updateData.thumbnailUrl = data.thumbnailUrl || null;
    }
    
    const universe = await prisma.universe.update({
      where: { id },
      data: updateData,
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
    
    return NextResponse.json(universe);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating universe:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/universes/[id] - Delete a universe
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireAuth(request);
    
    const { id } = await params;
    const universe = await prisma.universe.findUnique({
      where: { id },
    });
    
    if (!universe) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
      );
    }
    
    await prisma.universe.delete({
      where: { id },
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error deleting universe:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


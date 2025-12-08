import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const updateUniverseSchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  ownerId: z.string().uuid().optional(),
  isPublic: z.boolean().optional(),
  featured: z.boolean().optional(),
  thumbnailUrl: z.string().url().nullable().optional(),
});

// GET /api/admin/universes/[id] - Get a single universe
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    let userId: string | null = null;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = sessionUser.id;
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
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
      },
    });
    
    if (!universe) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && universe.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
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
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    let userId: string | null = null;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = sessionUser.id;
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
    const { id } = await params;
    const body = await request.json();
    
    // Normalize empty strings to null for optional fields
    if (body.thumbnailUrl === '') {
      body.thumbnailUrl = null;
    }
    if (body.description === '') {
      body.description = null;
    }
    
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
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && existing.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
    }
    
    // If using session auth, ensure user can only change owner to themselves
    if (userId && !isAdminToken && data.ownerId && data.ownerId !== userId) {
      return NextResponse.json(
        { error: 'You can only transfer ownership to yourself' },
        { status: 403 }
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
      const errorMessages = error.issues.map(issue => 
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');
      return NextResponse.json(
        { 
          error: 'Validation error', 
          message: errorMessages,
          details: error.issues 
        },
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
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    let userId: string | null = null;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = sessionUser.id;
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
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
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && universe.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
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


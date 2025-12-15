import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const updateWorldSchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  isPublic: z.boolean().optional(),
  featured: z.boolean().optional(),
  thumbnailUrl: z.string().url().optional().nullable().or(z.literal('')),
});

// GET /api/admin/worlds/[id]
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
    const world = await prisma.world.findUnique({
      where: { id },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
            ownerId: true,
          },
        },
        rooms: {
          include: {
            _count: {
              select: {
                favorites: true,
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
    
    if (!world) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // Allow viewing for anyone, but include ownership info
    // Also check if user is a world admin
    let canEdit = false;
    if (userId && !isAdminToken) {
      canEdit = world.universe.ownerId === userId;
      if (!canEdit) {
        // Check if user is a world admin
        const member = await prisma.worldMember.findFirst({
          where: {
            worldId: world.id,
            userId: userId,
            tags: { has: 'admin' },
          },
        });
        canEdit = !!member;
      }
    } else if (isAdminToken) {
      canEdit = true;
    }
    
    const responseData = {
      ...world,
      canEdit,
    };
    
    return NextResponse.json(responseData);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching world:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/worlds/[id]
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
    
    const data = updateWorldSchema.parse(body);
    
    const existing = await prisma.world.findUnique({
      where: { id },
      include: {
        universe: {
          select: {
            ownerId: true,
          },
        },
      },
    });
    
    if (!existing) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && existing.universe.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
    }
    
    // Check if slug is being changed and already exists
    if (data.slug && data.slug !== existing.slug) {
      const slugExists = await prisma.world.findUnique({
        where: {
          universeId_slug: {
            universeId: existing.universeId,
            slug: data.slug,
          },
        },
      });
      
      if (slugExists) {
        return NextResponse.json(
          { error: 'World with this slug already exists in this universe' },
          { status: 409 }
        );
      }
    }
    
    const updateData: any = {};
    if (data.slug !== undefined) updateData.slug = data.slug;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    if (data.featured !== undefined) updateData.featured = data.featured;
    if (data.thumbnailUrl !== undefined) {
      updateData.thumbnailUrl = data.thumbnailUrl || null;
    }
    
    const world = await prisma.world.update({
      where: { id },
      data: updateData,
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });
    
    return NextResponse.json(world);
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
    console.error('Error updating world:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/worlds/[id]
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
    const world = await prisma.world.findUnique({
      where: { id },
      include: {
        universe: {
          select: {
            ownerId: true,
          },
        },
      },
    });
    
    if (!world) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && world.universe.ownerId !== userId) {
      return NextResponse.json(
        { error: 'Forbidden' },
        { status: 403 }
      );
    }
    
    await prisma.world.delete({
      where: { id },
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error deleting world:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


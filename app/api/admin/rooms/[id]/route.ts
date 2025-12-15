import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { checkWamExists, getWamUrl, getWamPath, createWamFile } from '@/lib/map-storage';

const updateRoomSchema = z.object({
  slug: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  mapUrl: z.string().url().optional().nullable().or(z.literal('')),
  isPublic: z.boolean().optional(),
});

// GET /api/admin/rooms/[id]
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
    let room = await prisma.room.findUnique({
      where: { id },
      include: {
        world: {
          select: {
            id: true,
            name: true,
            slug: true,
            universe: {
              select: {
                id: true,
                name: true,
                slug: true,
                ownerId: true,
              },
            },
          },
        },
      },
    });
    
    if (!room) {
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }
    
    // Check permissions for editing (but allow viewing for anyone)
    let canEdit = false;
    if (userId && !isAdminToken) {
      // Check if user owns the universe or is an admin member of the world
      const isUniverseOwner = room.world.universe.ownerId === userId;
      const isWorldAdmin = await prisma.worldMember.findFirst({
        where: {
          worldId: room.worldId,
          userId: userId,
          tags: {
            has: 'admin',
          },
        },
      });
      
      canEdit = isUniverseOwner || !!isWorldAdmin;
    } else if (isAdminToken) {
      canEdit = true;
    }
    
    // Sync WAM URL if map-storage is configured and room has a mapUrl
    if (room.mapUrl) {
      const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL;
      const mapStorageApiToken = process.env.MAP_STORAGE_API_TOKEN;
      const playUrl = process.env.PLAY_URL;
      
      if (publicMapStorageUrl && mapStorageApiToken && playUrl) {
        try {
          // Determine domain from PLAY_URL or use DEFAULT_DOMAIN
          let domain: string;
          if (process.env.DEFAULT_DOMAIN) {
            domain = process.env.DEFAULT_DOMAIN;
          } else {
            try {
              const playUrlObj = new URL(playUrl);
              domain = playUrlObj.hostname;
            } catch {
              domain = 'workadventure.localhost'; // Fallback
            }
          }
          
          const wamPath = getWamPath(domain, room.world.universe.slug, room.world.slug, room.slug);
          const computedWamUrl = getWamUrl(domain, room.world.universe.slug, room.world.slug, room.slug, publicMapStorageUrl);
          
          // Check if WAM exists in map-storage
          const wamExists = await checkWamExists(publicMapStorageUrl, wamPath, mapStorageApiToken);
          
          if (wamExists) {
            // WAM exists, update database if not already set
            if (!room.wamUrl || room.wamUrl !== computedWamUrl) {
              await prisma.room.update({
                where: { id: room.id },
                data: { wamUrl: computedWamUrl } as any,
              });
              // Re-fetch room to get updated data
              room = await prisma.room.findUnique({
                where: { id: room.id },
                include: {
                  world: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                      universe: {
                        select: {
                          id: true,
                          name: true,
                          slug: true,
                          ownerId: true,
                        },
                      },
                    },
                  },
                },
              });
              if (!room) {
                return NextResponse.json(
                  { error: 'Room not found' },
                  { status: 404 }
                );
              }
            }
          } else if (!room.wamUrl && room.mapUrl) {
            // WAM doesn't exist but room has mapUrl - try to create it
            try {
              await createWamFile(
                publicMapStorageUrl,
                wamPath,
                room.mapUrl,
                mapStorageApiToken,
                playUrl
              );
              
              // Update room with wamUrl in database
              await prisma.room.update({
                where: { id: room.id },
                data: { wamUrl: computedWamUrl } as any,
              });
              // Re-fetch room to get updated data
              room = await prisma.room.findUnique({
                where: { id: room.id },
                include: {
                  world: {
                    select: {
                      id: true,
                      name: true,
                      slug: true,
                      universe: {
                        select: {
                          id: true,
                          name: true,
                          slug: true,
                          ownerId: true,
                        },
                      },
                    },
                  },
                },
              });
              if (!room) {
                return NextResponse.json(
                  { error: 'Room not found' },
                  { status: 404 }
                );
              }
            } catch (wamError) {
              // Log error but continue - WAM creation is optional
              console.error('Failed to create WAM file for room detail page:', wamError);
            }
          }
        } catch (error) {
          // Log error but continue - WAM sync is optional
          console.error('Error syncing WAM URL for room:', error);
        }
      }
    }
    
    // Return room with canEdit flag
    const responseData = {
      ...room,
      canEdit,
    };
    
    return NextResponse.json(responseData);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching room:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PATCH /api/admin/rooms/[id]
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
    if (body.description === '') {
      body.description = null;
    }
    if (body.mapUrl === '') {
      body.mapUrl = null;
    }
    
    const data = updateRoomSchema.parse(body);
    
    const existing = await prisma.room.findUnique({
      where: { id },
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                ownerId: true,
              },
            },
          },
        },
      },
    });
    
    if (!existing) {
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), check permissions
    if (userId && !isAdminToken) {
      // Check if user owns the universe or is an admin member of the world
      const isUniverseOwner = existing.world.universe.ownerId === userId;
      const isWorldAdmin = await prisma.worldMember.findFirst({
        where: {
          worldId: existing.worldId,
          userId: userId,
          tags: {
            has: 'admin',
          },
        },
      });
      
      if (!isUniverseOwner && !isWorldAdmin) {
        return NextResponse.json(
          { error: 'You can only update rooms in worlds where you are an admin or own the universe' },
          { status: 403 }
        );
      }
    }
    
    // Check if slug is being changed and already exists
    if (data.slug && data.slug !== existing.slug) {
      const slugExists = await prisma.room.findUnique({
        where: {
          worldId_slug: {
            worldId: existing.worldId,
            slug: data.slug,
          },
        },
      });
      
      if (slugExists) {
        return NextResponse.json(
          { error: 'Room with this slug already exists in this world' },
          { status: 409 }
        );
      }
    }
    
    const updateData: any = {};
    if (data.slug !== undefined) updateData.slug = data.slug;
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.mapUrl !== undefined) updateData.mapUrl = data.mapUrl || null;
    if (data.isPublic !== undefined) updateData.isPublic = data.isPublic;
    
    const room = await prisma.room.update({
      where: { id },
      data: updateData,
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });
    
    return NextResponse.json(room);
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
    console.error('Error updating room:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/rooms/[id]
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
    const room = await prisma.room.findUnique({
      where: { id },
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                ownerId: true,
              },
            },
          },
        },
      },
    });
    
    if (!room) {
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), check permissions
    if (userId && !isAdminToken) {
      // Check if user owns the universe or is an admin member of the world
      const isUniverseOwner = room.world.universe.ownerId === userId;
      const isWorldAdmin = await prisma.worldMember.findFirst({
        where: {
          worldId: room.worldId,
          userId: userId,
          tags: {
            has: 'admin',
          },
        },
      });
      
      if (!isUniverseOwner && !isWorldAdmin) {
        return NextResponse.json(
          { error: 'You can only delete rooms in worlds where you are an admin or own the universe' },
          { status: 403 }
        );
      }
    }
    
    await prisma.room.delete({
      where: { id },
    });
    
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error deleting room:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


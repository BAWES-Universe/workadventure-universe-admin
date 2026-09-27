import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { wokaLayersFor } from '@/lib/woka-avatar';

const visitCardSchema = z.object({
  // Your name, as everyone sees it in the game (the game reads it from here when it loads).
  name: z.string().trim().min(1).max(64).optional(),
  bio: z.string().nullable().optional(),
  links: z.array(z.object({
    label: z.string().min(1),
    // Web links only: a javascript: or data: address would run in whoever opens the profile.
    url: z.string().url().refine((value) => /^https?:\/\//i.test(value), 'Links must start with http:// or https://'),
  })).default([]),
});

// GET /api/admin/profile - Get current user's visit card
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession(request);
    
    // Get or create visit card
    let visitCard = await prisma.visitCard.findUnique({
      where: { userId: user.id },
    });
    
    // If no visit card exists, create one with empty values
    if (!visitCard) {
      visitCard = await prisma.visitCard.create({
        data: {
          userId: user.id,
          bio: null,
          links: [],
        },
      });
    }
    
    // Your Woka is decoration: a failure to read it never costs you your profile.
    const woka = await wokaLayersFor(user.id).catch(() => []);
    return NextResponse.json({
      name: user.name ?? null,
      woka,
      bio: visitCard.bio,
      links: visitCard.links as Array<{ label: string; url: string }>,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error fetching visit card:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// PUT /api/admin/profile - Update current user's visit card
export async function PUT(request: NextRequest) {
  try {
    const user = await requireSession(request);
    
    const body = await request.json();
    const validated = visitCardSchema.parse(body);
    
    // Validate all URLs
    for (const link of validated.links || []) {
      try {
        new URL(link.url);
      } catch {
        return NextResponse.json(
          { error: `Invalid URL: ${link.url}` },
          { status: 400 }
        );
      }
    }
    
    // Upsert visit card (create if doesn't exist, update if it does), and your name with it when it changed.
    const [visitCard, saved] = await prisma.$transaction([
      prisma.visitCard.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          bio: validated.bio || null,
          links: validated.links || [],
        },
        update: {
          bio: validated.bio !== undefined ? validated.bio : undefined,
          links: validated.links !== undefined ? validated.links : undefined,
        },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: validated.name !== undefined ? { name: validated.name } : {},
        select: { name: true },
      }),
    ]);
    
    return NextResponse.json({
      name: saved.name,
      bio: visitCard.bio,
      links: visitCard.links as Array<{ label: string; url: string }>,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      );
    }
    
    console.error('Error updating visit card:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


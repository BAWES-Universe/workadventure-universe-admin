import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const visitCardSchema = z.object({
  bio: z.string().nullable().optional(),
  links: z.array(z.object({
    label: z.string().min(1),
    url: z.string().url(),
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
    
    return NextResponse.json({
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
    
    // Upsert visit card (create if doesn't exist, update if it does)
    const visitCard = await prisma.visitCard.upsert({
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
    });
    
    return NextResponse.json({
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
        { error: 'Invalid request data', details: error.errors },
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


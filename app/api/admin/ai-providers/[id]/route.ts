import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey } from '@/lib/encryption';

/**
 * GET /api/admin/ai-providers/:id
 * Get AI provider by ID (super admin only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { id } = await params;

    const provider = await prisma.botsAiProvider.findUnique({
      where: { providerId: id },
    });

    if (!provider) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(provider);
  } catch (error) {
    console.error('Error getting AI provider:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/admin/ai-providers/:id
 * Update AI provider (super admin only)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { id } = await params;
    const body = await request.json();

    // Check if provider exists
    const existing = await prisma.botsAiProvider.findUnique({
      where: { providerId: id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      );
    }

    // Prepare update data
    const updateData: any = {};

    if (body.name !== undefined) updateData.name = body.name;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.endpoint !== undefined) updateData.endpoint = body.endpoint || null;
    if (body.model !== undefined) updateData.model = body.model || null;
    if (body.temperature !== undefined) updateData.temperature = body.temperature;
    if (body.maxTokens !== undefined) updateData.maxTokens = body.maxTokens;
    if (body.supportsStreaming !== undefined) updateData.supportsStreaming = body.supportsStreaming;
    if (body.settings !== undefined) updateData.settings = body.settings || {};

    // Handle API key encryption
    // If apiKey is provided and not empty, encrypt it
    // If apiKey is empty string, set to null
    if ('apiKey' in body) {
      if (body.apiKey && body.apiKey.trim() !== '') {
        updateData.apiKeyEncrypted = encryptApiKey(body.apiKey);
      } else {
        updateData.apiKeyEncrypted = null;
      }
    }

    // Handle tested status
    if (body.tested !== undefined) {
      updateData.tested = body.tested;
      if (body.tested) {
        updateData.testedAt = new Date();
      } else {
        updateData.testedAt = null;
      }
    }

    const provider = await prisma.botsAiProvider.update({
      where: { providerId: id },
      data: updateData,
    });

    return NextResponse.json(provider);
  } catch (error: any) {
    if (error.message?.includes('ENCRYPTION_KEY')) {
      return NextResponse.json(
        { error: 'Encryption key not configured' },
        { status: 500 }
      );
    }

    console.error('Error updating AI provider:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/ai-providers/:id
 * Delete AI provider (super admin only)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { id } = await params;

    // Check if provider exists
    const existing = await prisma.botsAiProvider.findUnique({
      where: { providerId: id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      );
    }

    await prisma.botsAiProvider.delete({
      where: { providerId: id },
    });

    return NextResponse.json({ status: 'deleted' });
  } catch (error) {
    console.error('Error deleting AI provider:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


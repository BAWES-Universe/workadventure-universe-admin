import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey } from '@/lib/encryption';

/**
 * GET /api/admin/ai-providers
 * List all AI providers (super admin only)
 */
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const providers = await prisma.botsAiProvider.findMany({
      orderBy: {
        name: 'asc',
      },
    });

    // Return providers with encrypted API keys (for display, we'll show masked version in UI)
    return NextResponse.json(providers);
  } catch (error) {
    console.error('Error listing AI providers:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/ai-providers
 * Create new AI provider (super admin only)
 */
export async function POST(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const {
      providerId,
      name,
      type,
      enabled = false,
      endpoint,
      apiKey, // Plain text API key (will be encrypted)
      model,
      temperature,
      maxTokens,
      supportsStreaming = true,
      settings = {},
    } = body;

    // Validate required fields
    if (!providerId || !name || !type) {
      return NextResponse.json(
        { error: 'providerId, name, and type are required' },
        { status: 400 }
      );
    }

    // Check if provider already exists
    const existing = await prisma.botsAiProvider.findUnique({
      where: { providerId },
    });

    if (existing) {
      return NextResponse.json(
        { error: 'Provider with this ID already exists' },
        { status: 409 }
      );
    }

    // Encrypt API key if provided
    let apiKeyEncrypted: string | null = null;
    if (apiKey && apiKey.trim() !== '') {
      apiKeyEncrypted = encryptApiKey(apiKey);
    }

    const provider = await prisma.botsAiProvider.create({
      data: {
        providerId,
        name,
        type,
        enabled,
        endpoint: endpoint || null,
        apiKeyEncrypted,
        model: model || null,
        temperature: temperature !== undefined ? temperature : 0.7,
        maxTokens: maxTokens || 500,
        supportsStreaming,
        settings: settings || {},
      },
    });

    return NextResponse.json(provider, { status: 201 });
  } catch (error: any) {
    if (error.message?.includes('ENCRYPTION_KEY')) {
      return NextResponse.json(
        { error: 'Encryption key not configured' },
        { status: 500 }
      );
    }

    console.error('Error creating AI provider:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


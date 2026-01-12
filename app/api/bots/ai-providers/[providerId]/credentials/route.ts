import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';

/**
 * GET /api/bots/ai-providers/:providerId/credentials
 * Get provider credentials (encrypted)
 * 
 * Auth: Service token only
 * Returns: Full provider config with encrypted credentials (apiKeyEncrypted field)
 * Note: Credentials remain encrypted - bot server will decrypt using ENCRYPTION_KEY
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> }
) {
  try {
    // Require service token (not session token)
    requireServiceToken(request);

    const { providerId } = await params;

    const provider = await prisma.botsAiProvider.findUnique({
      where: { providerId },
    });

    if (!provider) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      );
    }

    if (!provider.enabled) {
      return NextResponse.json(
        { error: 'Provider is not enabled' },
        { status: 400 }
      );
    }

    // Return provider config with encrypted credentials
    // apiKeyEncrypted is already encrypted (or null if not needed)
    // Bot server will decrypt using ENCRYPTION_KEY
    return NextResponse.json({
      providerId: provider.providerId,
      name: provider.name,
      type: provider.type,
      enabled: provider.enabled,
      endpoint: provider.endpoint,
      apiKeyEncrypted: provider.apiKeyEncrypted, // Encrypted string or null
      model: provider.model,
      temperature: provider.temperature ? Number(provider.temperature) : null,
      maxTokens: provider.maxTokens,
      supportsStreaming: provider.supportsStreaming,
      settings: provider.settings || {},
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    console.error('Error getting provider credentials:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}


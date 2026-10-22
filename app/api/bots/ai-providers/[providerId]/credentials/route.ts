import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { providerPayload } from '@/lib/ai-provider-payload';
import { UNIVERSE_AI_MISSING, UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';

/**
 * GET /api/bots/ai-providers/:providerId/credentials
 * Get provider credentials (encrypted)
 * 
 * Auth: Service token only
 * Returns: Full provider config with encrypted credentials (apiKeyEncrypted field)
 * Note: Credentials remain encrypted - bot server will decrypt using ENCRYPTION_KEY
 *
 * "universe-ai" is answered with the provider that is the Default right now, under that provider's own providerId, so a bot
 * on Universe AI follows the Default at its next reply (#374).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ providerId: string }> }
) {
  try {
    // Require service token (not session token)
    requireServiceToken(request);

    const { providerId } = await params;

    const provider =
      providerId === UNIVERSE_AI_REF
        ? await resolveUniverseAiProvider()
        : await prisma.botsAiProvider.findUnique({
            where: { providerId },
          });

    if (providerId === UNIVERSE_AI_REF && !provider) {
      return NextResponse.json({ error: UNIVERSE_AI_MISSING }, { status: 503 });
    }

    // A personal key (#374) is never served by provider id alone: it is served by bot id (/api/bots/:id/ai-credentials), after
    // checking whose bot it is and where the key is lent. Here it does not exist.
    if (!provider || provider.ownerId) {
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
    return NextResponse.json(providerPayload(provider));
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


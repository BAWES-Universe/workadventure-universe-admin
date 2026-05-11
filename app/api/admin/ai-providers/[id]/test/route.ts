import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey } from '@/lib/encryption';

/**
 * POST /api/admin/ai-providers/:id/test
 * Test provider connection (super admin only)
 *
 * This endpoint attempts to connect to the provider and verify credentials
 */
export async function POST(
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

    // Decrypt API key for testing (only in admin context)
    let apiKey: string | null = null;
    if (provider.apiKeyEncrypted) {
      try {
        apiKey = decryptApiKey(provider.apiKeyEncrypted);
      } catch (error) {
        return NextResponse.json(
          {
            success: false,
            error: 'Failed to decrypt API key',
            details: 'Encryption key may be misconfigured',
          },
          { status: 500 }
        );
      }
    }

    // Test connection based on provider type
    const testResult = await testProviderConnection(provider, apiKey);

    // Update tested status
    await prisma.botsAiProvider.update({
      where: { providerId: id },
      data: {
        tested: testResult.success,
        testedAt: new Date(),
      },
    });

    return NextResponse.json(testResult);
  } catch (error) {
    console.error('Error testing provider connection:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Internal server error',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * Test provider connection based on type
 */
async function testProviderConnection(
  provider: any,
  apiKey: string | null
): Promise<{ success: boolean; error?: string; details?: string }> {
  const { type, endpoint } = provider;

  try {
    switch (type) {
      // OpenAI-compatible providers: lmstudio, openai, deepseek
      // All use GET /v1/models with optional Bearer auth.
      // Store endpoint WITHOUT trailing /v1 (e.g. https://api.deepseek.com)
      case 'lmstudio':
      case 'openai':
      case 'deepseek': {
        // Fall back to OpenAI default only for the openai type
        let baseUrl = endpoint || (type === 'openai' ? 'https://api.openai.com' : null);

        if (!baseUrl) {
          return { success: false, error: 'Endpoint not configured' };
        }

        // Normalize baseUrl: remove trailing slashes and /v1 suffix
        baseUrl = baseUrl.replace(/\/+$/, ''); // Remove trailing slashes
        baseUrl = baseUrl.replace(/\/v1$/, ''); // Remove trailing /v1

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (apiKey) {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const response = await fetch(`${baseUrl}/v1/models`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(10000),
        });

        if (response.ok) {
          return { success: true };
        }

        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: `Connection failed: ${response.status}`,
          details: errorData.error?.message || response.statusText,
        };
      }

      case 'anthropic': {
        if (!apiKey) {
          return { success: false, error: 'API key required for Anthropic' };
        }

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-3-haiku-20240307',
            max_tokens: 10,
            messages: [{ role: 'user', content: 'test' }],
          }),
          signal: AbortSignal.timeout(10000),
        });

        // 2xx responses or 400 (bad request but auth worked) indicate success; 401 = bad key
        if (anthropicResponse.ok || anthropicResponse.status === 400) {
          return { success: true };
        }
        if (anthropicResponse.status === 401) {
          return { success: false, error: 'Authentication failed' };
        }

        return {
          success: false,
          error: `Unexpected response: ${anthropicResponse.status}`,
        };
      }

      case 'ultravox':
      case 'gpt-voice': {
        if (!endpoint) {
          return { success: false, error: 'Endpoint not configured' };
        }
        try {
          const headResponse = await fetch(endpoint, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          if (headResponse.ok) {
            return { success: true };
          }
          return { success: false, error: `Connection failed: ${headResponse.status}` };
        } catch {
          const voiceGetResponse = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          return { success: voiceGetResponse.ok };
        }
      }

      default: {
        if (!endpoint) {
          return { success: false, error: 'Endpoint not configured' };
        }
        try {
          const genericResponse = await fetch(endpoint, {
            method: 'HEAD',
            signal: AbortSignal.timeout(5000),
          });
          return { success: genericResponse.ok };
        } catch (error: any) {
          return {
            success: false,
            error: 'Connection failed',
            details: error.message,
          };
        }
      }
    }
  } catch (error: any) {
    return {
      success: false,
      error: 'Connection test failed',
      details: error.message || 'Unknown error',
    };
  }
}

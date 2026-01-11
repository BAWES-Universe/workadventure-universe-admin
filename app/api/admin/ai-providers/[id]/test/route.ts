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
            details: 'Encryption key may be misconfigured'
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
        details: error instanceof Error ? error.message : 'Unknown error'
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

  if (!endpoint) {
    return {
      success: false,
      error: 'Endpoint not configured',
    };
  }

  try {
    switch (type) {
      case 'lmstudio':
        // LMStudio: Simple HTTP check
        const lmResponse = await fetch(`${endpoint}/v1/models`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(5000), // 5 second timeout
        });

        if (lmResponse.ok) {
          return { success: true };
        } else {
          return {
            success: false,
            error: `Connection failed: ${lmResponse.status} ${lmResponse.statusText}`,
          };
        }

      case 'openai':
        // OpenAI: Test with models endpoint
        if (!apiKey) {
          return {
            success: false,
            error: 'API key required for OpenAI',
          };
        }

        const openaiResponse = await fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000),
        });

        if (openaiResponse.ok) {
          return { success: true };
        } else {
          const errorData = await openaiResponse.json().catch(() => ({}));
          return {
            success: false,
            error: `Connection failed: ${openaiResponse.status}`,
            details: errorData.error?.message || openaiResponse.statusText,
          };
        }

      case 'anthropic':
        // Anthropic: Test with messages endpoint (just validate auth)
        if (!apiKey) {
          return {
            success: false,
            error: 'API key required for Anthropic',
          };
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

        // 400 is expected (invalid request), but means auth worked
        if (anthropicResponse.status === 400 || anthropicResponse.status === 401) {
          if (anthropicResponse.status === 401) {
            return {
              success: false,
              error: 'Authentication failed',
            };
          }
          return { success: true }; // Auth worked, request was just invalid
        }

        return {
          success: false,
          error: `Unexpected response: ${anthropicResponse.status}`,
        };

      case 'ultravox':
      case 'gpt-voice':
        // Voice providers: Just check endpoint is reachable
        try {
          const voiceResponse = await fetch(endpoint, {
            method: 'HEAD',
            signal: AbortSignal.timeout(5000),
          });
          return { success: true };
        } catch {
          // If HEAD fails, try GET
          const voiceGetResponse = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(5000),
          });
          return { success: voiceGetResponse.ok };
        }

      default:
        // Generic: Just check if endpoint is reachable
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
  } catch (error: any) {
    return {
      success: false,
      error: 'Connection test failed',
      details: error.message || 'Unknown error',
    };
  }
}


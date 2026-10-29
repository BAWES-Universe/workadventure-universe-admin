import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey } from '@/lib/encryption';
import { chatProbeBody } from '@/lib/ai-key-kinds';

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

    // A person's personal key (#374) is checked by its owner, never from here.
    if (!provider || provider.ownerId) {
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
 * The chat address the bot server calls for a server provider, built exactly as it builds it (#703): the openai type
 * adds `/chat/completions` to the address as typed, less one trailing slash (OpenAI's own address when there is none);
 * LM Studio adds `/v1/chat/completions`, less any trailing slashes.
 */
function botChatUrl(type: string, endpoint: string | null | undefined): string | null {
  if (type === 'lmstudio') return endpoint ? `${endpoint.replace(/\/+$/, '')}/v1/chat/completions` : null;
  if (type === 'deepseek' && !endpoint) return null;
  return `${(endpoint || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
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
      // OpenAI-compatible providers: one tiny chat with the provider's model, at the address bots call (#703).
      // A model list proves neither: OpenRouter lists models for any key, and the list sits at another path.
      case 'lmstudio':
      case 'openai':
      case 'deepseek': {
        const url = botChatUrl(type, endpoint);
        if (!url) {
          return { success: false, error: 'Endpoint not configured' };
        }
        if (!provider.model) {
          return { success: false, error: 'Model not configured' };
        }

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        // The bot server sends no key to the server's own LM Studio
        if (apiKey && type !== 'lmstudio') {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
        // A server on another computer may load its model on the first call, which can take well over 30 seconds
        const timeoutMs = type === 'lmstudio' ? 120_000 : 30_000;
        const ask = (body: Record<string, unknown>) =>
          fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });

        // Bots always offer tools, so the check does too: a model that can't take them fails here as it would for bots
        let body = chatProbeBody({ protocol: 'openai' }, provider.model, { withTool: true });
        let response = await ask(body);
        // Asked again for the two refusals the bot server also asks again for: OpenAI's reasoning models take only max_completion_tokens,
        // and Alibaba's thinking models answer a non-streaming call only with thinking off
        if (response.status === 400) {
          const errorText = await response.clone().text();
          if (/max_completion_tokens/.test(errorText) && body.max_tokens !== undefined) {
            const { max_tokens: limit, ...rest } = body;
            body = { ...rest, max_completion_tokens: limit };
            response = await ask(body);
          } else if (/enable_thinking/i.test(errorText)) {
            body = { ...body, enable_thinking: false };
            response = await ask(body);
          }
        }

        if (response.ok) {
          return { success: true };
        }

        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: `Connection failed: ${response.status}`,
          details: `${errorData.error?.message || response.statusText || 'Request failed'} (POST ${url})`,
        };
      }

      case 'anthropic': {
        if (!apiKey) {
          return { success: false, error: 'API key required for Anthropic' };
        }

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/models?limit=1', {
          method: 'GET',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          signal: AbortSignal.timeout(10000),
        });

        // Check credentials without a model call or token usage.
        if (anthropicResponse.status === 200) {
          return { success: true };
        }
        if (anthropicResponse.status === 401) {
          return { success: false, error: 'Authentication failed' };
        }

        const errorData = await anthropicResponse.json().catch(() => null);
        const reason = errorData?.error?.message;
        return {
          success: false,
          error: `Unexpected response: ${anthropicResponse.status}`,
          details: (typeof reason === 'string' && reason.trim()
            ? reason.trim()
            : anthropicResponse.statusText || 'Request failed'
          ).slice(0, 200),
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

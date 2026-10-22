import type { BotsAiProvider } from '@prisma/client';

/**
 * What the bot server is given to talk to a provider: its settings and its key still encrypted (the bot server decrypts
 * it with the shared ENCRYPTION_KEY). One place, so every route that serves a provider serves exactly the same fields.
 */
export function providerPayload(provider: BotsAiProvider) {
  return {
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
    supportsVision: provider.supportsVision, // null=auto, true=force vision, false=force text-only
    visionModel: provider.visionModel,
    defaultVision: provider.defaultVision,
    settings: provider.settings || {},
  };
}

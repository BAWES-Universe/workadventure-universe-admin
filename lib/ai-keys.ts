import { prisma } from '@/lib/db';

/**
 * Personal AI keys (#374). A key is a BotsAiProvider row with an `ownerId`; the rows with none are the server's own
 * providers, which these functions never touch. Kinds are what a person picks (LM Studio, DeepSeek, ...); each one
 * is stored as a provider `type` the bot server already speaks, with its kind kept in `settings.kind`.
 */

export type AiKeyKind = 'lmstudio' | 'ollama' | 'openrouter' | 'gemini' | 'nim' | 'openai' | 'deepseek';

export interface AiKeyKindInfo {
  kind: AiKeyKind;
  label: string;
  /** On your own computer, or hosted with an API key. */
  group: 'own-computer' | 'hosted';
}

export const AI_KEY_KINDS: AiKeyKindInfo[] = [
  { kind: 'lmstudio', label: 'LM Studio', group: 'own-computer' },
  { kind: 'ollama', label: 'Ollama or llama.cpp', group: 'own-computer' },
  { kind: 'openrouter', label: 'OpenRouter', group: 'hosted' },
  { kind: 'gemini', label: 'Gemini', group: 'hosted' },
  { kind: 'nim', label: 'NVIDIA NIM', group: 'hosted' },
  { kind: 'openai', label: 'OpenAI', group: 'hosted' },
  { kind: 'deepseek', label: 'DeepSeek', group: 'hosted' },
];

export function kindInfo(kind: unknown): AiKeyKindInfo | null {
  return AI_KEY_KINDS.find((entry) => entry.kind === kind) ?? null;
}

/** What the AI keys page shows for one key. Never holds the key, encrypted or not. */
export interface AiKeySummary {
  id: string;
  name: string;
  kind: AiKeyKind | null;
  kindLabel: string;
  model: string | null;
  /** The host of an own-computer key's address, e.g. "lm.example.com"; null for a hosted key. */
  address: string | null;
  /** The last four characters of a hosted key. */
  last4: string | null;
  month: { replies: number; tokens: number };
  createdAt: string;
}

function hostOf(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

export function startOfMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The caller's own keys, oldest first, each with what it spent this month. */
export async function listAiKeys(ownerId: string): Promise<AiKeySummary[]> {
  const rows = await prisma.botsAiProvider.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'asc' },
    select: { providerId: true, name: true, model: true, endpoint: true, apiKeyLast4: true, settings: true, createdAt: true },
  });
  if (rows.length === 0) return [];
  const usage = await prisma.botsAiUsage.groupBy({
    by: ['providerId'],
    where: { providerId: { in: rows.map((row) => row.providerId) }, error: false, timestamp: { gte: startOfMonth() } },
    _sum: { apiCalls: true, tokensUsed: true },
  });
  const spent = new Map(usage.map((entry) => [entry.providerId, entry._sum]));
  return rows.map((row) => {
    const settings = (row.settings ?? {}) as { kind?: unknown };
    const info = kindInfo(settings.kind);
    const sum = spent.get(row.providerId);
    return {
      id: row.providerId,
      name: row.name,
      kind: info?.kind ?? null,
      kindLabel: info?.label ?? 'AI',
      model: row.model,
      address: info?.group === 'own-computer' ? hostOf(row.endpoint) : null,
      last4: row.apiKeyLast4,
      month: { replies: Number(sum?.apiCalls ?? 0), tokens: Number(sum?.tokensUsed ?? 0) },
      createdAt: row.createdAt.toISOString(),
    };
  });
}

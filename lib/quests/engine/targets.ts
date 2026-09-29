import type { QuestDb } from './db';
import { scopesOf, type ScopeChain } from './scope';

/** What an objective is about. Null means any subject. */
export type ObjectiveTarget = { kind: 'entity'; id: string } | { kind: 'role'; role: 'host' };

export type ResolvedHost = { kind: 'bot' | 'area'; id: string };

export function parseTarget(raw: unknown): ObjectiveTarget | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind === 'entity' && typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 128) {
    return { kind: 'entity', id: record.id };
  }
  if (record.kind === 'role' && record.role === 'host') return { kind: 'role', role: 'host' };
  return null;
}

/** The game names a bot `bot-<id>` (lib/bot-visitor.ts); a subject may carry either form. */
export function subjectNamesBot(subject: string | null, botId: string): boolean {
  return subject === botId || subject === `bot-${botId}`;
}

/**
 * Who plays the host here for this quest: a binding for the quest itself beats the scope's general one, and the room's
 * beats the world's beats the universe's. Null when nobody is bound.
 */
export async function resolveHost(db: QuestDb, chain: ScopeChain, questKey: string): Promise<ResolvedHost | null> {
  const scopes = scopesOf(chain).filter((scope) => scope.scopeId !== '');
  if (!scopes.length) return null;
  const bindings = await db.questHostBinding.findMany({
    where: {
      OR: scopes.map((scope) => ({ scopeType: scope.scopeType, scopeId: scope.scopeId })),
      AND: [{ questKey: { in: [questKey, ''] } }],
    },
    select: { scopeType: true, scopeId: true, questKey: true, hostKind: true, hostId: true },
  });
  for (const scope of scopes) {
    const here = bindings.filter((binding) => binding.scopeType === scope.scopeType && binding.scopeId === scope.scopeId);
    const binding = here.find((candidate) => candidate.questKey === questKey) ?? here.find((candidate) => candidate.questKey === '');
    if (binding && (binding.hostKind === 'bot' || binding.hostKind === 'area')) return { kind: binding.hostKind, id: binding.hostId };
  }
  return null;
}

/**
 * Whether a target can still be met: a bound host that exists and, for a bot, is enabled. An area is trusted to be
 * there (the map is not read here). An entity target names a bot when a bot has that id; anything else is trusted.
 */
export async function targetAvailable(db: QuestDb, target: ObjectiveTarget | null, host: ResolvedHost | null): Promise<boolean> {
  if (target === null) return true;
  if (target.kind === 'role') {
    if (!host) return false;
    if (host.kind === 'area') return true;
    const bot = await db.bot.findUnique({ where: { id: host.id }, select: { enabled: true } });
    return !!bot && bot.enabled;
  }
  const bot = await db.bot.findUnique({ where: { id: target.id }, select: { enabled: true } });
  return bot ? bot.enabled : true;
}

/** Whether an observation's subject is what the objective asks for. */
export function targetMatches(target: ObjectiveTarget | null, subject: string | null, host: ResolvedHost | null): boolean {
  if (target === null) return true;
  if (target.kind === 'entity') return subject !== null && (subject === target.id || subjectNamesBot(subject, target.id));
  if (!host || subject === null) return false;
  return host.kind === 'bot' ? subjectNamesBot(subject, host.id) : subject === host.id;
}

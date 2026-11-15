import { getAdapter } from '@/lib/app-adapter';
import { appKeyOf, brickApps } from '@/lib/instant/asker';
import { instantFundsAreWired } from '@/lib/instant/funds';
import { getInstantLimits, getInstantPause } from '@/lib/instant/state';
import { instantCatalog, missingInstantLimits } from '@/lib/instant/values';

/**
 * What a Brick may be offered: only Apps its owner switched on for it, only tools in the trusted table, only while Instant can really run (limits set, not paused, the
 * credit books wired, the provider adapter on), and only those whose simplest run fits "the most one run may cost". A tool with no
 * enforceable top price is never in the list. Each carries Composio's own input schema (the key never leaves Orbit, so the bot
 * server cannot ask for it), kept for an hour.
 */

const SCHEMA_TTL_MS = 60 * 60 * 1000;
const schemas = new Map<string, { at: number; description: string | null; inputSchema: unknown }>();

export interface OfferedTool {
  name: string;
  toolkit: string;
  description: string | null;
  inputSchema: unknown;
  /** The least one run costs the person (before any markup), in micros. For the Brick's own judgement ("this is a small run"), never a bound. */
  fromMicros: number;
}

export async function offeredInstantTools(botId: string | null): Promise<{ ready: boolean; reason: string | null; tools: OfferedTool[] }> {
  const instant = getAdapter()?.instant;
  if (!instant) return { ready: false, reason: 'off', tools: [] };
  if (!instantFundsAreWired()) return { ready: false, reason: 'no_credit', tools: [] };
  const limits = await getInstantLimits();
  if (missingInstantLimits(limits).length > 0) return { ready: false, reason: 'not_set', tools: [] };
  if ((await getInstantPause()).paused) return { ready: false, reason: 'paused', tools: [] };
  // Only the Apps this Brick's owner switched on for this Brick: none by default, so a Brick can rely on the model alone
  const apps = botId ? await brickApps(botId) : new Set<string>();
  const tools: OfferedTool[] = [];
  for (const row of instantCatalog()) {
    if (!apps.has(appKeyOf(row.toolkit))) continue;
    if (row.fromMicros > (limits.maxRunMicros ?? 0)) continue;
    let known = schemas.get(row.tool);
    if (!known || Date.now() - known.at > SCHEMA_TTL_MS) {
      try {
        const live = await instant.tool(row.tool);
        // Composio does not serve it as Instant (any more): not offered
        if (!live || !live.instantSupported) continue;
        known = { at: Date.now(), description: live.description, inputSchema: live.inputSchema };
        schemas.set(row.tool, known);
      } catch (error) {
        console.error('[Instant] Could not read a tool:', error instanceof Error ? error.message : 'unknown');
        continue;
      }
    }
    tools.push({ name: row.tool, toolkit: row.toolkit, description: known.description, inputSchema: known.inputSchema, fromMicros: row.fromMicros });
  }
  return { ready: true, reason: null, tools };
}

/** For tests. */
export function forgetToolSchemas(): void {
  schemas.clear();
}

import { getAdapter } from '@/lib/app-adapter';
import { appKeyOf, brickApps } from '@/lib/instant/asker';
import { instantFundsAreWired } from '@/lib/instant/funds';
import { getInstantLimits, getInstantPause } from '@/lib/instant/state';
import { instantAllowedArguments, instantCatalog, missingInstantLimits } from '@/lib/instant/values';

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

/** Composio's input schema cut to the arguments a run may carry at its priced unit, so a Brick is never invited to ask for what would be refused. */
export function cutSchema(tool: string, schema: unknown): unknown {
  const allowed = instantAllowedArguments(tool);
  if (!allowed || typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const source = schema as Record<string, unknown>;
  const properties = typeof source.properties === 'object' && source.properties !== null ? (source.properties as Record<string, unknown>) : {};
  // What admission accepts is laid over what the provider says for each kept argument, so the two are both held: the provider's own type and
  // its other limits stay, and the admission's own (most results, only the basic search, a list that is not empty) are added
  const kept = Object.fromEntries(
    Object.entries(properties)
      .filter(([name]) => allowed.names.includes(name))
      .map(([name, own]) => [name, allowed.constraints[name] ? tighten(own, allowed.constraints[name]) : own]),
  );
  const cut: Record<string, unknown> = { ...source, properties: kept, required: allowed.required.filter((name) => name in kept) };
  // Exa's contents needs pages from one of its two lists, even where the provider words them as optional
  const lists = (allowed.anyOf ?? []).filter((names) => names.every((name) => name in kept)).map((names) => ({ required: names }));
  // Laid beside whatever the provider already says (allOf), never over it
  if (lists.length > 0) cut.allOf = [...(Array.isArray(source.allOf) ? source.allOf : []), { anyOf: lists }];
  return cut;
}

/**
 * The provider's schema for one argument with admission's limits laid over it: the numbers meet in the middle (the larger minimum, the smaller
 * maximum), a list of allowed words is cut to the ones both allow, and everything else of the provider's (its type, its description) stays.
 */
function tighten(own: unknown, limit: Record<string, unknown>): unknown {
  const base = typeof own === 'object' && own !== null && !Array.isArray(own) ? { ...(own as Record<string, unknown>) } : {};
  const merged: Record<string, unknown> = { ...base, ...limit };
  for (const [key, pick] of [['minimum', Math.max], ['minItems', Math.max], ['minLength', Math.max], ['maximum', Math.min], ['maxItems', Math.min], ['maxLength', Math.min]] as const) {
    if (typeof base[key] === 'number' && typeof limit[key] === 'number') merged[key] = pick(base[key] as number, limit[key] as number);
  }
  if (Array.isArray(base.enum) && Array.isArray(limit.enum)) {
    const both = (limit.enum as unknown[]).filter((value) => (base.enum as unknown[]).includes(value));
    merged.enum = both.length > 0 ? both : limit.enum;
  }
  // The provider's own description of the argument is kept; the limits are only added to it
  if (typeof base.description === 'string') merged.description = base.description;
  return merged;
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
        known = { at: Date.now(), description: live.description, inputSchema: cutSchema(row.tool, live.inputSchema) };
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
